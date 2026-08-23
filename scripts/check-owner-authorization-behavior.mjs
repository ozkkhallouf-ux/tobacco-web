import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const edgeSource = (relativePath) => {
  let source = fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  source = source
    .replace(/^import\s+[^;]+;\s*/u, "")
    .replace(/:\s*Record<string,\s*unknown>/gu, "")
    .replace(/:\s*(?:RequestInit|Request|number|string|unknown)\b/gu, "")
    .replace(/\s+as\s+Record<string,\s*unknown>/gu, "");
  assert(!/:\s*(?:RequestInit|Request|number|string|unknown)\b/u.test(source), `${relativePath} contains unsupported TypeScript syntax in the local harness`);
  return source;
};

const jwt = (name, sessionId = `session-${name}`) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: name, session_id: sessionId })}.local-test-signature`;
};

const OWNER_TOKEN = jwt("owner");
const EMPLOYEE_TOKEN = jwt("employee");
const EXPIRED_TOKEN = jwt("expired");
const INVALID_TOKEN = "invalid.local.token";

function executeEdge(relativePath, globals) {
  let handler = null;
  const context = vm.createContext({
    ...globals,
    Request,
    Response,
    Headers,
    URL,
    TextEncoder,
    crypto: globalThis.crypto,
    atob,
    console,
    setTimeout,
    clearTimeout,
    Deno: {
      env: { get: (name) => globals.env?.[name] || "" },
      serve: (candidate) => { handler = candidate; }
    }
  });
  vm.runInContext(edgeSource(relativePath), context, { filename: relativePath });
  assert.equal(typeof handler, "function", `${relativePath} did not register an HTTP handler`);
  return handler;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

function brokerHarness() {
  const metrics = {
    authVerifications: 0,
    requestCreations: 0,
    downstreamCalls: 0,
    createdRows: []
  };
  const verifiedUsers = new Map([
    [OWNER_TOKEN, { id: "server-owner-id", email: "ozkkhallouf@gmail.com" }],
    [EMPLOYEE_TOKEN, { id: "server-employee-id", email: "employee@ozktobacco.test" }]
  ]);
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers || {});
    if (url.endsWith("/auth/v1/user")) {
      metrics.authVerifications += 1;
      const token = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (token === EXPIRED_TOKEN || token === INVALID_TOKEN || !verifiedUsers.has(token)) return jsonResponse(401, { error: "invalid_token" });
      return jsonResponse(200, verifiedUsers.get(token));
    }
    if (url.includes("/rest/v1/ameen_read_requests")) {
      metrics.downstreamCalls += 1;
      if (String(init.method || "GET").toUpperCase() === "POST") {
        metrics.requestCreations += 1;
        metrics.createdRows.push(JSON.parse(String(init.body || "{}")));
        return jsonResponse(201, [{ id: `request-${metrics.requestCreations}` }]);
      }
      throw new Error(`Unexpected broker downstream method: ${init.method || "GET"}`);
    }
    throw new Error(`Unexpected broker fetch: ${url}`);
  };
  const handler = executeEdge("supabase/functions/ameen-read-broker/index.ts", {
    fetch,
    env: {
      SUPABASE_URL: "https://local-auth.test",
      SUPABASE_SERVICE_ROLE_KEY: "local-service-role-stub"
    }
  });
  return {
    metrics,
    async request(token, body) {
      const headers = { "content-type": "application/json", origin: "http://localhost:5173" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await handler(new Request("https://local-edge.test/ameen-read-broker", {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }));
      return { status: response.status, body: await response.json() };
    }
  };
}

function inventoryHarness({ liveOwnerSession = true } = {}) {
  const metrics = { getUserCalls: 0, sessionChecks: 0, accountQueries: 0 };
  const verifiedUsers = new Map([
    [OWNER_TOKEN, { id: "server-owner-id", email: "ozkkhallouf@gmail.com", app_metadata: { role: "owner" } }],
    [EMPLOYEE_TOKEN, { id: "server-employee-id", email: "employee@ozktobacco.test", app_metadata: { role: "employee" } }]
  ]);
  const admin = {
    auth: {
      async getUser(token) {
        metrics.getUserCalls += 1;
        if (token === EXPIRED_TOKEN || token === INVALID_TOKEN || !verifiedUsers.has(token)) return { data: { user: null }, error: new Error("invalid_token") };
        return { data: { user: verifiedUsers.get(token) }, error: null };
      },
      admin: {}
    },
    async rpc(name, args) {
      assert.equal(name, "smart_inventory_has_session_for_service", `Unexpected authorization RPC: ${name}`);
      metrics.sessionChecks += 1;
      const live = args.p_user_id === "server-owner-id" && liveOwnerSession;
      return { data: live, error: null };
    },
    from(table) {
      assert.equal(table, "inventory_counter_accounts", `Unexpected owner table: ${table}`);
      return {
        select() {
          return {
            async order() {
              metrics.accountQueries += 1;
              return { data: [{ user_id: "counter-1", display_name: "Counter" }], error: null };
            }
          };
        }
      };
    }
  };
  const handler = executeEdge("supabase/functions/inventory-auth/index.ts", {
    createClient: () => admin,
    fetch: async (input) => { throw new Error(`Unexpected inventory fetch: ${String(input)}`); },
    env: {
      SUPABASE_URL: "https://local-auth.test",
      SUPABASE_SERVICE_ROLE_KEY: "local-service-role-stub",
      SUPABASE_ANON_KEY: "local-publishable-stub"
    }
  });
  return {
    metrics,
    async listAccounts(token, extraBody = {}) {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await handler(new Request("https://local-edge.test/inventory-auth", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "list_accounts", ...extraBody })
      }));
      return { status: response.status, body: await response.json() };
    }
  };
}

function assertNoUnauthorizedBrokerSideEffect(harness, label) {
  assert.equal(harness.metrics.requestCreations, 0, `${label} created an Ameen broker request`);
  assert.equal(harness.metrics.downstreamCalls, 0, `${label} reached broker data/downstream execution`);
}

async function rejectedBrokerCase(label, token, body, expectedStatus, expectedAuthVerifications) {
  const harness = brokerHarness();
  const result = await harness.request(token, body);
  assert.equal(result.status, expectedStatus, `${label} returned the wrong status`);
  assert.equal(harness.metrics.authVerifications, expectedAuthVerifications, `${label} did not follow the server-side Auth verification contract`);
  assertNoUnauthorizedBrokerSideEffect(harness, label);
}

async function rejectedInventoryCase(label, token, extraBody = {}, expectedGetUserCalls = token ? 1 : 0) {
  const harness = inventoryHarness();
  const result = await harness.listAccounts(token, extraBody);
  assert.equal(result.status, 403, `${label} bypassed inventory owner authorization`);
  assert.equal(harness.metrics.getUserCalls, expectedGetUserCalls, `${label} did not follow the server-side getUser contract`);
  assert.equal(harness.metrics.accountQueries, 0, `${label} reached an owner-only inventory query`);
}

// A: a server-verified owner is allowed by both authorization boundaries.
{
  const broker = brokerHarness();
  const result = await broker.request(OWNER_TOKEN, { action: "request", resource: "health" });
  assert.equal(result.status, 200);
  assert.equal(broker.metrics.authVerifications, 1);
  assert.equal(broker.metrics.requestCreations, 1);

  const inventory = inventoryHarness();
  const accounts = await inventory.listAccounts(OWNER_TOKEN);
  assert.equal(accounts.status, 200);
  assert.equal(inventory.metrics.getUserCalls, 1);
  assert.equal(inventory.metrics.accountQueries, 1);
  assert.equal(inventory.metrics.sessionChecks, 1);
}

// B-E/I: rejected identities cannot create a broker request or reach owner data.
await rejectedBrokerCase("employee", EMPLOYEE_TOKEN, { action: "request", resource: "stock" }, 403, 1);
await rejectedBrokerCase("anonymous", null, { action: "request", resource: "stock" }, 401, 0);
await rejectedBrokerCase("expired token", EXPIRED_TOKEN, { action: "request", resource: "stock" }, 401, 1);
await rejectedBrokerCase("invalid token", INVALID_TOKEN, { action: "request", resource: "stock" }, 401, 1);
await rejectedBrokerCase("forged client identity", EMPLOYEE_TOKEN, {
  action: "request",
  resource: "stock",
  owner: true,
  role: "owner",
  email: "ozkkhallouf@gmail.com",
  uid: "server-owner-id",
  requested_by: "server-owner-id",
  app_metadata: { role: "owner" }
}, 403, 1);

await rejectedInventoryCase("inventory employee", EMPLOYEE_TOKEN);
await rejectedInventoryCase("inventory anonymous", null);
await rejectedInventoryCase("inventory expired token", EXPIRED_TOKEN);
await rejectedInventoryCase("inventory invalid token", INVALID_TOKEN);
await rejectedInventoryCase("inventory forged client identity", EMPLOYEE_TOKEN, {
  owner: true,
  role: "owner",
  email: "ozkkhallouf@gmail.com",
  uid: "server-owner-id",
  app_metadata: { role: "owner" }
});

// A revoked owner session also fails closed before the owner-only query.
{
  const inventory = inventoryHarness({ liveOwnerSession: false });
  const result = await inventory.listAccounts(OWNER_TOKEN);
  assert.equal(result.status, 403);
  assert.equal(inventory.metrics.getUserCalls, 1);
  assert.equal(inventory.metrics.sessionChecks, 1);
  assert.equal(inventory.metrics.accountQueries, 0);
}

// F: an authorized stock request creates only the expected read-request row.
{
  const broker = brokerHarness();
  const result = await broker.request(OWNER_TOKEN, {
    action: "request",
    resource: "stock",
    owner: false,
    requested_by: "forged-client-id"
  });
  assert.equal(result.status, 200);
  assert.equal(broker.metrics.authVerifications, 1);
  assert.equal(broker.metrics.requestCreations, 1);
  assert.equal(broker.metrics.downstreamCalls, 1);
  assert.deepEqual(broker.metrics.createdRows, [{ requested_by: "server-owner-id", resource: "stock" }]);
}

console.log("Ameen Live and inventory owner authorization behavioral contract (A-F/I): OK");
