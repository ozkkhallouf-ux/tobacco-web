import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUBLISHABLE_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
const DEVICE_PEPPER = Deno.env.get("INVENTORY_DEVICE_PEPPER") || "inventory-device-v1";
const INTERNAL_DOMAIN = Deno.env.get("INVENTORY_INTERNAL_AUTH_DOMAIN") || "accounts.ozktobacco.com";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store"
};

function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });
}

function normalizeUsername(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ar")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function validPassword(value: unknown) {
  const password = String(value || "");
  return password.length >= 8 && password.length <= 128;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request) {
  const header = req.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

async function requireOwner(req: Request) {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user || String(data.user.app_metadata?.role || "").toLowerCase() !== "owner") return null;
  const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
  const sessionId = String(claims.session_id || "");
  if (!sessionId) return null;
  const { data: live, error: liveError } = await admin.rpc("smart_inventory_has_session_for_service", { p_session_id: sessionId, p_user_id: data.user.id });
  if (liveError || live !== true) return null;
  return data.user;
}

async function login(req: Request, body: Record<string, unknown>) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const deviceId = String(body.deviceId || "").slice(0, 160);
  if (!username || !password) return reply(400, { error: "credentials_required" });

  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const deviceHash = deviceId ? await sha256(`${DEVICE_PEPPER}:${deviceId}`) : "";
  const keyHash = await sha256(`${DEVICE_PEPPER}:${forwarded}:${username}`);
  const { data: gate, error: gateError } = await admin.rpc("smart_inventory_auth_preflight", {
    p_key_hash: keyHash,
    p_username: username
  });
  if (gateError) return reply(503, { error: "login_unavailable" });
  if (!gate?.allowed || !gate?.userId) {
    await admin.rpc("smart_inventory_auth_record", { p_key_hash: keyHash, p_username: username, p_success: false });
    return reply(401, { error: "invalid_or_locked" });
  }
  if (gate.deviceLockEnabled && (!deviceHash || gate.registeredDeviceHash !== deviceHash)) {
    await admin.rpc("smart_inventory_auth_record", { p_key_hash: keyHash, p_username: username, p_success: false });
    return reply(403, { error: "device_not_allowed" });
  }

  const { data: account } = await admin.from("inventory_counter_accounts")
    .select("user_id, auth_email, enabled")
    .eq("username_normalized", username).maybeSingle();
  if (!account?.enabled || !account.auth_email) return reply(401, { error: "invalid_or_locked" });

  const tokenResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: account.auth_email, password })
  });
  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token || !tokenPayload.refresh_token) {
    await admin.rpc("smart_inventory_auth_record", { p_key_hash: keyHash, p_username: username, p_success: false });
    return reply(tokenResponse.status === 429 ? 429 : 401, { error: "invalid_or_locked" });
  }
  await admin.rpc("smart_inventory_auth_record", { p_key_hash: keyHash, p_username: username, p_success: true });
  await admin.from("smart_inventory_audit_log").insert({
    action: "counter_login", actor_user_id: account.user_id, actor_display_name: username,
    after_data: { deviceHash: deviceHash || null }
  });
  // Never return the synthetic Auth email or the Auth user object.
  return reply(200, { accessToken: tokenPayload.access_token, refreshToken: tokenPayload.refresh_token });
}

async function listAccounts(req: Request) {
  if (!await requireOwner(req)) return reply(403, { error: "owner_only" });
  const { data, error } = await admin.from("inventory_counter_accounts")
    .select("user_id, username_display, display_name, enabled, locked_until, device_lock_enabled, created_at, updated_at")
    .order("display_name");
  if (error) return reply(500, { error: "accounts_unavailable" });
  return reply(200, { accounts: data || [] });
}

async function createAccount(req: Request, body: Record<string, unknown>) {
  const owner = await requireOwner(req);
  if (!owner) return reply(403, { error: "owner_only" });
  const usernameDisplay = String(body.username || "").normalize("NFKC").trim().slice(0, 48);
  const username = normalizeUsername(usernameDisplay);
  const displayName = String(body.displayName || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 80);
  const password = String(body.password || "");
  if (username.length < 2 || displayName.length < 2 || !validPassword(password)) return reply(400, { error: "invalid_account_input" });
  const { data: duplicate } = await admin.from("inventory_counter_accounts").select("user_id").eq("username_normalized", username).maybeSingle();
  if (duplicate) return reply(409, { error: "username_taken" });

  const authEmail = `inventory-${crypto.randomUUID()}@${INTERNAL_DOMAIN}`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: true,
    app_metadata: { role: "inventory_counter", username, display_name: displayName, account_enabled: true }
  });
  if (createError || !created.user) return reply(400, { error: createError?.message?.toLowerCase().includes("password") ? "weak_password" : "account_create_failed" });
  const userId = created.user.id;
  const { error: insertError } = await admin.from("inventory_counter_accounts").insert({
    user_id: userId, username_normalized: username, username_display: usernameDisplay,
    display_name: displayName, auth_email: authEmail, enabled: true, created_by: owner.id
  });
  if (insertError) {
    await admin.auth.admin.deleteUser(userId);
    return reply(insertError.code === "23505" ? 409 : 500, { error: insertError.code === "23505" ? "username_taken" : "account_create_failed" });
  }
  const { error: roleError } = await admin.rpc("smart_inventory_set_counter_auth_role", { p_user_id: userId });
  if (roleError) {
    await admin.from("inventory_counter_accounts").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
    return reply(500, { error: "account_create_failed" });
  }
  await admin.from("smart_inventory_audit_log").insert({ action: "counter_account_created", actor_user_id: owner.id,
    actor_display_name: String(owner.app_metadata?.display_name || "المالك"), after_data: { userId, username, displayName } });
  return reply(201, { account: { userId, username: usernameDisplay, displayName, enabled: true } });
}

async function mutateAccount(req: Request, body: Record<string, unknown>, action: string) {
  const owner = await requireOwner(req);
  if (!owner) return reply(403, { error: "owner_only" });
  const userId = String(body.userId || "");
  const { data: account } = await admin.from("inventory_counter_accounts").select("user_id, username_normalized, display_name, enabled").eq("user_id", userId).maybeSingle();
  if (!account) return reply(404, { error: "account_not_found" });
  if (action === "reset_password") {
    if (!validPassword(body.password)) return reply(400, { error: "invalid_password" });
    const { error } = await admin.auth.admin.updateUserById(userId, { password: String(body.password) });
    if (error) return reply(400, { error: "password_reset_failed" });
    await admin.from("inventory_counter_accounts").update({ credential_version: Date.now(), updated_at: new Date().toISOString() }).eq("user_id", userId);
  } else if (action === "disable") {
    await admin.from("inventory_counter_accounts").update({ enabled: false, disabled_at: new Date().toISOString(), disabled_by: owner.id, updated_at: new Date().toISOString() }).eq("user_id", userId);
    await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h", app_metadata: { role: "inventory_counter", username: account.username_normalized, display_name: account.display_name, account_enabled: false } });
  } else if (action === "enable") {
    await admin.auth.admin.updateUserById(userId, { ban_duration: "none", app_metadata: { role: "inventory_counter", username: account.username_normalized, display_name: account.display_name, account_enabled: true } });
    await admin.from("inventory_counter_accounts").update({ enabled: true, failed_attempts: 0, locked_until: null, disabled_at: null, disabled_by: null, updated_at: new Date().toISOString() }).eq("user_id", userId);
    const { error: roleError } = await admin.rpc("smart_inventory_set_counter_auth_role", { p_user_id: userId });
    if (roleError) return reply(500, { error: "account_update_failed" });
  } else if (action === "register_device") {
    const deviceId = String(body.deviceId || "").slice(0, 160);
    if (!deviceId) return reply(400, { error: "device_required" });
    await admin.from("inventory_counter_accounts").update({ device_lock_enabled: true, registered_device_hash: await sha256(`${DEVICE_PEPPER}:${deviceId}`), updated_at: new Date().toISOString() }).eq("user_id", userId);
  } else if (action === "clear_device") {
    await admin.from("inventory_counter_accounts").update({ device_lock_enabled: false, registered_device_hash: null, updated_at: new Date().toISOString() }).eq("user_id", userId);
  }
  if (["reset_password", "disable"].includes(action)) await admin.rpc("smart_inventory_revoke_user_sessions", { p_user_id: userId });
  await admin.from("smart_inventory_audit_log").insert({ action: `counter_account_${action}`, actor_user_id: owner.id,
    actor_display_name: String(owner.app_metadata?.display_name || "المالك"), after_data: { userId }, reason: String(body.reason || "") || null });
  return reply(200, { ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST" || !SUPABASE_URL || !SERVICE_ROLE_KEY || !PUBLISHABLE_KEY) return reply(503, { error: "unavailable" });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  if (action === "login") return login(req, body);
  if (action === "list_accounts") return listAccounts(req);
  if (action === "create_account") return createAccount(req, body);
  if (["reset_password", "disable", "enable", "register_device", "clear_device"].includes(action)) return mutateAccount(req, body, action);
  return reply(400, { error: "unknown_action" });
});
