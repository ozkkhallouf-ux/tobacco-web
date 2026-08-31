import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

const required = [
  "index.html",
  "src/app.js",
  "src/price-list-template.js",
  "src/config.js",
  "src/supabase-client.js",
  "src/smart-inventory.js",
  "src/number-normalizer.js",
  "src/styles.css",
  "public/manifest.webmanifest",
  "public/service-worker.js",
  "public/downloads/price-list-usd.html",
  "public/downloads/price-list-usd.pdf",
  "public/downloads/price-list-usd-light.pdf",
  "public/downloads/price-list-syp-14050.html",
  "public/downloads/price-list-syp-14050.pdf",
  "public/downloads/price-list-syp-14050-light.pdf",
  "public/downloads/price-list-wazari-usd.html",
  "public/downloads/price-list-wazari-usd.pdf",
  "public/downloads/price-list-wazari-usd-light.pdf",
  "public/downloads/price-list-wazari-syp-14050.html",
  "public/downloads/price-list-wazari-syp-14050.pdf",
  "public/downloads/price-list-wazari-syp-14050-light.pdf",
  "public/downloads/index.html",
  "AI_WORK_SYNC.md",
  "AI_HANDOFF.md",
  "AI_ACTIVE_TASK.json",
  "docs/ai/README.md",
  "docs/ai/project-map.md",
  "docs/ai/impact-map.md",
  "docs/ai/task-contract.md",
  "docs/ai/topics/README.md",
  "docs/ai/topics/sales.md",
  "docs/ai/topics/price-bulletins.md",
  "docs/ai/topics/inventory.md",
  "docs/ai/topics/customer-balances.md",
  "docs/ai/topics/purchases-suppliers.md",
  "docs/ai/topics/ameen-sync.md",
  "docs/ai/topics/printing.md",
  "docs/ai/topics/notifications-deployment.md",
  "docs/ai/topics/icloud-archive.md",
  "src/icloud-archive.js",
  "tools/mac-archive-bridge/server.mjs",
  "tools/mac-archive-bridge/install-launch-agent.sh",
  "scripts/check-mac-archive-bridge.mjs",
  "scripts/check-local-site-server.mjs",
  "scripts/check-invoice-document-integrity.mjs",
  "supabase/functions/financial-assistant/index.ts",
  "supabase/functions/inventory-auth/index.ts",
  "supabase/smart-inventory.sql",
  "supabase/tests/smart-inventory-security.sql",
  "scripts/check-smart-inventory.mjs",
  "supabase/ameen-account-balance-reports.sql",
  "tools/push-ameen-account-balances.ps1",
  "tools/register-account-balances-task.ps1",
  "supabase/project-task-health-monitor.sql",
  "scripts/check-project-task-monitors.mjs",
  "supabase/tests/cron-job-health-truth-table.sql",
  "scripts/check-cron-job-health-classifier.mjs"
];

let failed = false;

for (const file of required) {
  if (!existsSync(file)) {
    console.error(`Missing: ${file}`);
    failed = true;
  }
}

// The project knowledge index is a maintained contract, not optional prose.
// Keeping it in the main check prevents future sessions from silently losing
// the topic map or bypassing it when repository instructions are edited.
{
  const agents = readFileSync("AGENTS.md", "utf8");
  const workSync = readFileSync("AI_WORK_SYNC.md", "utf8");
  const knowledgeIndex = readFileSync("docs/ai/README.md", "utf8");
  const topicIndex = readFileSync("docs/ai/topics/README.md", "utf8");
  const topicFiles = [
    "sales.md",
    "price-bulletins.md",
    "inventory.md",
    "customer-balances.md",
    "purchases-suppliers.md",
    "ameen-sync.md",
    "printing.md",
    "notifications-deployment.md"
  ];

  if (!agents.includes("docs/ai/README.md") || !workSync.includes("docs/ai/README.md")) {
    console.error("Repository instructions must require the shared project knowledge index.");
    failed = true;
  }
  for (const file of topicFiles) {
    if (!knowledgeIndex.includes(`topics/${file}`) || !topicIndex.includes(file)) {
      console.error(`Project knowledge indexes are missing topic: ${file}`);
      failed = true;
    }
    const source = readFileSync(`docs/ai/topics/${file}`, "utf8");
    for (const heading of ["## الحالة الحالية", "## المصدر الموثوق", "## نطاق الملفات", "## قيود ثابتة", "## فحوص إلزامية", "## الخطوة التالية"]) {
      if (!source.includes(heading)) {
        console.error(`Topic report ${file} is missing required section: ${heading}`);
        failed = true;
      }
    }
  }
}

// Coordination files are shared through Git. Normalize line endings before
// writing so Windows PowerShell does not turn every JSON/Markdown line into a
// trailing-whitespace warning for other environments or future diffs.
{
  const coordinationSource = readFileSync("tools/ai-work-coordination.ps1", "utf8");
  for (const contract of [
    '$Content.Replace("`r`n", "`n").Replace("`r", "`n")',
    "WriteAllText($Path, $normalizedContent"
  ]) {
    if (!coordinationSource.includes(contract)) {
      console.error(`AI work coordination line-ending contract is missing: ${contract}`);
      failed = true;
    }
  }
}

// Ameen Live must remain a browser-triggered, read-only inventory overlay.
{
  const snapshotSource = readFileSync("src/business-snapshot.js", "utf8");
  const commandSource = readFileSync("src/command-center.js", "utf8");
  const liveClientSource = readFileSync("src/ameen-live-client.js", "utf8");
  const gatewaySource = readFileSync("tools/ameen-read-gateway.ps1", "utf8");
  const now = new Date().toISOString();
  const context = vm.createContext({
    window: {
      ozkAmeenLiveCache: {
        updatedAt: now,
        stock: { asOf: now, rowCount: 2, rows: [
          { item_number: "1", item_guid: "11111111-1111-4111-8111-111111111111", item_name: "نفد فعلي", stock_qty: 0, stock_qty_net: 0, stock_qty_positive: 0, group_name: null, unit1_name: "علبة", unit2_name: "كرتونة", unit2_factor: 10 },
          { item_number: "2", item_guid: "22222222-2222-4222-8222-222222222222", item_name: "متوفر", stock_qty: 7, stock_qty_net: 7, stock_qty_positive: 7, group_name: null, unit1_name: "علبة", unit2_name: "كرتونة", unit2_factor: 10 }
        ] },
        customers: { asOf: now, rowCount: 293, rows: [{ customer_name: "مرجع" }] }
      }
    },
    console, Date, Number, String, Math, Object, Array, Map, Promise, setTimeout, clearTimeout
  });
  vm.runInContext(snapshotSource, context);
  const liveSnapshot = await context.window.ozkBusinessOS.getSnapshot();
  if (liveSnapshot.inventory.meta.source !== "ameen_live.stock" || liveSnapshot.inventory.itemCount !== 2 || liveSnapshot.inventory.outOfStockCount !== 1) {
    console.error("Business Snapshot must prefer a fresh Ameen Live stock response and calculate counts from its actual rows.");
    failed = true;
  }
  if (liveSnapshot.customerReference.customerCount !== 293 || liveSnapshot.receivables.meta.source === "ameen_live.customers") {
    console.error("Ameen Live customers must remain reference-only and must not replace the trusted receivables source.");
    failed = true;
  }
  for (const contract of ["بحاجة مراجعة شراء", "friendlyAmeenError", "readAmeenLiveResources", "Promise.allSettled", "آخر قراءة حية", "الأمين مباشر: متصل"]) {
    if (!commandSource.includes(contract)) {
      console.error(`Command Center Ameen Live contract is missing: ${contract}`);
      failed = true;
    }
  }
  if (commandSource.includes("Promise.all([window.ozkAmeenLive.health()")) {
    console.error("Command Center Ameen Live resources must not share a fail-fast Promise.all.");
    failed = true;
  }
  for (const contract of [
    'const RESOURCES=new Set(["health","stock","customers"])',
    "const AMEEN_REQUEST_TIMEOUT_MS=60000",
    "timeoutMs=AMEEN_REQUEST_TIMEOUT_MS",
    "pollMs=700"
  ]) {
    if (!liveClientSource.includes(contract)) {
      console.error(`Ameen Live frontend timing/resource contract is missing: ${contract}`);
      failed = true;
    }
  }
  if (/setInterval|AMEEN_REQUEST_TIMEOUT_MS\s*=\s*(?!60000)/.test(liveClientSource)) {
    console.error("Ameen Live must keep manual polling only and use the approved 60-second frontend timeout.");
    failed = true;
  }
  if (!gatewaySource.includes('Assert-ReadOnlySql') || !gatewaySource.includes('ValidateSet("health","stock","customers")')) {
    console.error("Ameen Live gateway must retain its SELECT-only guard and fixed resource allow-list.");
    failed = true;
  }
}

const html = readFileSync("index.html", "utf8");
if (!html.includes('id="app"')) {
  console.error("index.html is missing #app root.");
  failed = true;
}

if (!html.includes("supabase-client.js")) {
  console.error("index.html is missing Supabase client wiring.");
  failed = true;
}

if (!html.includes("number-normalizer.js")) {
  console.error("index.html is missing number-normalizer.js wiring.");
  failed = true;
}

if (!html.includes("frame-src 'self' blob:")) {
  console.error("index.html CSP must allow only same-origin/blob PDF previews inside the mobile file dialog.");
  failed = true;
}

const app = readFileSync("src/app.js", "utf8");
const priceGenerator = readFileSync("scripts/generate-price-lists.mjs", "utf8");
const pdfGenerator = readFileSync("scripts/generate-pdfs.mjs", "utf8");
const priceListTemplateSource = readFileSync("src/price-list-template.js", "utf8");
const usdBulletin = readFileSync("public/downloads/price-list-usd.html", "utf8");
const sypBulletin = readFileSync("public/downloads/price-list-syp-14050.html", "utf8");
const wazariUsdBulletin = readFileSync("public/downloads/price-list-wazari-usd.html", "utf8");
const wazariSypBulletin = readFileSync("public/downloads/price-list-wazari-syp-14050.html", "utf8");
const bulletinsIndex = readFileSync("public/downloads/index.html", "utf8");
const ameenSyncAgent = readFileSync("tools/ameen-sync-agent.ps1", "utf8");
const ameenPriceApply = readFileSync("tools/apply-approved-prices-to-ameen.ps1", "utf8");
const ameenPriceVerify = readFileSync("tools/verify-prices.ps1", "utf8");
const customerInvoicesPush = readFileSync("tools/push-customer-invoices.ps1", "utf8");
const purchaseInvoicesPull = readFileSync("tools/pull-purchase-invoices-from-ameen.ps1", "utf8");
const purchaseInvoicesTask = readFileSync("tools/register-purchase-invoices-pull-task.ps1", "utf8");
const customerInvoicesVerify = readFileSync("tools/verify-customer-invoice-sync.ps1", "utf8");
const financialAssistant = readFileSync("supabase/functions/financial-assistant/index.ts", "utf8");
const accountBalancesSql = readFileSync("supabase/ameen-account-balance-reports.sql", "utf8");
const accountBalancesPush = readFileSync("tools/push-ameen-account-balances.ps1", "utf8");

for (const contract of [
  "askFinancialAssistant",
  "/functions/v1/financial-assistant",
  "قراءة فقط من الأمين"
]) {
  if (!app.includes(contract) && !readFileSync("src/supabase-client.js", "utf8").includes(contract)) {
    console.error(`Financial assistant client contract is missing: ${contract}`);
    failed = true;
  }
}

for (const contract of [
  'bulletinPdfTheme: readJson("bulletin-pdf-theme", "dark")',
  "function storeBulletinPdfTheme",
  "function setPricePreviewTheme",
  'data-action="select-bulletin-theme"',
  'data-action="price-preview-theme"',
  "customerPricePdfMarkup(items, latest, useSyria, previewTheme)",
  "backgroundColor = selectedTheme === \"light\" ? \"#fffdf8\" : \"#0c0a07\"",
  "freshPublishedBulletinUrl"
]) {
  if (!app.includes(contract)) {
    console.error(`Bulletin light/dark preview contract is missing: ${contract}`);
    failed = true;
  }
}
for (const [label, source] of [
  ["in-app SYP bulletin preview", app],
  ["published SYP bulletin generator", priceGenerator]
]) {
  if (!source.includes("formatBulletinEnglishInteger") || source.includes('toLocaleString("ar-SY")')) {
    console.error(`${label} must format SYP prices with explicit English digits.`);
    failed = true;
  }
}
for (const [label, bulletin] of [
  ["general SYP bulletin", sypBulletin],
  ["wazari SYP bulletin", wazariSypBulletin]
]) {
  if (/[٠-٩۰-۹]/.test(bulletin) || !/\d{1,3}(?:,\d{3})+\s+ل\.س/.test(bulletin)) {
    console.error(`${label} must contain comma-separated English digits and no Arabic/Persian digits.`);
    failed = true;
  }
}

if (!bulletinsIndex.includes('<html dir="rtl" lang="ar" translate="no">') || !bulletinsIndex.includes('<meta name="google" content="notranslate">') || !bulletinsIndex.includes('<div class="date" dir="ltr"><span>')) {
  console.error("The bulletins index must remain Arabic, opt out of auto-translation, and isolate its date parts.");
  failed = true;
}
for (const contract of [
  'createHash("sha256")',
  "pdfRendererSignature",
  'readFileSync(resolve(root, "src/price-list-template.js"), "utf8")',
  'readFileSync(resolve(root, "scripts/generate-pdfs.mjs"), "utf8")',
  "isoDate",
  "versionedPdfFile",
  "?v=${pdfVersion}"
]) {
  if (!priceGenerator.includes(contract)) {
    console.error(`Published PDF cache-busting contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of [
  "const applyPdfTheme",
  'document.querySelector(".ozk-price-list")',
  "sheet.dataset.theme = theme",
  'await applyPdfTheme("dark")',
  'await applyPdfTheme("light")'
]) {
  if (!pdfGenerator.includes(contract)) {
    console.error(`Generated PDF theme contract is missing: ${contract}`);
    failed = true;
  }
}
for (const forbidden of ["sessionStorage", "anthropic-dangerous-direct-browser-access", "api.openai.com/v1/chat/completions"]) {
  if (app.includes(forbidden)) {
    console.error(`Browser-side AI secret contract must be removed: ${forbidden}`);
    failed = true;
  }
}
for (const contract of ["requireStaff", "SUPABASE_SERVICE_ROLE_KEY", "ameen_account_balance_reports", "externalDataShared: false"]) {
  if (!financialAssistant.includes(contract)) {
    console.error(`Financial assistant server contract is missing: ${contract}`);
    failed = true;
  }
}
for (const forbidden of ["api.openai.com", "api.anthropic.com", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (financialAssistant.includes(forbidden)) {
    console.error(`Financial data must not leave Supabase without explicit approval: ${forbidden}`);
    failed = true;
  }
}
for (const contract of ["enable row level security", "public.is_staff()", "ameen_account_balance_reports_is_sync_writer", "revoke all"]) {
  if (!accountBalancesSql.includes(contract)) {
    console.error(`Account-balance RLS contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of ["AMEEN_SQL_CONNECTION_STRING", "FROM dbo.ac000", "Debit, 0) - COALESCE(a.Credit", "ameen_account_balance_reports"]) {
  if (!accountBalancesPush.includes(contract)) {
    console.error(`Read-only Ameen account synchronization contract is missing: ${contract}`);
    failed = true;
  }
}
if (/\b(?:INSERT|UPDATE|DELETE|MERGE|EXEC(?:UTE)?)\b/i.test(accountBalancesPush.split('$sql = @"')[1]?.split('"@')[0] || "")) {
  console.error("Ameen account synchronization SQL must remain SELECT-only.");
  failed = true;
}

// فواتير المبيعات والمشتريات لها مسارات قائمة يقرأها التطبيق فعلياً. منع إعادة
// إدخال سكربتات snapshot جزئية أو جدول مبيعات ثالث غير مستخدم.
for (const obsolete of [
  "tools/sync-sales-invoices-enhanced.ps1",
  "tools/sync-purchase-invoices-enhanced.ps1"
]) {
  if (existsSync(obsolete)) {
    console.error(`Obsolete invoice sync script must not be restored: ${obsolete}`);
    failed = true;
  }
}
for (const contract of [
  'source      = "ameen_customer_invoices"',
  'rest/v1/inventory_reports',
  'bt.BillType IN (1, 3)'
]) {
  if (!customerInvoicesPush.includes(contract)) {
    console.error(`Customer-invoice synchronization contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of [
  'rest/v1/ameen_purchase_invoice_reports',
  '91377a56-ebfc-48c0-b79e-72063e1d7e3a',
  'c9aca8fe-f50e-46eb-91ac-29ee32acbb3e'
]) {
  if (!purchaseInvoicesPull.includes(contract)) {
    console.error(`Purchase-invoice synchronization contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of [
  '"TOBACCO Purchase Invoices Pull"',
  'pull-purchase-invoices-from-ameen.ps1',
  '-MultipleInstances IgnoreNew',
  '-PeriodDays $PeriodDays'
]) {
  if (!purchaseInvoicesTask.includes(contract)) {
    console.error(`Purchase-invoice scheduled-task contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of [
  "missingInSupabase",
  "extraInSupabase",
  "duplicateGuidsInReport",
  "source=eq.ameen_customer_invoices",
  "exit 2"
]) {
  if (!customerInvoicesVerify.includes(contract)) {
    console.error(`Customer-invoice reconciliation contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of ["كابتن بلاك كوين ازرق", "كابتن بلاك كور ازرق جديد", "كابتن بلاك كوين اسود", "كابتن بلاك كور اسود جديد"]) {
  for (const [label, source] of [
    ["site normalization", app],
    ["inventory synchronization", ameenSyncAgent],
    ["price application", ameenPriceApply],
    ["price verification", ameenPriceVerify],
    ["bulletin generation", priceGenerator]
  ]) {
    if (!source.includes(contract)) {
      console.error(`Captain Black Core alias contract is missing from ${label}: ${contract}`);
      failed = true;
    }
  }
}
for (const contract of ['["ماستر كوين أبيض", 340]', '["1970 كوين أبيض", 275]', "distinctPrices.size < 2"]) {
  if (!priceGenerator.includes(contract)) {
    console.error(`Corrected bulletin price contract is missing: ${contract}`);
    failed = true;
  }
}
const priceGenerationWorkflow = readFileSync(".github/workflows/generate-price-lists.yml", "utf8");
if (/git commit[^\n]*\[skip ci\]/i.test(priceGenerationWorkflow)) {
  console.error("Generated price-list commits must trigger Pages deployment; remove [skip ci] from the generator commit.");
  failed = true;
}
// مصدر الحقيقة الوحيد لسعر الصرف هو جدول Supabase bulletin_exchange_rate — يمنع رجوع
// أي مصدر مستقل (ملف JSON محلي أو input يدوي بالـworkflow) بالخطأ.
if (priceGenerationWorkflow.includes("scripts/exchange-rate.json")) {
  console.error("Workflow must not reference scripts/exchange-rate.json — the single source of truth is Supabase bulletin_exchange_rate.");
  failed = true;
}
if (/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*rate:/.test(priceGenerationWorkflow)) {
  console.error("Workflow must not expose a manual rate input — exchange rate must always come from Supabase.");
  failed = true;
}
const generatorSource = readFileSync("scripts/generate-price-lists.mjs", "utf8");
for (const contract of ["bulletin_exchange_rate", "SUPABASE_URL", "fetchExchangeRate"]) {
  if (!generatorSource.includes(contract)) {
    console.error(`Exchange-rate generator contract is missing: ${contract}`);
    failed = true;
  }
}
if (generatorSource.includes("exchange-rate.json")) {
  console.error("generate-price-lists.mjs must not read/write scripts/exchange-rate.json anymore.");
  failed = true;
}
for (const contract of [
  "group: generate-price-lists",
  "cancel-in-progress: false",
  "ref: main",
  "id: bulletin_changes",
  "steps.bulletin_changes.outputs.changed == 'true'",
  "لا تغييرات في الأسعار اليدوية أو المخزون"
]) {
  if (!priceGenerationWorkflow.includes(contract)) {
    console.error(`Automatic manual-price bulletin contract is missing: ${contract}`);
    failed = true;
  }
}
// النشرات تُولَّد الآن داخل مهمة النشر لا بـ commit إلى main، لأن حماية الفرع
// ترفض دفع البوتات (GH013) ولا يمكن استثناؤها في مستودع شخصي.
const deployWorkflow = readFileSync(".github/workflows/pages.yml", "utf8");
for (const contract of [
  "node scripts/generate-price-lists.mjs",
  "node scripts/generate-pdfs.mjs",
  "Bump service worker cache version"
]) {
  if (!deployWorkflow.includes(contract)) {
    console.error(`Deploy-time bulletin generation contract is missing in pages.yml: ${contract}`);
    failed = true;
  }
}
if (/git\s+push\s+origin\s+HEAD:main/.test(priceGenerationWorkflow)) {
  console.error("generate-price-lists.yml must not push to main — branch protection rejects bot pushes (GH013).");
  failed = true;
}
// نشر الأسعار يجب أن يعمل بلا تدخل بشري حتى لو حُفظ السعر من متصفح بلا gh_publish_token:
// زناد دوري (schedule) على generate-price-lists.yml يضمن نجاحه فيُشغّل pages.yml تلقائياً
// عبر workflow_run. يجب أن يبقى بلا أي خطوة كتابة على main (الصلاحيات read فقط).
if (!/schedule:\s*\n\s*-\s*cron:/.test(priceGenerationWorkflow)) {
  console.error("generate-price-lists.yml must keep an unattended schedule trigger so price/rate changes saved without gh_publish_token still publish automatically.");
  failed = true;
}
if (!/permissions:\s*\n\s*contents:\s*read/.test(priceGenerationWorkflow)) {
  console.error("generate-price-lists.yml must keep permissions: contents: read — scheduling must never regain write/commit access to main (GH013).");
  failed = true;
}
const dailyProfitScript = readFileSync("tools/push-daily-profit.ps1", "utf8");
// إصلاح تزامن ameen_daily_profit: يمنع أن يحذف أحد الـproducers (TOBACCO Ameen Sync
// أو TOBACCO Sales Line Items Push) صفّ الآخر عند التزامن. يجب استخدام upsert ذرّي
// عبر RPC بدل النمط القديم insert-ثم-delete الذي يفتح نافذة سباق حقيقية.
if (!dailyProfitScript.includes("rpc/upsert_ameen_daily_profit")) {
  console.error("push-daily-profit.ps1 must upsert via rpc/upsert_ameen_daily_profit (atomic) instead of insert-then-delete, to avoid the cross-producer race condition.");
  failed = true;
}
if (/Method\s+Delete[^\n]*inventory_reports/i.test(dailyProfitScript)) {
  console.error("push-daily-profit.ps1 must not DELETE from inventory_reports directly — that reopens the race window between concurrent producers.");
  failed = true;
}
// أمن upsert_ameen_daily_profit (Codex P1، 2026-08-29): created_by يجب أن يُشتق من
// auth.uid() داخل الدالة، لا أن يُرسَل من العميل — إرساله يفتح انتحالاً لهوية أي مستخدم.
if (/p_created_by/.test(dailyProfitScript)) {
  console.error("push-daily-profit.ps1 must not send p_created_by — the RPC derives created_by from auth.uid() server-side to prevent identity spoofing.");
  failed = true;
}
const dailyProfitSql = readFileSync("supabase/ameen-daily-profit-atomic-upsert.sql", "utf8");
if (!/revoke\s+all\s+on\s+function\s+public\.upsert_ameen_daily_profit[^\n]*from\s+public/i.test(dailyProfitSql)) {
  console.error("ameen-daily-profit-atomic-upsert.sql must explicitly REVOKE ALL ... FROM PUBLIC — Postgres grants EXECUTE to PUBLIC by default on new functions, which would let any caller bypass RLS via this SECURITY DEFINER function.");
  failed = true;
}
// تقييد الهوية (Codex P1، 2026-08-29، جولة ٢): GRANT لكل authenticated غير كافٍ —
// أي جلسة مصادَقة عادية تستطيع استدعاء SECURITY DEFINER وتزوير بيانات الربح. يجب
// وجود حارس صريح يقتصر على هوية المزامنة الرسمية الثابتة (نفس نمط sync_writer
// المعتمد بالمشروع)، لا الاعتماد على تسجيل created_by وحده.
if (!/ameen_daily_profit_is_sync_writer/.test(dailyProfitSql)) {
  console.error("ameen-daily-profit-atomic-upsert.sql must restrict upsert_ameen_daily_profit to the trusted sync identity (ameen_daily_profit_is_sync_writer) — logging created_by via auth.uid() records the caller but does not authorize them; any authenticated session could otherwise overwrite the report.");
  failed = true;
}
if (!/9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3/.test(dailyProfitSql)) {
  console.error("ameen-daily-profit-atomic-upsert.sql must guard against the project's established live sync-account UUID, matching the pattern already used by sales_line_items_is_sync_writer / ameen_item_snapshot_is_sync_writer.");
  failed = true;
}
const newsletterContracts = [
  'navButton("pricing", "نشرة الأسعار")',
  'pricing: "نشرة الأسعار"',
  "مركز نشرة الأسعار",
  "public/downloads/price-list-usd.html",
  "public/downloads/price-list-syp-14050.html",
  "public/downloads/price-list-wazari-usd.html",
  "public/downloads/price-list-wazari-syp-14050.html"
];
for (const contract of newsletterContracts) {
  if (!app.includes(contract)) {
    console.error(`Newsletter center contract is missing: ${contract}`);
    failed = true;
  }
}

for (const contract of [
  "function isWazariPriceItem",
  "function hasFullSecondUnit",
  "function consolidateGeneralPriceItems",
  "function generalPricingWorklistItems",
  "const items = generalPricingWorklistItems();",
  "pricingWorklistItems({ ignoreSearch: true })",
  "data-source-keys=",
  "sourceKeys: [item.key].filter(Boolean)"
]) {
  if (!app.includes(contract)) {
    console.error(`General pricing list contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of ["const merged = new Map();", "counts.set(price", "findLast((candidate)"]) {
  if (!priceGenerator.includes(contract)) {
    console.error(`Merged bulletin price selection contract is missing: ${contract}`);
    failed = true;
  }
}

// أصناف الدمج الإداري يجب ألا تظهر أكثر من سطر واحد في كل نشرة حتى لو كانت
// aliases القديمة تحمل أسعاراً مختلفة قبل أن يوحّدها الحفظ التالي من الموقع.
// غياب السطر تماماً (صفر) حالة مشروعة: يعني عدم توفر أي alias مؤهل بسعر صالح
// في هذا الوضع حالياً (مثلاً نفاد كرتونة كاملة من الجملة) وليس خللاً بالدمج —
// الخلل الذي يحرسه هذا الفحص هو تكرار السطر (٢+) لا غيابه.
for (const [label, bulletin] of [["USD", usdBulletin], ["SYP", sypBulletin]]) {
  for (const name of ["ماستر طويل ورق", "ماستر قصير أزرق"]) {
    const count = bulletin.split(name).length - 1;
    if (count > 1) {
      console.error(`${label} bulletin must contain at most one merged row for ${name}; found ${count}.`);
      failed = true;
    }
  }
}
for (const contract of ["sourceKeys: named.map", "const exact = named.find"]) {
  if (!app.includes(contract)) {
    console.error(`Administrative bulletin alias merge contract is missing: ${contract}`);
    failed = true;
  }
}

if (app.includes("سعّر الجملة أولاً")) {
  console.error("Retail-only pricing must not require a wholesale USD price first.");
  failed = true;
}
// مصدر الحقيقة الوحيد لسعر الصرف هو جدول Supabase bulletin_exchange_rate — عبر
// dataStore.getSyriaExchangeRate/setSyriaExchangeRate. يمنع رجوع أي مصدر مستقل
// (ملف JSON، نسخة "معلّقة" بـlocalStorage، أو rate ضمن GitHub dispatch).
for (const contract of [
  "data-published-exchange-rate",
  "loadPublishedExchangeRate",
  "function applySyriaExchangeRateLocally",
  "async function commitSyriaExchangeRate",
  "dataStore.getSyriaExchangeRate",
  "dataStore.setSyriaExchangeRate",
  "scheduleBulletinPublish({ label:",
  'const REPO = "ozkkhallouf-ux/tobacco-web"'
]) {
  if (!app.includes(contract)) {
    console.error(`Daily exchange-rate contract is missing: ${contract}`);
    failed = true;
  }
}
for (const forbidden of [
  "exchange-rate.json",
  "syria-exchange-rate-pending",
  "inputs: { rate:",
  "function storeSyriaExchangeRate("
]) {
  if (app.includes(forbidden)) {
    console.error(`Exchange-rate source of truth violation in app.js: found forbidden pattern "${forbidden}"`);
    failed = true;
  }
}

{
  const freshPreviewFunction = app.match(/async function openFreshPricePreview\(useSyria = false(?:, theme = state\.bulletinPdfTheme)?\) \{[\s\S]*?\n\}/)?.[0];
  if (!freshPreviewFunction) {
    console.error("Could not isolate openFreshPricePreview for the exchange-rate regression check.");
    failed = true;
  } else {
    const captureIndex = freshPreviewFunction.indexOf("capturePublishedExchangeRate()");
    const saveIndex = freshPreviewFunction.indexOf("await savePendingPricingEdits()");
    if (captureIndex === -1 || saveIndex === -1 || captureIndex > saveIndex) {
      console.error("The visible Syrian exchange rate must be captured before pricing saves can re-render the page.");
      failed = true;
    }
  }
}
for (const contract of [
  "function refreshBulletinStatusNotice",
  'addEventListener("input"',
  "cloudFallback: false",
  "ستلتقطه السحابة تلقائياً خلال 15 دقيقة"
]) {
  if (!app.includes(contract)) {
    console.error(`Reliable manual rate/price publishing contract is missing: ${contract}`);
    failed = true;
  }
}
for (const contract of [
  "async function savePendingPricingEdits",
  "async function openFreshPricePreview",
  "pricingFormNeedsSave",
  "await loadApprovedPriceItems()",
  'form.dataset.dirty = "true"',
  "openFreshPricePreview(false)",
  "openFreshPricePreview(true)",
  "حفظ التعديلات ومعاينة PDF الآن"
]) {
  if (!app.includes(contract)) {
    console.error(`Instant bulletin print/export contract is missing: ${contract}`);
    failed = true;
  }
}

// المعاينة والمولّد العام يجب أن يستخدما القالب الجديد نفسه؛ وجود قالبين منفصلين
// أعاد التصميم القديم إلى زر «حفظ التعديلات ومعاينة PDF الآن».
for (const contract of [
  "2026-08-26-fixed-table-layout",
  "price-list-header-title",
  "price-list-columns",
  "price-list-group-header"
]) {
  if (!priceListTemplateSource.includes(contract)) {
    console.error(`Shared price-list template contract is missing: ${contract}`);
    failed = true;
  }
}
if (!priceListTemplateSource.includes("white-space:nowrap") || !priceListTemplateSource.includes("padding-inline-end:32px")) {
  console.error("The bulletin currency/rate badge must stay on one line without clipping RTL text in PDF exports.");
  failed = true;
}
// جذر الانكسار المتكرر في النشرة: table-layout:auto الافتراضي يسمح لجدول
// الأسعار بالتمدد أوسع من حاويته عند اسم/ملاحظة طويلين، وoverflow:hidden على
// الجذر يقصّ الفائض بصمت بدل إظهاره. table-layout:fixed + word-break يمنعان
// حدوث الفيضان أصلاً، بدل إخفائه — راجع docs/ai/topics/price-bulletins.md.
if (!priceListTemplateSource.includes("table-layout:fixed") || !priceListTemplateSource.includes("word-break:break-word")) {
  console.error("The bulletin table must use table-layout:fixed with word-break on the name cell so long names/notes wrap inside the cell instead of overflowing the page (silently hidden by overflow:hidden otherwise).");
  failed = true;
}
if (!html.includes('src/price-list-template.js?v=') || html.indexOf("src/price-list-template.js") > html.indexOf("src/app.js")) {
  console.error("The shared price-list template must load before app.js.");
  failed = true;
}
if (!app.includes("template.render({") || !app.includes("customerPriceTemplatePageCount")) {
  console.error("The in-app PDF preview must render and count pages through the shared new bulletin template.");
  failed = true;
}
if (!priceGenerator.includes('import "../src/price-list-template.js"') || !priceGenerator.includes("priceListTemplate.render({")) {
  console.error("The public bulletin generator must render through the same shared template as the in-app preview.");
  failed = true;
}
{
  const templateContext = vm.createContext({ console });
  templateContext.globalThis = templateContext;
  vm.runInContext(priceListTemplateSource, templateContext);
  const templateApi = templateContext.OZKPriceListTemplate;
  const arabicIssueDate = templateApi?.formatArabicIssueDate?.(new Date(2026, 7, 23));
  if (arabicIssueDate !== "23 آب 2026" || /[٠-٩۰-۹]/.test(arabicIssueDate || "")) {
    console.error("The shared bulletin date formatter must use an Arabic month with English digits.");
    failed = true;
  }
  const sample = templateApi?.render?.({
    groups: [{ name: "ماستر", items: [{ name: "صنف تجريبي", unit: "كرتونة", price: "10.00 $" }] }],
    logoSrc: "logo.png",
    issueDate: arabicIssueDate,
    badgeClass: "badge-usd",
    badgeLabelHtml: "دولار",
    unitLabel: "سعر الكرتونة (جملة)"
  }) || "";
  if (!sample.includes('class="ozk-price-list"') || !sample.includes('lang="ar" dir="rtl" translate="no"') || !sample.includes("صنف تجريبي") || sample.includes("price-pdf-book")) {
    console.error("The shared template did not render the new bulletin markup correctly.");
    failed = true;
  }
  if (!sample.includes('class="price-list-header-date" dir="ltr"') || !sample.includes('class="issue-date-month" dir="rtl">آب</span>')) {
    console.error("The bulletin issue date must isolate its English digits from the Arabic month in RTL exports.");
    failed = true;
  }
}

for (const [label, source] of [
  ["in-app bulletin preview", app],
  ["published bulletin generator", priceGenerator]
]) {
  if (!source.includes("formatArabicIssueDate") || source.includes('toLocaleDateString("en-GB"')) {
    console.error(`${label} must use the shared Arabic issue-date formatter.`);
    failed = true;
  }
}

for (const contract of [
  "const STARTUP_TIMEOUT_MS = 12000",
  "startupDegraded: false",
  "data-startup-degraded",
  "data-action=\"retry-startup\"",
  "window.location.reload()",
  "window.clearTimeout(startupTimeout)"
]) {
  if (!app.includes(contract)) {
    console.error(`Resilient startup contract is missing: ${contract}`);
    failed = true;
  }
}

{
  const bootFunction = app.match(/async function boot\(\) \{[\s\S]*?\n\}/)?.[0];
  if (!bootFunction || !bootFunction.includes("window.setTimeout") || !bootFunction.includes("finally")) {
    console.error("Startup must always leave the loading screen and provide a timeout fallback.");
    failed = true;
  }
}

{
  const unit2PriceFunction = app.match(/function itemUnit2Price\(item\) \{[\s\S]*?\n\}/)?.[0];
  if (!unit2PriceFunction) {
    console.error("Could not isolate itemUnit2Price for the fresh-price regression check.");
    failed = true;
  } else {
    const sandbox = {
      approvedResult: 0,
      fallbackResult: 0,
      zeroApprovedResult: -1,
      roundPrice: (value) => Math.round(Number(value) * 100) / 100,
      itemUnit2Factor: () => 10
    };
    vm.createContext(sandbox);
    vm.runInContext(`${unit2PriceFunction}
      approvedResult = itemUnit2Price({ unit2Price: 100, approvedPrice: { unit2Price: 125 } });
      fallbackResult = itemUnit2Price({ unit2Price: 100, approvedPrice: null });
      zeroApprovedResult = itemUnit2Price({ unit2Price: 100, approvedPrice: { unit2Price: 0, salePrice: 0 } });`, sandbox);
    if (sandbox.approvedResult !== 125 || sandbox.fallbackResult !== 100 || sandbox.zeroApprovedResult !== 0) {
      console.error("Bulletin PDF must prefer the newly approved price and only fall back to the stock snapshot price.");
      failed = true;
    }
  }
}
for (const contract of ["scheduleBulletinPublish", "normalizedTargets", "aliasKeys", "storedTokenOnly: true"]) {
  if (!app.includes(contract)) {
    console.error(`Automatic bulletin synchronization contract is missing: ${contract}`);
    failed = true;
  }
}
if (app.includes("state.inventoryReports[0]")) {
  console.error("Inventory views must select the latest real stock report instead of the newest mixed report row.");
  failed = true;
}
for (const contract of ["function latestStockReport()", "const latest = latestStockReport();", "reportItems(latestStockReport())"]) {
  if (!app.includes(contract)) {
    console.error(`Latest stock-report selection contract is missing: ${contract}`);
    failed = true;
  }
}
if (/function latestStockReport\(\)[\s\S]*?\|\| reports\[0\]/.test(app)) {
  console.error("Latest stock-report selection must not fall back to a non-stock report.");
  failed = true;
}
for (const contract of [
  'name="wholesalePrice"',
  'name="retailPrice"',
  "const sourceUnit2Price = wholesaleProvided ? enteredWholesale : sourceExistingWholesale;",
  "const sourceRetailPrice = retailProvided ? enteredRetail : sourceExistingRetail;",
  'data-action="download-customer-price-pdf"',
  'data-action="download-customer-price-syria"',
  "آخر نسخة منشورة للزبائن"
]) {
  if (!app.includes(contract)) {
    console.error(`Dual-price save/instant preview contract is missing: ${contract}`);
    failed = true;
  }
}

const generatedNewsletterPages = [
  "public/downloads/price-list-usd.html",
  "public/downloads/price-list-syp-14050.html",
  "public/downloads/price-list-wazari-usd.html",
  "public/downloads/price-list-wazari-syp-14050.html"
];
for (const newsletterPage of generatedNewsletterPages) {
  const page = readFileSync(newsletterPage, "utf8");
  if (!page.includes("طباعة مباشرة") || !page.includes("فتح PDF") || !page.includes("تنزيل PDF") || !page.includes("-light.pdf") || page.includes('target="_blank"')) {
    console.error(`Newsletter page is missing theme-aware mobile print controls: ${newsletterPage}`);
    failed = true;
  }
  if (!/price-list-[^"']+\.pdf\?v=[a-f0-9]{12}/.test(page)) {
    console.error(`Newsletter PDF links must carry a content version to bypass stale browser PDFs: ${newsletterPage}`);
    failed = true;
  }
  if (page.includes("item-count-num") || page.includes("item-count-lbl")) {
    console.error(`Newsletter page must not show the item count: ${newsletterPage}`);
    failed = true;
  }
  if (!page.includes('<html dir="rtl" lang="ar" translate="no">') || !page.includes('<meta name="google" content="notranslate">') || !page.includes('<meta http-equiv="Content-Language" content="ar">')) {
    console.error(`Newsletter page must declare Arabic RTL and opt out of browser auto-translation: ${newsletterPage}`);
    failed = true;
  }
  if (!/\b\d{2} (?:كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول) \d{4}\b/.test(page) || /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(page)) {
    console.error(`Newsletter page must show an Arabic issue month with English digits: ${newsletterPage}`);
    failed = true;
  }
}

for (const [label, bulletin] of [
  ["general USD bulletin", usdBulletin],
  ["general SYP bulletin", sypBulletin],
  ["wazari USD bulletin", wazariUsdBulletin],
  ["wazari SYP bulletin", wazariSypBulletin]
]) {
  if (!bulletin.includes('lang="ar" dir="rtl" translate="no"')) {
    console.error(`${label} content must remain explicitly Arabic and RTL.`);
    failed = true;
  }
}

// تناسق نسخة الكاش: كل أصل محلي في index.html يجب أن يحمل نفس قيمة ?v=
// يلتقط خطأ "رفعت رقم النسخة لبعض الملفات ونسيت الباقي" قبل النشر.
const versionTags = [...html.matchAll(/(?:src|href)="[^"]*\?v=([^"&]+)"/g)].map((m) => m[1]);
if (versionTags.length === 0) {
  console.error("index.html has no ?v= cache-busting versions on local assets.");
  failed = true;
} else {
  const uniqueVersions = [...new Set(versionTags)];
  if (uniqueVersions.length > 1) {
    console.error(`index.html has mismatched asset versions: ${uniqueVersions.join(", ")}. Bump them all to the same value.`);
    failed = true;
  }
}

// منع بقاء المتصفح على app.js قديم بعد تغييرات تقرير المخزون: يجب رفع نسخة
// أصول index مع نسخة الكاش الجديدة، وإلا تفتح نافذة about:blank من كود قديم.
const tobaccoAssetVersion = Number((versionTags[0] || "").match(/tobacco-(\d+)/)?.[1] || 0);
if (tobaccoAssetVersion < 88) {
  console.error("index.html asset version must be tobacco-88 or newer after the inventory report update.");
  failed = true;
}

// service worker يجب أن يحمل CACHE_NAME غير فارغ (يُرفع رقمه عند كل نشر).
const sw = readFileSync("public/service-worker.js", "utf8");
const cacheMatch = sw.match(/CACHE_NAME\s*=\s*["']([^"']+)["']/);
if (!cacheMatch || !cacheMatch[1].trim()) {
  console.error("service-worker.js is missing a non-empty CACHE_NAME.");
  failed = true;
}
const cacheVersion = Number(cacheMatch?.[1]?.match(/v(\d+)$/)?.[1] || 0);
if (cacheVersion < 272) {
  console.error("service worker cache must be v272 or newer after the inventory report update.");
  failed = true;
}

// عقد تقرير المخزون: ترتيب النشرة، تصنيف حسب حركة المبيع، مجموعات ظاهرة،
// وتصميم فاتح ثابت في الشاشة والطباعة.
const appJs = readFileSync("src/app.js", "utf8");

// تصدير الهاتف يجب أن ينشئ Blob PDF فعلياً لكل مسارات المستندات، ثم ينتظر
// نقرة مشاركة جديدة حتى يقبل iOS الحفظ في Files بعد انتهاء الرسم غير المتزامن.
for (const contract of [
  "function presentPortablePdf(blob, filename, title)",
  "async function createPortablePdfBlob(bodyHtml, filename, options = {})",
  "trimTrailingPortablePdfDecorations",
  "balanceLastPricePdfPage",
  'data-pdf-share',
  'navigator.share({ files: [file]',
  'blob.type !== "application/pdf"',
  'canvasInkRatio(canvas) <= 0.001',
  'document.createTreeWalker(source, NodeFilter.SHOW_TEXT)',
  '.replace(/ /g, "\\u00a0")'
]) {
  if (!appJs.includes(contract)) {
    console.error(`Mobile PDF file contract is missing: ${contract}`);
    failed = true;
  }
}
for (const [name, pattern] of [
  ["shared reports", /async function exportReportPdf[\s\S]{0,900}isHandheldDevice\(\)[\s\S]{0,900}createPortablePdfBlob/],
  ["price bulletins", /async function exportBulletinPdf[\s\S]{0,1200}isHandheldDevice\(\)[\s\S]{0,900}createPortablePdfBlob/],
  ["overdue report", /async function printOverdueReport[\s\S]{0,2600}isHandheldDevice\(\)[\s\S]{0,900}createPortablePdfBlob/],
  ["current sales invoice", /async function saveSalesInvoicePdf[\s\S]{0,9000}isHandheldDevice\(\)[\s\S]{0,500}presentPortablePdf/]
]) {
  if (!pattern.test(appJs)) {
    console.error(`Mobile PDF file path is missing for ${name}.`);
    failed = true;
  }
}

// html2canvas التقليدي يقلب ترتيب العربية في النشرة المصورة. يجب أن يمرّر
// تصدير النشرة على الهاتف وWindows الرسم إلى محرك المتصفح عبر foreignObject.
const bulletinPdfExport = appJs.match(/async function exportBulletinPdf\([\s\S]*?\n\}/)?.[0] || "";
const rtlBrowserRenderCount = (bulletinPdfExport.match(/foreignObjectRendering:\s*true/g) || []).length;
if (rtlBrowserRenderCount < 2) {
  console.error("Price bulletin PDF export must preserve Arabic RTL on both handheld and desktop paths.");
  failed = true;
}
if (!appJs.includes("foreignObjectRendering: Boolean(options.foreignObjectRendering)")) {
  console.error("Portable PDF rendering must forward the opt-in foreignObject RTL setting.");
  failed = true;
}
for (const contract of [
  "function stabilizeBulletinPdfRtlLayout(source)",
  "stabilizeBulletinRtl: true",
  'stabilizeBulletinPdfRtlLayout(container.querySelector(".ozk-price-list"))',
  "if (options.stabilizeBulletinRtl) stabilizeBulletinPdfRtlLayout(source)",
  'page.style.minHeight = "1123px"'
]) {
  if (!appJs.includes(contract)) {
    console.error(`Price bulletin RTL layout stabilization is missing: ${contract}`);
    failed = true;
  }
}

// نموذج فاتورة المبيعات (route: sales) يجب أن يبقي التركيز أثناء كتابة اسم الزبون،
// وأن يستخدم أرقاماً إنجليزية في حقول الكمية والسعر مهما كانت لغة عرض ويندوز.
// (كان هذا العقد مربوطاً بصفحة invoice القديمة التي حُذفت في 27bfbe2؛ نُقل إلى
//  الصفحة الحيّة التي ورثت نفس السلوك بدل أن تضيع التغطية.)
if (/state\.salesCustomer = e\.currentTarget\.value;\s*render\(\);/.test(appJs)) {
  console.error("Sales invoice customer input must not rerender and lose focus after every character.");
  failed = true;
}
for (const field of ["qty", "price"]) {
  const salesInput = new RegExp(`data-sales-field="${field}"[^>]*data-sales-num[^>]*type="text"[^>]*inputmode="decimal"[^>]*dir="ltr"`);
  if (!salesInput.test(appJs)) {
    console.error(`Sales invoice ${field} input must use English decimal text entry.`);
    failed = true;
  }
}
const numberNormalizer = readFileSync("src/number-normalizer.js", "utf8");
if (!numberNormalizer.includes("input[data-sales-num]")) {
  console.error("Sales invoice numeric fields must be covered by the English-number normalizer.");
  failed = true;
}

for (const contract of [
  "INVENTORY_GROUP_SEQUENCE",
  "inventoryReportStatus",
  "inventory-group-row",
  "inventoryTwoColumnPages",
  "inventory-columns",
  "grid-template-columns:repeat(2",
  "inventory-rpt",
  "color-scheme:light",
  "لا تُدمج أصناف المعسل"
]) {
  if (!appJs.includes(contract)) {
    console.error(`Inventory report contract is missing: ${contract}`);
    failed = true;
  }
}

// تقرير الذمم يجب أن يعرض تاريخ آخر دفعة وقيمتها في عمودين صريحين.
if (!appJs.includes("قيمة آخر دفعة") || !/receivablesPdfMarkup[\s\S]*customerLastPaymentAmount\(it\)/.test(appJs)) {
  console.error("Receivables PDF must include the last payment amount beside its date.");
  failed = true;
}

// أرصدة الذمم تأتي موحّدة بالدولار من ac000 ولا يجوز تحويلها ثانية حسب تصنيف الزبون.
const balanceQuery = readFileSync("tools/ameen-customer-balances-query.sql", "utf8");
if (!/coalesce\(ac\.Debit, 0\) - coalesce\(ac\.Credit, 0\)/i.test(balanceQuery)
  || /as balance[\s\S]{0,120}cu\.Debit/i.test(balanceQuery)
  || !/function customerBalanceSortValue\(item\)\s*\{\s*return customerBalance\(item\);\s*\}/.test(appJs)
  || !/receivablesPdfMarkup[\s\S]*customerBalanceSortValue\(b\) - customerBalanceSortValue\(a\)/.test(appJs)) {
  console.error("Receivables must use and sort the USD base balance from ac000 without a second conversion.");
  failed = true;
}

// أرصدة الزبائن صفحة مستقلة وليست جزءاً من تبويب الأمين.
for (const contract of [
  'navButton("balances", "💳 أرصدة الزبائن")',
  "function customerBalancesPage()",
  "balances: customerBalancesPage",
  '["ameen", "balances", "pricing", "dashboard", "payments"]'
]) {
  if (!appJs.includes(contract)) {
    console.error(`Standalone customer balances contract is missing: ${contract}`);
    failed = true;
  }
}
const ameenFunction = appJs.match(/function ameen\(\) \{[\s\S]*?\n\}\n\nfunction customerBalancesPage\(/)?.[0] || "";
if (ameenFunction.includes("customerBalanceSection(")) {
  console.error("Ameen tab must not render the customer balances section.");
  failed = true;
}

const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
if (!manifest.name || !manifest.start_url) {
  console.error("manifest.webmanifest is incomplete.");
  failed = true;
}

const coordination = JSON.parse(readFileSync("AI_ACTIVE_TASK.json", "utf8"));
if (coordination.schemaVersion !== 1 || !["idle", "active"].includes(coordination.status)) {
  console.error("AI_ACTIVE_TASK.json has an invalid schema or status.");
  failed = true;
}
if (coordination.status === "active" && (!coordination.owner || !coordination.task || !coordination.branch)) {
  console.error("Active AI task is missing owner, task, or branch.");
  failed = true;
}
if (!Array.isArray(coordination.files)) {
  console.error("AI_ACTIVE_TASK.json files must be an array.");
  failed = true;
}

// قائمة دمج النشرة يجب أن تكون متطابقة بين المولّد (scripts/bulletin-merge-names.json)
// وقائمة الموقع (BULLETIN_MERGE_NAMES في src/app.js): أي اختلاف يعني أن النشرة
// العامة ستعرض صنفين بينما يعرضهما الموقع مدموجين — وهو ما يربك الزبون والبائع.
const mergeNamesRaw = readFileSync("scripts/bulletin-merge-names.json", "utf8");
let mergeNames = [];
try {
  mergeNames = JSON.parse(mergeNamesRaw);
} catch {
  console.error("scripts/bulletin-merge-names.json is not valid JSON.");
  failed = true;
}
if (!Array.isArray(mergeNames) || mergeNames.some((name) => typeof name !== "string" || !name.trim())) {
  console.error("scripts/bulletin-merge-names.json must be an array of non-empty strings.");
  failed = true;
} else {
  const appSource = readFileSync("src/app.js", "utf8");
  const literal = appSource.match(/const BULLETIN_MERGE_NAMES = \[(.*?)\];/s);
  if (!literal) {
    console.error("BULLETIN_MERGE_NAMES not found in src/app.js.");
    failed = true;
  } else {
    const appNames = [...literal[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (JSON.stringify(appNames) !== JSON.stringify(mergeNames)) {
      console.error("BULLETIN_MERGE_NAMES in src/app.js does not match scripts/bulletin-merge-names.json.");
      console.error(`  app.js: ${JSON.stringify(appNames)}`);
      console.error(`  json:   ${JSON.stringify(mergeNames)}`);
      failed = true;
    }
  }
}

// اختبارات حقيقية (assertions فعلية لا مجرد فحص نصي) لدوال purchase-invoice-calc.js
// النقية: مطابقة الأصناف، حساب الأسطر/الإجمالي/المتبقي، تطبيع الأرقام، التحقق من
// الدفعة، وحارس انتقالات حالة الفاتورة. تشغَّل داخل sandbox معزول عن DOM.
{
  const poCalcSource = readFileSync("src/purchase-invoice-calc.js", "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(poCalcSource, sandbox, { filename: "purchase-invoice-calc.js" });
  const poCalc = sandbox.window.poCalc;
  if (!poCalc) {
    console.error("src/purchase-invoice-calc.js did not expose window.poCalc.");
    failed = true;
  } else {
    const assertEqual = (label, actual, expected) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) {
        console.error(`poCalc test failed: ${label} — got ${a}, expected ${e}`);
        failed = true;
      }
    };

    // تطبيع الأرقام العربية/الفارسية إلى إنجليزية
    assertEqual("poNormalizeNumeric arabic-indic digits", poCalc.poNormalizeNumeric("١٢٣٫٥"), "123.5");
    assertEqual("poToNumber persian digits", poCalc.poToNumber("۴۲"), 42);

    // حساب سطر الفاتورة
    assertEqual("poRowComputed without key", poCalc.poRowComputed({ qty: "5", price: "2" }), { qty: 0, price: 0, lineTotal: 0 });
    assertEqual("poRowComputed with key", poCalc.poRowComputed({ key: "x", qty: "5", price: "2" }), { qty: 5, price: 2, lineTotal: 10 });

    // إجمالي الفاتورة (سطر بلا key لا يُحتسب)
    assertEqual(
      "poTotals sums only rows with key",
      poCalc.poTotals([{ key: "a", qty: "2", price: "3" }, { qty: "9", price: "9" }, { key: "b", qty: "1", price: "1.5" }]),
      { grand: 7.5 }
    );

    // حالة المتبقي: مستحق، مسدد بالكامل، مدفوع زيادة
    assertEqual("poRemainingState due", poCalc.poRemainingState({ total: 100, paidAmount: 40 }).status, "due");
    assertEqual("poRemainingState settled", poCalc.poRemainingState({ total: 100, paidAmount: 100 }).status, "settled");
    assertEqual("poRemainingState over", poCalc.poRemainingState({ total: 100, paidAmount: 150 }).status, "over");

    // التحقق من قيمة الدفعة (رفض السالب وما يتجاوز الإجمالي، قبول القيم الصحيحة)
    assertEqual("poValidatePayment negative rejected", poCalc.poValidatePayment({ total: 100, amount: -1 }).ok, false);
    assertEqual("poValidatePayment over-total rejected", poCalc.poValidatePayment({ total: 100, amount: 150 }).ok, false);
    assertEqual("poValidatePayment valid accepted", poCalc.poValidatePayment({ total: 100, amount: 60 }).ok, true);

    // النص الظاهر لصنف مختار: رقم — اسم دوماً، مع الحفاظ على الأصفار البادئة
    assertEqual("poItemDisplayLabel number and name shown together", poCalc.poItemDisplayLabel("0005", "اسم المادة"), "0005 — اسم المادة");
    assertEqual("poItemDisplayLabel leading zeros preserved", poCalc.poItemDisplayLabel("0005", "اسم المادة").startsWith("0005"), true);
    assertEqual("poItemDisplayLabel name-only search still shows number when known", poCalc.poItemDisplayLabel("0012", "مادة بالاسم"), "0012 — مادة بالاسم");
    assertEqual("poItemDisplayLabel falls back to name without number", poCalc.poItemDisplayLabel("", "اسم بلا رقم"), "اسم بلا رقم");
    assertEqual("poItemDisplayLabel falls back to number without name", poCalc.poItemDisplayLabel("0009", ""), "0009");

    // تعديل حقل البحث بعد اختيار صنف يُبطل الارتباط القديم فوراً
    assertEqual(
      "poNextRowAfterQueryInput clears stale selection when text changes after pick",
      poCalc.poNextRowAfterQueryInput({ key: "k1", name: "صنف قديم", num: "0005", q: "0005 — صنف قديم" }, "0007"),
      { key: "", name: "", num: "", q: "0007" }
    );
    assertEqual(
      "poNextRowAfterQueryInput keeps selection when text unchanged",
      poCalc.poNextRowAfterQueryInput({ key: "k1", name: "صنف قديم", num: "0005", q: "0005 — صنف قديم" }, "0005 — صنف قديم"),
      { key: "k1", name: "صنف قديم", num: "0005", q: "0005 — صنف قديم" }
    );
    assertEqual(
      "poNextRowAfterQueryInput plain typing with no prior selection",
      poCalc.poNextRowAfterQueryInput({ key: "", name: "", num: "", q: "" }, "0005"),
      { key: "", name: "", num: "", q: "0005" }
    );

    // منع حفظ سطر كُتب فيه نص بحث دون اختيار فعلي من الاقتراحات
    assertEqual("poHasUnselectedEntry flags typed-but-unselected row", poCalc.poHasUnselectedEntry([{ key: "", q: "0005" }]), true);
    assertEqual("poHasUnselectedEntry ignores empty rows", poCalc.poHasUnselectedEntry([{ key: "", q: "  " }]), false);
    assertEqual("poHasUnselectedEntry passes when selected", poCalc.poHasUnselectedEntry([{ key: "k1", q: "0005 — صنف" }]), false);

    // عرض فواتير مشتريات الأمين (قراءة فقط): بحث موردين متسامح مع الهمزات/التاء المربوطة
    assertEqual(
      "poAmeenSupplierMatches tolerates hamza/taa marbouta variants",
      poCalc.poAmeenSupplierMatches("الامين", ["شركة الأمين للتجارة", "مورد آخر"]),
      ["شركة الأمين للتجارة"]
    );
    assertEqual("poAmeenSupplierMatches empty query returns no suggestions", poCalc.poAmeenSupplierMatches("", ["مورد"]), []);
    assertEqual(
      "poAmeenSupplierMatches caps at 8 suggestions",
      poCalc.poAmeenSupplierMatches("مورد", Array.from({ length: 12 }, (_, i) => `مورد ${i}`)).length,
      8
    );

    // التنقل بين فاتورة سابقة/تالية لمورد واحد بلا خروج عن حدود القائمة
    assertEqual("poAmeenClampNavIndex moves to next invoice", poCalc.poAmeenClampNavIndex(5, 0, 1), 1);
    assertEqual("poAmeenClampNavIndex moves to previous invoice", poCalc.poAmeenClampNavIndex(5, 2, -1), 1);
    assertEqual("poAmeenClampNavIndex stops at newest (index 0)", poCalc.poAmeenClampNavIndex(5, 0, -1), 0);
    assertEqual("poAmeenClampNavIndex stops at oldest (last index)", poCalc.poAmeenClampNavIndex(5, 4, 1), 4);
    assertEqual("poAmeenClampNavIndex empty list stays at 0", poCalc.poAmeenClampNavIndex(0, 0, 1), 0);

    // بحث بنود فاتورة الأمين برقم المادة أو اسمها، مع الحفاظ على الأصفار البادئة بالرقم
    const ameenSampleItems = [
      { itemNumber: "0005", itemName: "دخان أحمر" },
      { itemNumber: "0012", itemName: "دخان أزرق" }
    ];
    assertEqual(
      "poAmeenItemMatches matches by leading-zero number",
      poCalc.poAmeenItemMatches("0005", ameenSampleItems).map((i) => i.itemNumber),
      ["0005"]
    );
    assertEqual(
      "poAmeenItemMatches matches by name",
      poCalc.poAmeenItemMatches("ازرق", ameenSampleItems).map((i) => i.itemNumber),
      ["0012"]
    );
    assertEqual("poAmeenItemMatches empty query returns all items", poCalc.poAmeenItemMatches("", ameenSampleItems).length, 2);

    // كشف الأصناف المكررة
    assertEqual(
      "poDedupeLines detects duplicate item_key",
      poCalc.poDedupeLines([{ key: "a" }, { key: "b" }, { key: "a" }]).ok,
      false
    );
    assertEqual(
      "poDedupeLines passes distinct keys",
      poCalc.poDedupeLines([{ key: "a" }, { key: "b" }]).ok,
      true
    );

    // حارس انتقالات حالة الفاتورة: التقدم للأمام فقط، لا رجوع من synced أو إلى draft
    assertEqual("poCanTransitionStatus draft->approved", poCalc.poCanTransitionStatus("draft", "approved"), true);
    assertEqual("poCanTransitionStatus draft->synced skip forbidden", poCalc.poCanTransitionStatus("draft", "synced"), false);
    assertEqual("poCanTransitionStatus synced is terminal", poCalc.poCanTransitionStatus("synced", "approved"), false);
    assertEqual("poCanTransitionStatus never back to draft", poCalc.poCanTransitionStatus("approved", "draft"), false);
    assertEqual("poCanTransitionStatus sync_pending<->failed both ways", poCalc.poCanTransitionStatus("sync_pending", "failed"), true);
    assertEqual("poCanTransitionStatus failed->sync_pending", poCalc.poCanTransitionStatus("failed", "sync_pending"), true);
  }
}

// عقد ربط واجهة فواتير المشتريات بملف poCalc ومصدر Supabase الجديد — يمنع رجوع
// الواجهة لاستدعاء أسماء دوال قديمة أُزيلت من supabase-client.js.
for (const contract of [
  "window.poCalc.poRowComputed",
  "window.poCalc.poTotals",
  "poCalc.poValidatePayment",
  "poCalc.poDedupeLines",
  "poCalc.poCanTransitionStatus",
  "dataStore.setPurchaseInvoiceStatus(id, nextStatus)",
  "dataStore.correctPurchaseInvoice(id, note)",
  "dataStore.listItemSnapshots"
]) {
  if (!appJs.includes(contract)) {
    console.error(`Purchase invoice UI/data-layer contract is missing: ${contract}`);
    failed = true;
  }
}
if (appJs.includes("dataStore.updatePurchaseInvoiceStatus")) {
  console.error("src/app.js must not call the removed dataStore.updatePurchaseInvoiceStatus method.");
  failed = true;
}

// عقود SQL فواتير المشتريات: حذف المسودة يقتصر على مالكها، وapproved_by/
// approved_at مقفلان خارج انتقال draft→approved نفسه (مراجعة Codex الثالثة).
const purchaseSql = readFileSync("supabase/purchase-invoices-ameen-sync.sql", "utf8");
for (const contract of [
  "(status = 'draft' and created_by = auth.uid())\n      or purchase_invoices_is_owner()",
  "elsif new.approved_by is distinct from old.approved_by",
  "or new.approved_at is distinct from old.approved_at then"
]) {
  if (!purchaseSql.includes(contract)) {
    console.error(`Purchase invoice SQL contract is missing: ${contract}`);
    failed = true;
  }
}
if (/create policy "purchase_invoices_delete_client"[\s\S]*?using \(\s*status <> 'synced'\s*and \(created_by = auth\.uid\(\) or purchase_invoices_is_owner\(\)\)\s*\);/.test(purchaseSql)) {
  console.error("purchase_invoices_delete_client must not let any authenticated user delete any non-synced invoice — creator must be limited to their own draft.");
  failed = true;
}

// فواتير مشتريات الأمين (موردون/أسعار/تكاليف/إجماليات/دفعات) بيانات حساسة
// ويجب ألا تُكتب في inventory_reports (مقروء لكل موظف مسجّل) — يجب أن تبقى
// حصراً في الجدول المستقل المحمي ameen_purchase_invoice_reports. مراجعة
// Codex السادسة على PR #35.
const pullPurchaseInvoicesScript = readFileSync("tools/pull-purchase-invoices-from-ameen.ps1", "utf8");
if (/rest\/v1\/inventory_reports/.test(pullPurchaseInvoicesScript)) {
  console.error("tools/pull-purchase-invoices-from-ameen.ps1 must write purchase-invoice reports to the protected ameen_purchase_invoice_reports table, not inventory_reports.");
  failed = true;
}
if (!pullPurchaseInvoicesScript.includes("rest/v1/ameen_purchase_invoice_reports")) {
  console.error("tools/pull-purchase-invoices-from-ameen.ps1 is missing its protected-table target ameen_purchase_invoice_reports.");
  failed = true;
}
if (!appJs.includes('.from(purchaseInvoiceReportsTable)') && !readFileSync("src/supabase-client.js", "utf8").includes(".from(purchaseInvoiceReportsTable)")) {
  console.error("src/supabase-client.js must read Ameen purchase-invoice reports from purchaseInvoiceReportsTable, not inventory_reports.");
  failed = true;
}
const supabaseClientJs = readFileSync("src/supabase-client.js", "utf8");
if (/getPurchaseInvoicesAmeenReport[\s\S]{0,400}\.from\(inventoryReportsTable\)/.test(supabaseClientJs)) {
  console.error("getPurchaseInvoicesAmeenReport() must not read from the shared inventoryReportsTable — sensitive supplier/price/cost data would leak to every registered employee.");
  failed = true;
}
const purchaseInvoiceReportsSql = readFileSync("supabase/ameen-purchase-invoice-reports.sql", "utf8");
for (const contract of [
  "alter table ameen_purchase_invoice_reports enable row level security",
  "ameen_purchase_invoice_reports_is_owner()",
  "ameen_purchase_invoice_reports_is_sync_writer()",
  "created_by uuid not null default auth.uid()",
  "created_by = auth.uid()"
]) {
  if (!purchaseInvoiceReportsSql.includes(contract)) {
    console.error(`ameen_purchase_invoice_reports SQL contract is missing: ${contract}`);
    failed = true;
  }
}

// مراجعة Codex السابعة على PR #35: هذا الملف يجب أن يبقى self-contained تماماً —
// لا اعتماد على purchase_invoices_is_owner() ولا على تطبيق
// purchase-invoices-ameen-sync.sql كشرط مسبق، وإلا يتعذّر تطبيقه منفرداً.
if (purchaseInvoiceReportsSql.includes("purchase_invoices_is_owner()")) {
  console.error("supabase/ameen-purchase-invoice-reports.sql must not depend on purchase_invoices_is_owner() — it needs its own self-contained owner function.");
  failed = true;
}
if (purchaseInvoiceReportsSql.includes("purchase-invoices-ameen-sync.sql")) {
  console.error("supabase/ameen-purchase-invoice-reports.sql must not require applying purchase-invoices-ameen-sync.sql first — it must be self-contained.");
  failed = true;
}

// created_by يجب أن يمنع NULL وانتحال الهوية معاً: عمود بقيمة افتراضية auth.uid()،
// وسياسة INSERT تتحقق أن created_by المُرسَل يطابق auth.uid() فعلياً.
if (!/with check \(\s*ameen_purchase_invoice_reports_is_sync_writer\(\)\s*and\s*created_by = auth\.uid\(\)\s*\)/.test(purchaseInvoiceReportsSql)) {
  console.error("ameen_purchase_invoice_reports INSERT policy must require both the sync-writer account and created_by = auth.uid().");
  failed = true;
}

// اختبارات دوال الجرد الشهري المعزولة (src/inventory-recon-calc.js) — نفس نمط poCalc أعلاه.
{
  const invRecCalcSource = readFileSync("src/inventory-recon-calc.js", "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(invRecCalcSource, sandbox, { filename: "inventory-recon-calc.js" });
  const invRecCalc = sandbox.window.invRecCalc;
  if (!invRecCalc) {
    console.error("src/inventory-recon-calc.js did not expose window.invRecCalc.");
    failed = true;
  } else {
    const assertEqual = (label, actual, expected) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) {
        console.error(`invRecCalc test failed: ${label} — got ${a}, expected ${e}`);
        failed = true;
      }
    };

    assertEqual("diffOf increase", invRecCalc.diffOf(10, 12), { diffQty: 2, diffType: "increase" });
    assertEqual("diffOf decrease", invRecCalc.diffOf(10, 7), { diffQty: -3, diffType: "decrease" });
    assertEqual("diffOf match", invRecCalc.diffOf(10, 10), { diffQty: 0, diffType: "none" });
    assertEqual("diffOf empty actual", invRecCalc.diffOf(10, ""), { diffQty: 0, diffType: "none" });
    assertEqual("diffOf missing actual", invRecCalc.diffOf(10, undefined), { diffQty: 0, diffType: "none" });

    assertEqual("settlementValue increase", invRecCalc.settlementValue(2, 5), 10);
    assertEqual("settlementValue decrease", invRecCalc.settlementValue(-3, 5), -15);

    assertEqual(
      "lineComputed reason required and missing",
      invRecCalc.lineComputed({ systemQty: 10, actualQty: 7, unitCost: 5, reason: "" }),
      { diffQty: -3, diffType: "decrease", settlementValue: -15, reasonRequired: true, reasonOk: false }
    );
    assertEqual(
      "lineComputed reason required and provided",
      invRecCalc.lineComputed({ systemQty: 10, actualQty: 7, unitCost: 5, reason: "تلف" }),
      { diffQty: -3, diffType: "decrease", settlementValue: -15, reasonRequired: true, reasonOk: true }
    );
    assertEqual(
      "lineComputed matched line needs no reason",
      invRecCalc.lineComputed({ systemQty: 10, actualQty: 10, unitCost: 5, reason: "" }),
      { diffQty: 0, diffType: "none", settlementValue: 0, reasonRequired: false, reasonOk: true }
    );

    assertEqual(
      "sessionSummary aggregates gain/loss/net",
      invRecCalc.sessionSummary([
        { systemQty: 10, actualQty: 12, unitCost: 5, reason: "زيادة" },
        { systemQty: 10, actualQty: 7, unitCost: 5, reason: "نقص" },
        { systemQty: 10, actualQty: 10, unitCost: 5 }
      ]),
      { totalLines: 3, matchedCount: 1, increaseCount: 1, decreaseCount: 1, gainValue: 10, lossValue: 15, netValue: -5 }
    );

    assertEqual(
      "validateForReview flags missing reasons only",
      invRecCalc.validateForReview([
        { systemQty: 10, actualQty: 7, unitCost: 5, reason: "" },
        { systemQty: 10, actualQty: 10, unitCost: 5, reason: "" }
      ]),
      { ok: false, missingReasonCount: 1 }
    );

    assertEqual("canTransitionStatus draft->reviewed", invRecCalc.canTransitionStatus("draft", "reviewed"), true);
    assertEqual("canTransitionStatus reviewed->approved", invRecCalc.canTransitionStatus("reviewed", "approved"), true);
    assertEqual("canTransitionStatus draft->approved skip forbidden", invRecCalc.canTransitionStatus("draft", "approved"), false);
    assertEqual("canTransitionStatus approved is terminal", invRecCalc.canTransitionStatus("approved", "reviewed"), false);
    assertEqual("canTransitionStatus unknown status rejected", invRecCalc.canTransitionStatus("draft", "synced"), false);

    assertEqual("normalizeSearchText hamza/taa marbuta", invRecCalc.normalizeSearchText("أحمد الشركة"), "احمد الشركه");
    assertEqual(
      "itemMatches tolerant of hamza variants",
      invRecCalc.itemMatches({ itemName: "دخان أبو زياد" }, "ابو زياد"),
      true
    );

    assertEqual(
      "buildIdempotencyKey composes warehouse/month/nonce",
      invRecCalc.buildIdempotencyKey("jumla", "2026-08", "n1"),
      "jumla|2026-08|n1"
    );
  }
}

// عقد ربط واجهة الجرد الشهري بملف invRecCalc ومصدر Supabase الجديد.
for (const contract of [
  "window.invRecCalc.itemMatches",
  "window.invRecCalc.lineComputed",
  "window.invRecCalc.sessionSummary",
  "window.invRecCalc.canTransitionStatus",
  "window.invRecCalc.buildIdempotencyKey",
  "dataStore.createReconSessionWithLines(",
  "dataStore.setReconSessionStatus("
]) {
  if (!appJs.includes(contract)) {
    console.error(`Inventory reconciliation UI/data-layer contract is missing: ${contract}`);
    failed = true;
  }
}

// انحدار: منع الرجوع إلى مخزون النشرة العام عند غياب تقرير مخزون المستودع —
// مراجعة الجولة الثانية على PR الجرد الشهري (نقطة حاسمة). reconAddItem وreconSaveDraft
// يجب أن يعتمدا حصراً على state.reconWarehouseStockItems، لا على أي قائمة أسعار عامة.
{
  const reconAddItemMatch = appJs.match(/function reconAddItem\(key\) \{[\s\S]{0,700}?\n\}/);
  if (!reconAddItemMatch) {
    console.error("reconAddItem() function not found in src/app.js.");
    failed = true;
  } else {
    const body = reconAddItemMatch[0];
    if (!body.includes("state.reconWarehouseStockItems")) {
      console.error("reconAddItem() must build its item list from state.reconWarehouseStockItems only.");
      failed = true;
    }
    if (/state\.(priceItems|reconPriceListItems)\b/.test(body) || /itemCostFor\(.*priceItems/.test(body)) {
      console.error("reconAddItem() must not fall back to the general price-list stock.");
      failed = true;
    }
  }

  const reconSaveDraftMatch = appJs.match(/async function reconSaveDraft\(\) \{[\s\S]{0,300}/);
  if (!reconSaveDraftMatch || !reconSaveDraftMatch[0].includes("reconWarehouseStockItems")) {
    console.error("reconSaveDraft() must guard on state.reconWarehouseStockItems before allowing a save (no warehouse report = no save).");
    failed = true;
  }

  if (!appJs.includes("hasWarehouseStock")) {
    console.error("inventoryRecon() render must gate item-add UI and the save button on a hasWarehouseStock flag.");
    failed = true;
  }
}

// عقد SQL لتصليب RLS/الملكية على الجرد الشهري — مراجعة الجولة الثانية (نقطة حاسمة):
// created_by غير قابل للانتحال، الاعتماد محصور بالمالك، سجل التدقيق trigger-only.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  for (const contract of [
    "inventory_recon_is_owner()",
    "created_by     uuid          references auth.users(id)",
    "created_by لا يمكن تعديله بعد الإنشاء",
    "اعتماد الجلسة محصور بحساب المالك",
    "بلا كمية فعلية أو سبب أو تكلفة معروفة لفرق غير صفري",
    "security definer set search_path = ''",
    "created_by = auth.uid()"
  ]) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql SQL contract is missing: ${contract}`);
      failed = true;
    }
  }
  if (/create policy "authenticated can insert inventory_recon_audit_log"/.test(invReconSql)) {
    console.error("inventory-reconciliation-table.sql must not allow direct client INSERT into inventory_recon_audit_log — trigger-only.");
    failed = true;
  }
}

// عقد SQL — مراجعة الجولة الثالثة (3 نقاط حاسمة): سجل التدقيق بلا FK (وإلا يفشل
// الحذف ويُمحى التاريخ بالـcascade)، اعتماد جلسة بلا سطور مرفوض، كتابة السطور
// محصورة بحالة draft فقط، GRANT صريحة، سحب EXECUTE من دالة SECURITY DEFINER،
// وRPC ذرية لإنشاء الجلسة مع سطورها.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  if (/session_id\s+uuid\s+references inventory_recon_sessions/.test(invReconSql)) {
    console.error("inventory_recon_audit_log.session_id must not carry a foreign key — deleting a session would then either fail (trigger insert after delete) or cascade-erase the audit trail.");
    failed = true;
  }
  if (/line_id\s+uuid\s+references inventory_recon_lines/.test(invReconSql)) {
    console.error("inventory_recon_audit_log.line_id must not carry a foreign key, for the same reason as session_id.");
    failed = true;
  }
  for (const contract of [
    "لا يمكن اعتماد جلسة بلا أي سطر",
    "s.status = 'draft'",
    "revoke execute on function private.inventory_recon_write_audit_log() from public",
    "create or replace function inventory_recon_create_session_with_lines",
    "raise exception 'inventory_recon: لا يمكن إنشاء جلسة جرد بلا سطور'"
  ]) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql SQL contract (round 3) is missing: ${contract}`);
      failed = true;
    }
  }
  if (/s\.status\s*<>\s*'approved'/.test(invReconSql.split("inventory_recon_lines_insert")[1] || "")) {
    console.error("inventory_recon_lines_write policy must gate on status = 'draft', not <> 'approved' — lines must lock as soon as a session leaves draft.");
    failed = true;
  }
  if (/create policy "inventory_recon_lines_write"[\s\S]{0,100}for all/.test(invReconSql)) {
    console.error("inventory_recon_lines write access must not use FOR ALL — permissive RLS would OR it into SELECT and expose raw cost columns to draft creators.");
    failed = true;
  }
  for (const policy of ["inventory_recon_lines_insert", "inventory_recon_lines_update", "inventory_recon_lines_delete"]) {
    if (!invReconSql.includes(`create policy "${policy}"`)) {
      console.error(`inventory reconciliation must define separate ${policy} RLS policy instead of a FOR ALL policy.`);
      failed = true;
    }
  }
}

// انحدار: إنشاء الجلسة وحفظ سطورها يجب أن يمرّا عبر نداء ذرّي واحد (RPC) لا
// طلبين منفصلين — وإلا يترك انقطاع الشبكة بين الطلبين جلسة فارغة بلا سطور.
{
  if (!appJs.includes("createReconSessionWithLines")) {
    console.error("reconSaveDraft() must call dataStore.createReconSessionWithLines(...) — a single atomic call, not separate createReconSession/saveReconLines requests.");
    failed = true;
  }
  if (/dataStore\.createReconSession\(/.test(appJs) || /dataStore\.saveReconLines\(/.test(appJs)) {
    console.error("src/app.js must not call the old separate createReconSession/saveReconLines methods anymore.");
    failed = true;
  }
  const supabaseClientJs = readFileSync("src/supabase-client.js", "utf8");
  if (!/client\.rpc\(\s*["']inventory_recon_create_session_with_lines["']/.test(supabaseClientJs)) {
    console.error("src/supabase-client.js must call the inventory_recon_create_session_with_lines RPC for atomic session+lines creation.");
    failed = true;
  }
}

// عقد SQL — مراجعة الجولة الرابعة (4 نقاط حاسمة): الخادم يشتق system_qty/unit_cost/
// هوية الصنف من تقرير inventory_reports موثوق لا من المتصفح، idempotency محصور
// بـcreated_by مع تحقق تعارض المحتوى، تصليب صلاحيات RPC الرئيسية + نقل دالة التدقيق
// لمخطط private، وقيود CHECK تمنع قيماً سالبة/عملة غير مسموحة/مفتاح أو اسم فارغ.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  for (const contract of [
    "source_report_id",
    "source_report_date",
    "unique (created_by, idempotency_key)",
    "from public.ameen_warehouse_stock_reports",
    "تقرير المخزون المحدد لا يطابق المستودع المختار",
    "الأصناف التالية غير موجودة في تقرير المستودع الموثوق",
    "مفتاح idempotency % مستخدم مسبقاً لجلسة مختلفة",
    "مفتاح idempotency % مستخدم مسبقاً بمحتوى سطور مختلف",
    "create schema if not exists private;",
    "create or replace function private.inventory_recon_write_audit_log()",
    "execute function private.inventory_recon_write_audit_log();",
    "revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from public",
    "revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from anon",
    "grant execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) to authenticated",
    "check (trim(item_key) <> '')",
    "check (trim(item_name) <> '')",
    "check (actual_qty is null or actual_qty >= 0)",
    "check (unit_cost is null or unit_cost >= 0)"
  ]) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql SQL contract (round 4) is missing: ${contract}`);
      failed = true;
    }
  }
  if (/create (or replace )?function inventory_recon_write_audit_log\(\)/.test(invReconSql)) {
    console.error("inventory_recon_write_audit_log() must be defined inside the private schema, not public — plain function name (unqualified) must not remain.");
    failed = true;
  }
}

// انحدار: العميل لا يرسل system_qty/unit_cost/item_number/item_name/unit_name/currency
// كقيم موثوقة إلى الـRPC — الخادم يشتقّها من تقرير المخزون الموثوق. src/supabase-client.js
// يمرّر source_report_id ويبني سطوراً مختزلة فقط (item_key/actual_qty/reason).
{
  const supabaseClientJs = readFileSync("src/supabase-client.js", "utf8");
  const createReconMatch = supabaseClientJs.match(/async createReconSessionWithLines\(input, lines\) \{[\s\S]*?\n    \},/);
  if (!createReconMatch) {
    console.error("src/supabase-client.js: createReconSessionWithLines(input, lines) not found.");
    failed = true;
  } else {
    const body = createReconMatch[0];
    if (!/p_source_report_id:\s*input\.sourceReportId/.test(body)) {
      console.error("createReconSessionWithLines must pass p_source_report_id: input.sourceReportId to the RPC.");
      failed = true;
    }
    for (const clientTrustedField of ["item_number:", "item_name:", "unit_name:", "system_qty:", "unit_cost:", "currency:"]) {
      if (body.includes(clientTrustedField)) {
        console.error(`createReconSessionWithLines must not send client-supplied "${clientTrustedField}" to the RPC — the server derives it from the trusted inventory_reports row.`);
        failed = true;
      }
    }
  }
  if (!/\.select\(\s*["']id, summary, items, created_at["']\s*\)/.test(supabaseClientJs)) {
    console.error("getLatestWarehouseStockReport must select the report's id (needed as source_report_id) alongside summary/items/created_at.");
    failed = true;
  }
}

// انحدار: src/app.js يلتقط id تقرير مخزون المستودع ويمرره كـsourceReportId، ويرفض
// الحفظ إن لم يتوفر تقرير موثوق (لا يُنشئ جلسة بلا مصدر موثوق).
{
  if (!/state\.reconWarehouseStockReportId\s*=\s*report\.id/.test(appJs)) {
    console.error("loadReconWarehouseStock() must capture the trusted report's id into state.reconWarehouseStockReportId.");
    failed = true;
  }
  if (!/sourceReportId:\s*state\.reconWarehouseStockReportId/.test(appJs)) {
    console.error("reconSaveDraft() must pass sourceReportId: state.reconWarehouseStockReportId to dataStore.createReconSessionWithLines(...).");
    failed = true;
  }
  if (!/if \(!state\.reconWarehouseStockReportId\) \{/.test(appJs)) {
    console.error("reconSaveDraft() must guard on state.reconWarehouseStockReportId before allowing a save.");
    failed = true;
  }
}

// عقد SQL — مراجعة الجولة الخامسة (موانع دمج): unit_cost/currency/settlement_value
// محجوبة عن غير المالك عبر RLS owner-only + RPC مقنَّعة، مطابقة التكلفة بـitem_guid
// الحقيقي ثم match_key لا بالاسم وحده، رفض item_key فارغ، تحقق عدد السطور المُدرجة، وسباق idempotency عبر
// ON CONFLICT ذرّي بدل SELECT ثم INSERT منفصلين.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  for (const contract of [
    "using ((select inventory_recon_is_owner()))",
    "create or replace function inventory_recon_lines_for_session(p_session_id uuid)",
    "revoke execute on function inventory_recon_lines_for_session(uuid) from public",
    "revoke execute on function inventory_recon_lines_for_session(uuid) from anon",
    "grant execute on function inventory_recon_lines_for_session(uuid) to authenticated",
    "raise exception 'inventory_recon: % سطر بمفتاح صنف فارغ",
    "on conflict (created_by, idempotency_key) do nothing",
    "raise exception 'inventory_recon: عدد السطور المُدرجة (%) لا يطابق عدد الأصناف المطلوبة"
  ]) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql SQL contract (round 5) is missing: ${contract}`);
      failed = true;
    }
  }
  if (/create policy "inventory_recon_lines_select"[\s\S]{0,80}using \(true\)/.test(invReconSql)) {
    console.error("inventory_recon_lines_select must no longer be using(true) — cost columns (unit_cost/currency/settlement_value) must be owner-only, masked for everyone else via inventory_recon_lines_for_session().");
    failed = true;
  }
  // بعد ترحيل 20260827110325 صار item_costs.item_guid يحمل GUID الأمين الحقيقي فقط،
  // وانتقل مفتاح المطابقة العام (GUID/كود/اسم) إلى match_key. المسار المباشر يبقى هنا
  // على item_guid؛ أما عقد مسارات الرجوع بالكود/الاسم على match_key وعدم انحراف
  // الترحيل عن المخطط فيفرضهما scripts/check-inventory-recon-cost-fallbacks.mjs.
  if (!/where ic1\.item_guid = nullif\(trim\(coalesce\(it ->> 'itemGuid', it ->> 'item_guid', ''\)\), ''\)/.test(invReconSql)) {
    console.error("inventory_recon_create_session_with_lines must match item_costs by the true-GUID column item_guid first (then fall back to match_key), not by item_name alone with LIMIT 1.");
    failed = true;
  }

  const supabaseClientJs = readFileSync("src/supabase-client.js", "utf8");
  if (!/client\.rpc\(\s*["']inventory_recon_lines_for_session["']/.test(supabaseClientJs)) {
    console.error("getReconSession() must fetch lines via the inventory_recon_lines_for_session RPC, not a direct .from(reconLinesTable) select — the owner-only RLS policy would otherwise return an empty line list to non-owner session creators.");
    failed = true;
  }

  // الجولة السادسة: سجل التدقيق يخزّن نسخة كاملة من السطر (unit_cost/currency
  // ضمناً) عبر to_jsonb(NEW) — using(true) على قراءته يسرّب التكلفة لكل
  // authenticated رغم إخفائها في القراءة المقنَّعة. والدالة create_session_with_lines
  // يجب أن تكون SECURITY DEFINER وإلا يفشل موظف غير مالك بقراءة item_costs (تكلفة
  // NULL دائماً) وinventory_recon_lines (فشل تكرار idempotency) بسبب RLS owner-only.
  for (const contract of [
    'create policy "inventory_recon_audit_log_select"',
    "using ((select inventory_recon_is_owner()))"
  ]) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql SQL contract (round 6) is missing: ${contract}`);
      failed = true;
    }
  }
  if (/create policy "inventory_recon_audit_log_select"[\s\S]{0,80}using \(true\)/.test(invReconSql)) {
    console.error("inventory_recon_audit_log_select must no longer be using(true) — audit rows carry full before/after_data including unit_cost/currency, must be owner-only.");
    failed = true;
  }

  // مستشار أداء PostgreSQL: مراجع FK المتكررة تحتاج فهارس، واستدعاءات
  // auth.uid()/owner داخل سياسات RLS يجب أن تكون initplans ثابتة لا أن تُعاد
  // لكل سطر عند كبر بيانات الجرد.
  for (const indexName of [
    "idx_inventory_recon_sessions_source_report",
    "idx_inventory_recon_sessions_reviewed_by",
    "idx_inventory_recon_sessions_approved_by"
  ]) {
    if (!invReconSql.includes(`create index if not exists ${indexName}`)) {
      console.error(`inventory reconciliation performance index is missing: ${indexName}`);
      failed = true;
    }
  }
  const rlsBlock = (invReconSql.split('create policy "inventory_recon_sessions_insert"')[1] || "").split("-- ============================================================\n-- GRANT")[0] || "";
  if (/(?<!select\s)auth\.uid\(\)/.test(rlsBlock)
      || /(?<!select\s)inventory_recon_is_owner\(\)/.test(rlsBlock)) {
    console.error("inventory reconciliation RLS policies must wrap auth.uid() and inventory_recon_is_owner() in SELECT initplans to avoid per-row re-evaluation.");
    failed = true;
  }
  if (!/create or replace function inventory_recon_create_session_with_lines[\s\S]{0,400}security definer/.test(invReconSql)) {
    console.error("inventory_recon_create_session_with_lines must be SECURITY DEFINER — as SECURITY INVOKER, a non-owner caller cannot read item_costs or inventory_recon_lines under owner-only RLS, permanently losing cost data and breaking idempotency retries.");
    failed = true;
  }

  // اختبار قاعدة PostgreSQL الحقيقي كشف أن الوصول المباشر إلى حقل session_id
  // داخل NEW/OLD في trigger مشترك يفشل عند تشغيله على جدول الجلسات لأن record
  // لا يملك ذلك الحقل، حتى لو كان فرع CASE الخاص بالسطور غير مختار. يجب تحويل
  // NEW/OLD إلى JSONB ثم استخراج id/session_id بأمان حسب TG_TABLE_NAME.
  const auditTriggerBlock = (invReconSql.split("create or replace function private.inventory_recon_write_audit_log()")[1] || "").slice(0, 2200);
  if (!/v_row\s*:=\s*coalesce\(v_after,\s*v_before\)/.test(auditTriggerBlock)
      || !/\(v_row\s*->>\s*'session_id'\)::uuid/.test(auditTriggerBlock)
      || /\b(?:NEW|OLD)\.session_id\b/i.test(auditTriggerBlock)) {
    console.error("inventory_recon_write_audit_log must read dynamic trigger records through JSONB; direct NEW/OLD.session_id crashes the sessions trigger at runtime.");
    failed = true;
  }
  if (!/security definer set search_path = ''/.test(auditTriggerBlock)
      || !/insert into public\.inventory_recon_audit_log/.test(auditTriggerBlock)) {
    console.error("private inventory reconciliation audit trigger must use an empty search_path and a fully-qualified public.inventory_recon_audit_log target.");
    failed = true;
  }

  // استدعاء RPC الرئيسي (search_path='') يشغّل triggers السطور ضمن السياق
  // نفسه؛ لذلك أي اسم جدول غير مؤهل داخل حراس الـtrigger يفشل فعلياً برسالة
  // relation does not exist. كل حارس يثبت search_path فارغاً ويؤهل public.*.
  const sessionGuardBlock = (invReconSql.split("create or replace function inventory_recon_guard_immutable()")[1] || "").slice(0, 3800);
  const linesGuardBlock = (invReconSql.split("create or replace function inventory_recon_guard_lines_immutable()")[1] || "").slice(0, 1400);
  if (!/from public\.inventory_recon_lines/.test(sessionGuardBlock)
      || !/public\.inventory_recon_is_owner\(\)/.test(sessionGuardBlock)
      || !/language plpgsql set search_path = ''/.test(sessionGuardBlock)) {
    console.error("inventory_recon_guard_immutable must use an empty search_path and fully-qualified reconciliation objects.");
    failed = true;
  }
  if (!/from public\.inventory_recon_sessions/.test(linesGuardBlock)
      || !/language plpgsql set search_path = ''/.test(linesGuardBlock)
      || !/TG_OP\s*=\s*'DELETE'\s+and\s+session_status\s+is\s+null/.test(linesGuardBlock)) {
    console.error("inventory_recon_guard_lines_immutable must qualify public.inventory_recon_sessions; it runs inside the empty-search-path create-session RPC.");
    failed = true;
  }

  // الجولة السابعة: تشديد الدالتين SECURITY DEFINER — search_path فارغ بدل
  // "public" (لا اسم مخطط ثابت قابل للاعتراض)، ورفض صريح لـauth.uid() null
  // بدل الاعتماد الضمني فقط على revoke execute from anon.
  const linesForSessionBlock = (invReconSql.split("create or replace function inventory_recon_lines_for_session")[1] || "").slice(0, 1600);
  if (!/security definer\s*\nset search_path = ''/.test(linesForSessionBlock)) {
    console.error("inventory_recon_lines_for_session must use SET search_path = '' (empty), not a named schema — Supabase best practice for SECURITY DEFINER functions to prevent search_path hijacking.");
    failed = true;
  }
  if (!/auth\.uid\(\) is null/.test(linesForSessionBlock)) {
    console.error("inventory_recon_lines_for_session must explicitly reject auth.uid() is null before touching session/line data.");
    failed = true;
  }

  const createSessionBlock = (invReconSql.split("create or replace function inventory_recon_create_session_with_lines")[1] || "").slice(0, 8000);
  if (!/security definer\s*\nset search_path = ''/.test(createSessionBlock)) {
    console.error("inventory_recon_create_session_with_lines must use SET search_path = '' (empty), not a named schema — Supabase best practice for SECURITY DEFINER functions to prevent search_path hijacking.");
    failed = true;
  }
  if (!/auth\.uid\(\) is null/.test(createSessionBlock)) {
    console.error("inventory_recon_create_session_with_lines must explicitly reject auth.uid() is null before creating a session.");
    failed = true;
  }
  if (!/trim_scale\(nullif\(line\s*->>\s*'actual_qty',\s*''\)::numeric\)::text/.test(createSessionBlock)
      || !/trim_scale\(actual_qty\)::text/.test(createSessionBlock)) {
    console.error("inventory reconciliation idempotency digests must canonicalize numeric scale; otherwise input 8 mismatches stored numeric(18,3) text 8.000 on an identical retry.");
    failed = true;
  }
  if (/[^.]\bfrom inventory_recon_lines\b|[^.]\bfrom inventory_recon_sessions\b|[^.]\bfrom inventory_reports\b|[^.]\bfrom item_costs\b|[^.]\binsert into inventory_recon_lines\b|[^.]\binsert into inventory_recon_sessions\b/.test(createSessionBlock)) {
    console.error("inventory_recon_create_session_with_lines must fully qualify every relation with the public. prefix (search_path is now empty, so unqualified names would fail to resolve or silently resolve to the wrong schema).");
    failed = true;
  }
}

// اختبار setReconSessionStatus (src/supabase-client.js): بعد سحب GRANT المباشر
// من authenticated (مراجعة PR-38-review-2)، يجب أن يستدعي RPC
// inventory_recon_set_status حصراً، لا .from(reconSessionsTable).update(...).
// نتأكد من نجاح الاستدعاء الصحيح، ورمي خطأ صريح عندما ترجع RPC خطأً (مثلاً
// الحالة تغيّرت فعلاً — expected_status لم يعد مطابقاً).
{
  const supabaseClientSource = readFileSync("src/supabase-client.js", "utf8");

  if (/\.from\(reconSessionsTable\)\s*\n\s*\.update\(/.test(supabaseClientSource)) {
    console.error("setReconSessionStatus must not write directly via .from(reconSessionsTable).update(...) — authenticated no longer holds UPDATE grant on inventory_recon_sessions; it must call the inventory_recon_set_status RPC.");
    failed = true;
  }
  if (!/client\.rpc\(\s*["']inventory_recon_set_status["']/.test(supabaseClientSource)) {
    console.error("setReconSessionStatus must call the inventory_recon_set_status RPC.");
    failed = true;
  }

  function makeMockClient(rpcResult) {
    let lastRpcCall = null;
    return {
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "u1", email: "owner@ozk.test" } } }, error: null }),
        getUser: async () => ({ data: { user: { id: "u1", email: "owner@ozk.test" } }, error: null })
      },
      rpc(name, params) {
        lastRpcCall = { name, params };
        return Promise.resolve(rpcResult).then((r) => { r.__lastRpcCall = lastRpcCall; return r; });
      }
    };
  }

  async function runSetReconSessionStatus(rpcResult) {
    let capturedClient;
    const sandbox = {
      window: {
        appConfig: { supabase: { url: "https://x.test", publishableKey: "key" } },
        supabase: { createClient: () => (capturedClient = makeMockClient(rpcResult)) },
        invRecCalc: sandbox_invRecCalc
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(supabaseClientSource, sandbox, { filename: "supabase-client.js" });
    await sandbox.window.tobaccoData.setReconSessionStatus("s1", "reviewed", "draft");
    return capturedClient;
  }

  const invRecCalcSourceForGuard = readFileSync("src/inventory-recon-calc.js", "utf8");
  const guardSandbox = { window: {}, console };
  vm.createContext(guardSandbox);
  vm.runInContext(invRecCalcSourceForGuard, guardSandbox, { filename: "inventory-recon-calc.js" });
  const sandbox_invRecCalc = guardSandbox.window.invRecCalc;

  let succeeded = false;
  try {
    await runSetReconSessionStatus({ data: { id: "s1", status: "reviewed" }, error: null });
    succeeded = true;
  } catch (err) {
    console.error(`setReconSessionStatus should succeed when the RPC reports success: ${err.message}`);
    failed = true;
  }
  if (!succeeded) failed = true;

  let blocked = false;
  try {
    await runSetReconSessionStatus({
      data: null,
      error: { message: "inventory_recon_set_status: تعذّر تحديث حالة الجلسة" }
    });
  } catch {
    blocked = true;
  }
  if (!blocked) {
    console.error("setReconSessionStatus must throw when the inventory_recon_set_status RPC returns an error (stale expected_status / silent RLS block) instead of succeeding silently.");
    failed = true;
  }
}

// اختبار GRANT الضيق الجديد (مراجعة PR-38-review-2): authenticated يملك SELECT
// فقط على الجدولين، وكل كتابة يجب أن تمر عبر RPC بـSECURITY DEFINER.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");

  if (/grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+inventory_recon_sessions\s+to\s+authenticated/.test(invReconSql)
      || /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+inventory_recon_lines\s+to\s+authenticated/.test(invReconSql)) {
    console.error("inventory-reconciliation-table.sql must not grant insert/update/delete on inventory_recon_sessions/inventory_recon_lines to authenticated directly — every mutation must go through a SECURITY DEFINER RPC.");
    failed = true;
  }
  const grantContracts = [
    "revoke all privileges on table",
    "inventory_recon_sessions,",
    "inventory_recon_lines,",
    "inventory_recon_audit_log",
    "from anon, authenticated",
    "grant select on inventory_recon_sessions to authenticated",
    "grant select on inventory_recon_lines to authenticated"
  ];
  for (const contract of grantContracts) {
    if (!invReconSql.includes(contract)) {
      console.error(`inventory-reconciliation-table.sql GRANT-narrowing contract is missing: ${contract}`);
      failed = true;
    }
  }

  const setStatusBlock = (invReconSql.split("create or replace function inventory_recon_set_status")[1] || "").slice(0, 2500);
  if (!setStatusBlock) {
    console.error("supabase/inventory-reconciliation-table.sql is missing inventory_recon_set_status RPC.");
    failed = true;
  } else {
    if (!/security definer\s*\nset search_path = ''/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must use SECURITY DEFINER with SET search_path = '' (empty).");
      failed = true;
    }
    if (!/:=\s*auth\.uid\(\)/.test(setStatusBlock) || !/v_uid is null/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must capture auth.uid() and explicitly reject a null caller.");
      failed = true;
    }
    // القفل يتم عبر FOR UPDATE قبل قراءة الصف، ثم تحقق صريح من p_expected_status
    // يرمي استثناءً عند أي تعارض (بديل أكثر وضوحاً من شرط WHERE صامت يرجع صف
    // فارغ)، ويقفل صلاحية الانتقال (draft→reviewed للمنشئ/المالك،
    // reviewed→approved للمالك فقط) داخل الدالة نفسها كخط دفاع أول — مكرَّرة
    // باستقلالية داخل inventory_recon_guard_immutable (SEE trigger block below)
    // لأن الدالة SECURITY DEFINER ولا يجوز الاعتماد على RLS وحدها.
    if (!/for update/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must lock the session row with FOR UPDATE before checking status/ownership.");
      failed = true;
    }
    if (!/v_session\.status\s*<>\s*p_expected_status/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must explicitly verify the locked row's status against p_expected_status and reject any other transition.");
      failed = true;
    }
    if (!/v_session\.created_by\s*=\s*v_uid\s+or\s+v_is_owner/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must allow draft→reviewed only for the draft's creator or the owner.");
      failed = true;
    }
    if (!/not\s+v_is_owner/.test(setStatusBlock)) {
      console.error("inventory_recon_set_status must allow reviewed→approved only for the owner.");
      failed = true;
    }
  }

  // نفس فحوصات التفويض يجب أن تتكرر باستقلالية داخل inventory_recon_guard_immutable
  // (التريغر) — دفاع مستقل لأن الدالة أعلاه SECURITY DEFINER ولا يجوز
  // الاعتماد على RLS وحدها لمنع تجاوز الصلاحيات.
  const guardImmutableBlock = (invReconSql.split("create or replace function inventory_recon_guard_immutable()")[1] || "").slice(0, 4000);
  if (!guardImmutableBlock) {
    console.error("supabase/inventory-reconciliation-table.sql is missing inventory_recon_guard_immutable().");
    failed = true;
  } else {
    if (!/OLD\.created_by\s*=\s*auth\.uid\(\)\s+or\s+public\.inventory_recon_is_owner\(\)/.test(guardImmutableBlock)) {
      console.error("inventory_recon_guard_immutable must independently check draft→reviewed authorization (creator or owner) — it must not rely on inventory_recon_set_status alone.");
      failed = true;
    }
    if (!/not public\.inventory_recon_is_owner\(\)/.test(guardImmutableBlock)) {
      console.error("inventory_recon_guard_immutable must independently check reviewed→approved authorization (owner only) — it must not rely on inventory_recon_set_status alone.");
      failed = true;
    }
  }
  if (!/revoke execute on function inventory_recon_set_status\(uuid, text, text\) from public/.test(invReconSql)
      || !/revoke execute on function inventory_recon_set_status\(uuid, text, text\) from anon/.test(invReconSql)
      || !/grant execute on function inventory_recon_set_status\(uuid, text, text\) to authenticated/.test(invReconSql)) {
    console.error("inventory_recon_set_status must be revoked from public/anon and granted only to authenticated.");
    failed = true;
  }
}

// اختبار بصمة محتوى المسودة (buildDraftFingerprint) وإعادة استعمال idempotency
// key عبر reconSaveDraft عند إعادة المحاولة بنفس المحتوى.
{
  const invRecCalcSource = readFileSync("src/inventory-recon-calc.js", "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(invRecCalcSource, sandbox, { filename: "inventory-recon-calc.js" });
  const invRecCalc = sandbox.window.invRecCalc;

  const draftA = {
    userId: "user-1",
    sourceReportId: "report-1",
    warehouseKey: "jumla",
    sessionDate: "2026-08-01",
    sessionMonth: "2026-08-01",
    notes: "ملاحظة",
    rows: [{ itemKey: "k1", actualQty: "10", reason: "تلف" }]
  };
  const fpA1 = invRecCalc.buildDraftFingerprint(draftA);
  const fpA2 = invRecCalc.buildDraftFingerprint(JSON.parse(JSON.stringify(draftA)));
  if (fpA1 !== fpA2) {
    console.error("buildDraftFingerprint must be stable for identical draft content across separate calls (needed to reuse the same idempotency key on retry).");
    failed = true;
  }

  const draftB = { ...draftA, rows: [{ itemKey: "k1", actualQty: "11", reason: "تلف" }] };
  const fpB = invRecCalc.buildDraftFingerprint(draftB);
  if (fpA1 === fpB) {
    console.error("buildDraftFingerprint must change when the actual draft content changes (actualQty here), otherwise a real content change would wrongly reuse a stale idempotency key.");
    failed = true;
  }

  // بصمتان بنفس محتوى السطور لكن بمستخدمين مختلفين يجب ألا تتطابقا — وإلا
  // أعاد مستخدم استعمال idempotency key محفوظ لمستخدم آخر على نفس الجهاز.
  const draftDifferentUser = { ...draftA, userId: "user-2" };
  const fpDifferentUser = invRecCalc.buildDraftFingerprint(draftDifferentUser);
  if (fpA1 === fpDifferentUser) {
    console.error("buildDraftFingerprint must differ across different userId values with otherwise-identical content.");
    failed = true;
  }

  // نفس المنطق لتقرير المخزون المصدر: تقريران مختلفان بنفس محتوى السطور يجب
  // أن يُنتجا بصمتين مختلفتين.
  const draftDifferentReport = { ...draftA, sourceReportId: "report-2" };
  const fpDifferentReport = invRecCalc.buildDraftFingerprint(draftDifferentReport);
  if (fpA1 === fpDifferentReport) {
    console.error("buildDraftFingerprint must differ across different sourceReportId values with otherwise-identical content.");
    failed = true;
  }

  // تطبيع الأرقام: "8" و"8.000" يجب أن ينتجا نفس البصمة.
  const draftNumericA = { ...draftA, rows: [{ itemKey: "k1", actualQty: "8", reason: "تلف" }] };
  const draftNumericB = { ...draftA, rows: [{ itemKey: "k1", actualQty: "8.000", reason: "تلف" }] };
  if (invRecCalc.buildDraftFingerprint(draftNumericA) !== invRecCalc.buildDraftFingerprint(draftNumericB)) {
    console.error("buildDraftFingerprint must normalize numeric actualQty so \"8\" and \"8.000\" produce the same fingerprint.");
    failed = true;
  }

  const appJs = readFileSync("src/app.js", "utf8");
  const reconSaveDraftBody = (appJs.split("async function reconSaveDraft() {")[1] || "").split("\nasync function reconSetStatus")[0];
  if (!/buildDraftFingerprint/.test(reconSaveDraftBody)) {
    console.error("reconSaveDraft() must build a content fingerprint via window.invRecCalc.buildDraftFingerprint(...) to support idempotency-key reuse across retries/reloads.");
    failed = true;
  }
  if (!/userId,\s*\n\s*sourceReportId:/.test(reconSaveDraftBody)) {
    console.error("reconSaveDraft() must pass userId and sourceReportId into buildDraftFingerprint(...).");
    failed = true;
  }
  if (!/pending\.fingerprint === fingerprint/.test(reconSaveDraftBody)) {
    console.error("reconSaveDraft() must reuse the previously persisted idempotency key only when the stored fingerprint matches the current draft content.");
    failed = true;
  }
  if (!/localStorage\.removeItem\(pendingKey\)/.test(reconSaveDraftBody)) {
    console.error("reconSaveDraft() must clear the persisted pending idempotency key only after the save RPC call succeeds.");
    failed = true;
  }

  if (!/function reconPendingSaveKey\(userId\) \{\s*\n\s*return `\$\{RECON_PENDING_SAVE_KEY_PREFIX\}:\$\{userId \|\| "anon"\}`;/.test(appJs)) {
    console.error("reconPendingSaveKey(userId) must namespace the localStorage idempotency key per user (RECON_PENDING_SAVE_KEY_PREFIX:<userId|anon>) so two users on the same device/browser never share a pending idempotency key.");
    failed = true;
  }
  if (!/const pendingKey = reconPendingSaveKey\(userId\);/.test(reconSaveDraftBody)) {
    console.error("reconSaveDraft() must derive its localStorage key via reconPendingSaveKey(userId), not a single device-wide constant.");
    failed = true;
  }
}

// اختبارات سلوكية لصلاحيات inventory_recon_set_status وinventory_recon_delete_draft
// — نحاكي منطق التفويض المكتوب بـPL/pgSQL بمحاكاة JS مطابقة للشروط الفعلية
// بالملف SQL (قفل الصف FOR UPDATE، قراءة created_by/status، ثم المقارنة)، لأن
// الدوال الحقيقية SECURITY DEFINER لا يمكن تنفيذها هنا بلا اتصال Postgres حي.
{
  const invReconSql = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  const OWNER_EMAIL = "owner@ozk.test";

  // محاكاة inventory_recon_set_status: draft→reviewed مسموح فقط لمنشئ
  // المسودة أو المالك؛ reviewed→approved مسموح فقط للمالك.
  function simulateSetStatus({ callerUid, callerEmail, session, nextStatus, expectedStatus }) {
    if (!callerUid) throw new Error("auth.uid() is null");
    if (session.status !== expectedStatus) throw new Error("stale expected_status");
    const isOwner = callerEmail === OWNER_EMAIL;
    if (nextStatus === "reviewed") {
      if (session.status !== "draft") throw new Error("invalid transition");
      if (!isOwner && callerUid !== session.created_by) throw new Error("not authorized: only the draft creator or the owner may review it");
      return { ...session, status: "reviewed" };
    }
    if (nextStatus === "approved") {
      if (session.status !== "reviewed") throw new Error("invalid transition");
      if (!isOwner) throw new Error("not authorized: only the owner may approve");
      return { ...session, status: "approved" };
    }
    throw new Error("invalid transition");
  }

  const draftSession = { id: "s1", status: "draft", created_by: "creator-uid" };

  let blockedOtherUserReview = false;
  try {
    simulateSetStatus({ callerUid: "other-uid", callerEmail: "other@ozk.test", session: draftSession, nextStatus: "reviewed", expectedStatus: "draft" });
  } catch {
    blockedOtherUserReview = true;
  }
  if (!blockedOtherUserReview) {
    console.error("Behavioral: a user who is neither the draft's creator nor the owner must not be able to move a draft session to reviewed.");
    failed = true;
  }

  let creatorReviewed = null;
  try {
    creatorReviewed = simulateSetStatus({ callerUid: "creator-uid", callerEmail: "creator@ozk.test", session: draftSession, nextStatus: "reviewed", expectedStatus: "draft" });
  } catch (err) {
    console.error(`Behavioral: the draft's own creator must be able to move it to reviewed: ${err.message}`);
    failed = true;
  }
  if (creatorReviewed?.status !== "reviewed") failed = true;

  const reviewedSession = { id: "s1", status: "reviewed", created_by: "creator-uid" };
  let ownerApproved = null;
  try {
    ownerApproved = simulateSetStatus({ callerUid: "owner-uid", callerEmail: OWNER_EMAIL, session: reviewedSession, nextStatus: "approved", expectedStatus: "reviewed" });
  } catch (err) {
    console.error(`Behavioral: the owner must be able to approve a reviewed session: ${err.message}`);
    failed = true;
  }
  if (ownerApproved?.status !== "approved") failed = true;

  let blockedNonOwnerApprove = false;
  try {
    simulateSetStatus({ callerUid: "creator-uid", callerEmail: "creator@ozk.test", session: reviewedSession, nextStatus: "approved", expectedStatus: "reviewed" });
  } catch {
    blockedNonOwnerApprove = true;
  }
  if (!blockedNonOwnerApprove) {
    console.error("Behavioral: a non-owner (even the draft's own creator) must not be able to approve a reviewed session.");
    failed = true;
  }

  // محاكاة inventory_recon_delete_draft: حذف مسموح فقط لـstatus='draft' ولمنشئ
  // المسودة أو المالك.
  function simulateDeleteDraft({ callerUid, callerEmail, session }) {
    if (!callerUid) throw new Error("auth.uid() is null");
    if (session.status !== "draft") throw new Error("only draft sessions may be deleted");
    const isOwner = callerEmail === OWNER_EMAIL;
    if (!isOwner && callerUid !== session.created_by) throw new Error("not authorized: only the draft creator or the owner may delete it");
    return true;
  }

  let creatorDeleted = false;
  try {
    creatorDeleted = simulateDeleteDraft({ callerUid: "creator-uid", callerEmail: "creator@ozk.test", session: draftSession });
  } catch (err) {
    console.error(`Behavioral: the draft's own creator must be able to delete their own draft: ${err.message}`);
    failed = true;
  }
  if (!creatorDeleted) failed = true;

  let blockedOtherUserDelete = false;
  try {
    simulateDeleteDraft({ callerUid: "other-uid", callerEmail: "other@ozk.test", session: draftSession });
  } catch {
    blockedOtherUserDelete = true;
  }
  if (!blockedOtherUserDelete) {
    console.error("Behavioral: a user who is neither the draft's creator nor the owner must not be able to delete someone else's draft.");
    failed = true;
  }

  let blockedReviewedDelete = false;
  try {
    simulateDeleteDraft({ callerUid: "owner-uid", callerEmail: OWNER_EMAIL, session: reviewedSession });
  } catch {
    blockedReviewedDelete = true;
  }
  if (!blockedReviewedDelete) {
    console.error("Behavioral: a reviewed session must never be deletable, even by the owner.");
    failed = true;
  }

  const approvedSession = { id: "s1", status: "approved", created_by: "creator-uid" };
  let blockedApprovedDelete = false;
  try {
    simulateDeleteDraft({ callerUid: "owner-uid", callerEmail: OWNER_EMAIL, session: approvedSession });
  } catch {
    blockedApprovedDelete = true;
  }
  if (!blockedApprovedDelete) {
    console.error("Behavioral: an approved session must never be deletable, even by the owner.");
    failed = true;
  }

  // نتأكد أن الملف SQL فعلاً ينفّذ نفس شروط التفويض التي حاكيناها أعلاه — لا
  // تعتمد على RLS وحدها بما أن الدوال SECURITY DEFINER.
  const deleteDraftBlock = (invReconSql.split("create or replace function inventory_recon_delete_draft")[1] || "").slice(0, 2500);
  if (!deleteDraftBlock) {
    console.error("supabase/inventory-reconciliation-table.sql is missing inventory_recon_delete_draft RPC.");
    failed = true;
  } else {
    if (!/for update/.test(deleteDraftBlock)) {
      console.error("inventory_recon_delete_draft must lock the session row with FOR UPDATE before deleting.");
      failed = true;
    }
    if (!/status\s*<>\s*'draft'|status\s*!=\s*'draft'/.test(deleteDraftBlock) && !/if\s+v_status\s*<>\s*'draft'/i.test(deleteDraftBlock)) {
      console.error("inventory_recon_delete_draft must reject deletion unless the session status is 'draft'.");
      failed = true;
    }
    if (!/security definer\s*\nset search_path = ''/.test(deleteDraftBlock)) {
      console.error("inventory_recon_delete_draft must use SECURITY DEFINER with SET search_path = '' (empty).");
      failed = true;
    }
  }
  if (!/revoke execute on function inventory_recon_delete_draft\(uuid\) from public/.test(invReconSql)
      || !/revoke execute on function inventory_recon_delete_draft\(uuid\) from anon/.test(invReconSql)
      || !/grant execute on function inventory_recon_delete_draft\(uuid\) to authenticated/.test(invReconSql)) {
    console.error("inventory_recon_delete_draft must be revoked from public/anon and granted only to authenticated.");
    failed = true;
  }

  const supabaseClientSourceForDelete = readFileSync("src/supabase-client.js", "utf8");
  if (!/client\.rpc\(\s*["']inventory_recon_delete_draft["']/.test(supabaseClientSourceForDelete)) {
    console.error("src/supabase-client.js must expose a deleteReconDraft(...) wrapper calling the inventory_recon_delete_draft RPC.");
    failed = true;
  }

  if (!/data-action="recon-delete"/.test(appJs)) {
    console.error("src/app.js must render a delete button (data-action=\"recon-delete\") for draft sessions.");
    failed = true;
  }
  if (!/async function reconDeleteDraft\(session\) \{[\s\S]{0,200}confirm\(/.test(appJs)) {
    console.error("reconDeleteDraft() must ask for user confirmation via confirm(...) before deleting.");
    failed = true;
  }
}

// ── الجرد الشهري: مستودعات ديناميكية من الأمين (لا "جملة"/"مركز" ثابتة) ────────
{
  const appJsForWarehouses = readFileSync("src/app.js", "utf8");

  // (a) امنع رجوع خياري "جملة"/"مركز" الثابتين داخل منطقة اختيار مستودع الجرد
  // تحديداً — لا نمنع النص بكامل الملف لأن "jumla" تُستخدم بمعنى مختلف تماماً
  // بميزات أخرى (وضع البيع jumla/mufrak، وسلسلة فواتير المبيعات بالأمين).
  const warehouseUiMatch = appJsForWarehouses.match(
    /const warehouseButtonsHtml[\s\S]{0,700}/
  );
  if (!warehouseUiMatch) {
    console.error("Could not locate the recon warehouse-buttons render block in src/app.js.");
    failed = true;
  } else {
    const warehouseUiRegion = warehouseUiMatch[0];
    if (/["'`](جملة|مركز|jumla|markaz)["'`]/i.test(warehouseUiRegion)) {
      console.error("Recon warehouse selector must not contain hardcoded جملة/مركز (jumla/markaz) options — warehouses must come from state.reconWarehouses only.");
      failed = true;
    }
    if (!/state\.reconWarehouses\.map/.test(warehouseUiRegion)) {
      console.error("Recon warehouse selector must render from state.reconWarehouses (dynamic list), not a static list.");
      failed = true;
    }
  }

  // (b) المفتاح الموثوق لاختيار المستودع هو GUID، وليس اسماً مخترَعاً
  if (!/data-recon-warehouse="\$\{escapeHtml\(w\.warehouseKey\)\}"/.test(appJsForWarehouses)) {
    console.error("Recon warehouse buttons must key off w.warehouseKey (Ameen st000 GUID), not an invented sale-type label.");
    failed = true;
  }
  if (!/async function loadReconWarehouses\(\)/.test(appJsForWarehouses)
      || !/dataStore\.listReconWarehouses/.test(appJsForWarehouses)) {
    console.error("src/app.js must load real warehouses via dataStore.listReconWarehouses() (Ameen-derived), not a hardcoded array.");
    failed = true;
  }

  const supabaseClientForWarehouses = readFileSync("src/supabase-client.js", "utf8");
  if (!/async listReconWarehouses\(\)/.test(supabaseClientForWarehouses)
      || !/\.from\(warehouseStockReportsTable\)/.test(supabaseClientForWarehouses)) {
    console.error("supabase-client.js listReconWarehouses() must derive warehouses from the dedicated ameen_warehouse_stock_reports table, not a static list.");
    failed = true;
  }
  if (!/warehouseKey:\s*key,\s*warehouseName:\s*name/.test(supabaseClientForWarehouses.replace(/\s+/g, " "))) {
    console.error("listReconWarehouses() must expose {warehouseKey, warehouseName} pairs sourced from each report's summary (GUID + display name).");
    failed = true;
  }

  // (c) تقرير مستقل لكل مستودع فعلي — لا دمج كل المستودعات بتقرير واحد
  const warehouseStockScript = readFileSync("tools/push-ameen-warehouse-stock.ps1", "utf8");
  if (!/foreach\s*\(\$s in \$stores\)\s*\{[\s\S]{0,600}ameen_warehouse_stock_reports/.test(warehouseStockScript)) {
    console.error("push-ameen-warehouse-stock.ps1 must POST one ameen_warehouse_stock_reports row per warehouse inside its foreach($s in $stores) loop.");
    failed = true;
  }
  if (!/warehouseKey\s*=\s*\$s\.guid/.test(warehouseStockScript)
      || !/warehouseName\s*=\s*\$s\.name/.test(warehouseStockScript)) {
    console.error("push-ameen-warehouse-stock.ps1 must tag each report's summary with warehouseKey (GUID) and warehouseName.");
    failed = true;
  }
  const warehouseStockCodeLines = warehouseStockScript
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  if (/["'](جملة|مركز عام|jumla|markaz)["']/i.test(warehouseStockCodeLines)) {
    console.error("push-ameen-warehouse-stock.ps1 must not invent a جملة/مركز warehouse — only real dbo.st000 rows.");
    failed = true;
  }

  // (c2) مراجعة Codex على PR #40: مادتان مختلفتان بالأمين قد تتطابقان بعد
  // Normalize-ItemName (فرق علامات ترقيم فقط) فتنتجان itemKey واحداً — الواجهة تُخفي
  // إحداهما (تصفية "already" على itemKey)، وقيد unique(session_id, item_key) بالجرد
  // الفعلي يمنع حفظ كليهما بجلسة واحدة. يجب تمييز أي مجموعة متصادمة بمفتاح فريد
  // مشتق من itemGuid (لا يتصادم أبداً) قبل الرفع.
  if (!/Group-Object\s+-Property\s+itemKey/.test(warehouseStockScript)) {
    console.error("push-ameen-warehouse-stock.ps1 must detect itemKey collisions per store (Group-Object -Property itemKey) before uploading.");
    failed = true;
  }
  if (!/\$it\.itemKey\s*=\s*"\$\(\$it\.itemKey\)_\$guidSuffix"/.test(warehouseStockScript)) {
    console.error("push-ameen-warehouse-stock.ps1 must namespace colliding itemKey values with a suffix derived from itemGuid.");
    failed = true;
  }

  // (d) قراءة فقط من الأمين — بلا أي تعديل على المخزون أو الأسعار أو الحسابات
  const sqlBlockMatch = warehouseStockScript.match(/\$sql = @'([\s\S]*?)'@/);
  const ameenSqlBody = sqlBlockMatch ? sqlBlockMatch[1] : warehouseStockScript;
  if (/\b(insert\s+into|update\s+dbo|delete\s+from|merge\s+into|exec\s)/i.test(ameenSqlBody)) {
    console.error("push-ameen-warehouse-stock.ps1's Ameen SQL must be strictly read-only (SELECT only) — no INSERT/UPDATE/DELETE/MERGE/EXEC.");
    failed = true;
  }
  if (!/^\s*with per_store as/i.test(ameenSqlBody.trim()) && !/^\s*select/i.test(ameenSqlBody.trim())) {
    console.error("push-ameen-warehouse-stock.ps1's Ameen SQL must start with a read-only SELECT/CTE.");
    failed = true;
  }

  // ملف push-inventory-reconciliation-to-ameen.ps1 يجب أن يبقى مقفلاً — لا كتابة فعلية على الأمين
  const pushToAmeenPath = "tools/push-inventory-reconciliation-to-ameen.ps1";
  if (existsSync(pushToAmeenPath)) {
    const pushToAmeenScript = readFileSync(pushToAmeenPath, "utf8");
    if (!/exit\s+1/.test(pushToAmeenScript)) {
      console.error(`${pushToAmeenPath} must remain a locked/disabled stub (exit 1) — inventory reconciliation must never write back to Ameen.`);
      failed = true;
    }
  }

  // (e) مراجعة Codex على PR #40، مانع 1: source='ameen_warehouse_stock' وحده
  // لا يكفي — يجب التحقق من created_by المخزَّن فعلياً بالصف، عبر auth.users،
  // وليس عبر أي قيمة يرسلها العميل.
  const invReconSqlForTrust = readFileSync("supabase/inventory-reconciliation-table.sql", "utf8");
  if (!/create or replace function inventory_recon_warehouse_stock_report_is_trusted\(p_created_by uuid\)/.test(invReconSqlForTrust)) {
    console.error("inventory-reconciliation-table.sql is missing inventory_recon_warehouse_stock_report_is_trusted(uuid) — the source report's created_by must be verified against the trusted sync account, not trusted from source= alone.");
    failed = true;
  }
  if (!/p_created_by\s*=\s*'9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid/.test(invReconSqlForTrust)
      || invReconSqlForTrust.includes("REPLACE_WITH_SYNC_ACCOUNT_EMAIL")) {
    console.error("inventory_recon_warehouse_stock_report_is_trusted() must compare created_by with the committed sync-account UUID and contain no placeholder.");
    failed = true;
  }
  const createSessionBodyForTrust = (invReconSqlForTrust.split("create or replace function inventory_recon_create_session_with_lines")[1] || "").slice(0, 6000);
  if (!/into v_report_date, v_report_summary, v_report_items, v_report_created_by, v_report_created_at/.test(createSessionBodyForTrust)) {
    console.error("inventory_recon_create_session_with_lines must select created_by/created_at from inventory_reports, not just report_date/summary/items.");
    failed = true;
  }
  if (!/if not public\.inventory_recon_warehouse_stock_report_is_trusted\(v_report_created_by\) then/.test(createSessionBodyForTrust)) {
    console.error("inventory_recon_create_session_with_lines must reject any source report whose created_by is not the trusted sync account — source='ameen_warehouse_stock' alone is spoofable by any authenticated employee.");
    failed = true;
  }

  // (f) مراجعة Codex على PR #40، مانع 2: فحص حداثة التقرير (24 ساعة) يجب أن
  // يُطبَّق داخل RPC على الخادم — فحص الواجهة إضافي فقط وليس كافياً وحده.
  if (!/v_report_freshness_at\s*:=\s*coalesce\(v_report_generated_at, v_report_created_at\)/.test(createSessionBodyForTrust)) {
    console.error("inventory_recon_create_session_with_lines must derive report freshness server-side from summary.generated_at or created_at — not trust a client-sent freshness flag.");
    failed = true;
  }
  if (!/v_report_freshness_at is null or v_report_freshness_at < now\(\) - interval '24 hours'/.test(createSessionBodyForTrust)) {
    console.error("inventory_recon_create_session_with_lines must reject a source report older than 24 hours server-side, inside the RPC.");
    failed = true;
  }

  // (g) مراجعة Codex على PR #40، commit 84b74de، مانع P1: source_report_id
  // يجب أن يشير بالمفتاح الأجنبي إلى ameen_warehouse_stock_reports (مصدر RPC
  // الفعلي) وليس إلى inventory_reports القديم — وإلا يفشل حفظ كل جلسة جرد
  // جديدة بخطأ foreign-key-violation لأن معرّف التقرير الجديد لن يوجد أصلاً
  // بالجدول القديم. كما يجب أن تتوفر migration آمنة لإعادة التطبيق (idempotent)
  // على قاعدة سبق تطبيقها بالصيغة القديمة، بلا اعتماد على تطابق UUID مصادفةً.
  if (/references inventory_reports\(id\)/.test(invReconSqlForTrust)) {
    console.error("inventory-reconciliation-table.sql must not reference inventory_reports(id) anywhere for source_report_id — the RPC now sources warehouse-stock reports from ameen_warehouse_stock_reports.");
    failed = true;
  }
  if (!/source_report_id\s+uuid\s+references ameen_warehouse_stock_reports\(id\) on delete set null/.test(invReconSqlForTrust)) {
    console.error("inventory_recon_sessions.source_report_id must reference ameen_warehouse_stock_reports(id) on delete set null.");
    failed = true;
  }
  if (!/for fk_name in[\s\S]{0,600}alter table inventory_recon_sessions drop constraint %I/.test(invReconSqlForTrust)) {
    console.error("inventory-reconciliation-table.sql must include an idempotent migration that dynamically drops any pre-existing foreign key on source_report_id (by looking it up in information_schema, not a hardcoded constraint name) before adding the new one — needed for databases where this table was already created against the old inventory_reports table.");
    failed = true;
  }
  if (!/update inventory_recon_sessions\s+set source_report_id = null\s+where source_report_id is not null\s+and not exists \(\s*select 1 from ameen_warehouse_stock_reports r where r\.id = inventory_recon_sessions\.source_report_id\s*\)/.test(invReconSqlForTrust)) {
    console.error("inventory-reconciliation-table.sql must defensively null out any source_report_id that no longer exists in ameen_warehouse_stock_reports before attaching the new foreign key — must not rely on a coincidental UUID match with the old inventory_reports table.");
    failed = true;
  }
  if (!/add constraint inventory_recon_sessions_source_report_id_fkey\s*\n\s*foreign key \(source_report_id\) references ameen_warehouse_stock_reports\(id\) on delete set null/.test(invReconSqlForTrust)) {
    console.error("inventory-reconciliation-table.sql must add an explicit named foreign key constraint on source_report_id referencing ameen_warehouse_stock_reports(id).");
    failed = true;
  }
}

// ── المستودعات والمناقلات وفواتير الشراء حسب المستودع ──────────────────────
{
  const transferScript = readFileSync("tools/push-ameen-warehouse-transfers.ps1", "utf8");
  const requiredTransferTypes = [
    "ad2521dc-0981-4751-8542-fb52cad97b05",
    "6caa0de4-faa9-4027-ad83-4562c8f81211",
    "43b6cb6a-fd40-473f-8846-4b1064f5318a",
    "881cb610-3763-4976-9d7f-2f563da2b299"
  ];
  for (const guid of requiredTransferTypes) {
    if (!transferScript.toLowerCase().includes(guid)) {
      console.error(`Warehouse transfer sync is missing confirmed Ameen TypeGUID ${guid}.`);
      failed = true;
    }
  }
  const transferSql = transferScript.match(/\$sql = @'([\s\S]*?)'@/)?.[1] || "";
  if (!/^\s*select/i.test(transferSql) || /\b(insert\s+into|update\s+dbo|delete\s+from|merge\s+into|exec\s)/i.test(transferSql)) {
    console.error("Warehouse transfer Ameen query must remain SELECT-only.");
    failed = true;
  }
  for (const contract of [
    '$key = "$family|$date|$number"',
    "[math]::Abs($outQty - $inQty)",
    "$qty = [decimal]",
    "فشل تحقق المناقلات؛ لن يُرفع تقرير ناقص أو غير متوازن",
    "rest/v1/ameen_warehouse_transfer_reports"
  ]) {
    if (!transferScript.includes(contract)) {
      console.error(`Warehouse transfer sync contract is missing: ${contract}`);
      failed = true;
    }
  }

  if (!/LEFT JOIN st000 st ON st\.GUID = COALESCE\(bi\.StoreGUID, u\.StoreGUID\)/.test(purchaseInvoicesPull)) {
    console.error("Purchase invoice pull must resolve the real warehouse from st000 using the line/header StoreGUID.");
    failed = true;
  }
  for (const contract of ["warehouseGuid", "warehouseName", "warehouseCount"]) {
    if (!purchaseInvoicesPull.includes(contract)) {
      console.error(`Purchase invoice output is missing ${contract}.`);
      failed = true;
    }
  }

  const transferSqlMigration = readFileSync("supabase/ameen-warehouse-transfer-reports.sql", "utf8");
  for (const contract of [
    "alter table public.ameen_warehouse_transfer_reports enable row level security",
    "to_regprocedure('public.is_staff()')",
    "using (public.is_staff())",
    "revoke all on table public.ameen_warehouse_transfer_reports from public, anon, authenticated",
    "grant select, insert, delete on table public.ameen_warehouse_transfer_reports to authenticated",
    "public.ameen_warehouse_transfer_reports_is_sync_writer()",
    "and created_by = auth.uid()",
    "sync writer can delete old ameen warehouse transfers"
  ]) {
    if (!transferSqlMigration.includes(contract)) {
      console.error(`Warehouse transfer SQL contract is missing: ${contract}`);
      failed = true;
    }
  }

  const warehouseStockSql = readFileSync("supabase/ameen-warehouse-stock-reports.sql", "utf8");
  if (!warehouseStockSql.includes("using (public.is_staff())") || warehouseStockSql.includes("using (true);")) {
    console.error("Warehouse stock SELECT must require public.is_staff(); authenticated-only access is too broad.");
    failed = true;
  }

  const clientSource = readFileSync("src/supabase-client.js", "utf8");
  for (const contract of [
    "warehouseTransferReportsTable",
    "async listLatestWarehouseStockReports()",
    "async getLatestWarehouseTransferReport()",
    ".from(warehouseTransferReportsTable)"
  ]) {
    if (!clientSource.includes(contract)) {
      console.error(`Warehouse transfer client contract is missing: ${contract}`);
      failed = true;
    }
  }
  for (const contract of [
    'navButton("warehouses", "🏭 المستودعات والمناقلات")',
    "function warehouses()",
    "data-warehouse-pick",
    "invoice.warehouseName"
  ]) {
    if (!appJs.includes(contract)) {
      console.error(`Warehouse UI contract is missing: ${contract}`);
      failed = true;
    }
  }
}

// Owner/employee access-control contract. Authorization comes from immutable
// app_metadata; the former owner account must not regain executive access by
// editing user_metadata or by opening a route URL directly.
{
  const configSource = readFileSync("src/config.js", "utf8");
  const clientSource = readFileSync("src/supabase-client.js", "utf8");
  const decisionSource = readFileSync("src/decision-engine.js", "utf8");
  const commandSource = readFileSync("src/command-center.js", "utf8");
  const serviceWorkerSource = readFileSync("public/service-worker.js", "utf8");
  const ownerSql = readFileSync("supabase/owner-role-access.sql", "utf8");

  for (const email of ["ozkkhallouf@gmail.com", "ozkkhalouf@gmail.com"]) {
    if (!configSource.includes(`"${email}"`) || !appJs.includes(`"${email}"`)) {
      console.error(`Owner identity is missing from the browser access contract: ${email}`);
      failed = true;
    }
  }
  for (const contract of [
    '"ozk.kh@outlook.com": { name: "موظف OZK", role: "موظف", accessRole: "employee" }',
    'user.app_metadata?.role',
    'const OWNER_ONLY_ROUTES = new Set(["decision", "command"])',
    'window.ozkCanAccessRoute = canAccessRoute',
    'requestPasswordReset(emailInput)',
    'verifyPasswordRecoveryOtp(emailInput, tokenInput)',
    'updateRecoveredPassword(passwordInput)',
    'onPasswordRecovery(listener)',
    'if (dataStore.isPasswordRecovery?.()) state.route = "login"',
    'type: "recovery"',
    'data-form="password-recovery-code"',
    'autocomplete="one-time-code"',
    'pattern="[0-9]{6,10}"',
    'maxlength="10"',
    '/^\\d{6,10}$/.test(token)',
    'recovery=code'
  ]) {
    if (!(configSource + clientSource + appJs).includes(contract)) {
      console.error(`Owner/employee access contract is missing: ${contract}`);
      failed = true;
    }
  }
  if (/passwordRecoveryActive\s*=\s*\/(?:[^\n]|\\n)*recovery=1/.test(clientSource)) {
    console.error("A recovery query string alone must not be treated as an authenticated recovery session.");
    failed = true;
  }
  if (/const OWNER_EMAILS\s*=\s*\[[^\]]*ozk\.kh@outlook\.com/i.test(appJs)) {
    console.error("The employee Outlook account must not remain in OWNER_EMAILS.");
    failed = true;
  }
  if (!decisionSource.includes("window.ozkCanAccessRoute?.(ROUTE)") || !commandSource.includes("window.ozkCanAccessRoute?.(ROUTE)")) {
    console.error("Executive modules must guard both navigation and direct route rendering.");
    failed = true;
  }
  if (!ownerSql.includes("auth.jwt() -> 'app_metadata' ->> 'role'") || /auth\.jwt\(\)\s*->\s*'user_metadata'/.test(ownerSql)) {
    console.error("Database owner authorization must use app_metadata.role only.");
    failed = true;
  }
  if (!ownerSql.includes("security invoker") || !ownerSql.includes("revoke all on function public.is_owner() from public, anon")) {
    console.error("Owner authorization functions must not be anonymously executable or SECURITY DEFINER.");
    failed = true;
  }
  if (!serviceWorkerSource.includes('client.navigate(url)') || !serviceWorkerSource.includes('recovery=(?:1|code)') || !serviceWorkerSource.includes('type=recovery')) {
    console.error("The PWA update must refresh stale open clients without interrupting link or OTP password recovery.");
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log("Project check passed.");
