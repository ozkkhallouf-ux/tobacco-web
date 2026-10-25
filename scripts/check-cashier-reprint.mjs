// حارس ساكن لأداة «إعادة طباعة فاتورة كاشير» (tools/cashier-reprint).
// يثبت الحدود التي لا تُكسر: لا مساس بجسر الطباعة التلقائية ولا بحالته، كاشير Retail وحده
// على XPRINTER وحدها، والاستعلامات SELECT فقط. الاختبار السلوكي في tools/tests/Test-CashierReprint.ps1.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tools', 'cashier-reprint');
const read = (f) => readFileSync(path.join(dir, f), 'utf8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

for (const f of readdirSync(dir).filter((n) => n.endsWith('.ps1'))) {
  const text = readFileSync(path.join(dir, f));
  assert.ok(text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf, `${f}: يحتاج BOM كي يقرأ Windows PowerShell 5.1 العربية صحيحة`);
  const body = code(text.toString('utf8'));
  assert.doesNotMatch(body, /state\.json|-StatePath|StatePath\s*=/i, `${f}: لا مساس بملف حالة الجسر`);
  assert.doesNotMatch(body, /Observe|IncludeWholesale|Wholesale/, `${f}: لا وضع رصد ولا جملة`);
  assert.doesNotMatch(body, /(Disable|Enable|Stop|Start|Unregister|Register|Set)-ScheduledTask/i, `${f}: لا مساس بالمهام المجدولة`);
  assert.doesNotMatch(body, /Set-Content[^\n]*PrintBridge|Copy-Item[^\n]*PrintBridge|Remove-Item[^\n]*PrintBridge/i, `${f}: لا كتابة في مجلد الجسر`);
}

const lib = code(read('cashier-reprint-lib.ps1'));
assert.match(lib, /"-Mode", "PrintInvoice"/, 'الطباعة عبر وضع الجسر اليدوي القائم');
assert.match(lib, /"-InvoiceType", "Retail"/, 'نوع الكاشير وحده');
assert.match(lib, /\$script:CashierPrinterName = "XPRINTER XP-T80Q 80MM"/, 'طابعة الكاشير وحدها');
assert.match(lib, /Assert-CashierBridgePinned/, 'بصمة الجسر شرط للطباعة');
for (const name of ['CashierInvoiceLookupSql', 'CashierPrincipalProbeSql']) {
  const m = lib.match(new RegExp(`\\$script:${name} = @"\\n([\\s\\S]*?)\\n"@`));
  assert.ok(m, `${name} موجود`);
  assert.match(m[1].trim(), /^select\s/i, `${name} يبدأ بـSELECT`);
  assert.doesNotMatch(m[1], /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|into)\b/i, `${name} بلا كتابة`);
  assert.match(lib, new RegExp(`Assert-CashierSelectOnly \\$script:${name}`), `${name} يمر بالحارس قبل الإرسال`);
}

// الوضع البعيد: ssh بلا كلمات سر وببصمة جهاز معروفة، وصيغة أوامر ضيقة، وطلب طباعة واحد لكل نداء.
assert.match(lib, /"BatchMode=yes"/, 'ssh بلا كلمات سر');
assert.match(lib, /"StrictHostKeyChecking=yes"/, 'ssh يرفض جهازاً غير معروف');
const remotePrint = lib.slice(lib.indexOf('function Invoke-CashierRemotePrint'));
assert.equal((remotePrint.match(/"print \$Number/g) || []).length, 1, 'أمر print واحد فقط لكل طلب؛ لا إعادة طباعة تلقائية');
assert.match(lib, /\^resolve \(\\d\{1,9\}\)/, 'صيغة resolve ضيقة');
for (const remote of ['config.remote.example.json']) {
  const c = JSON.parse(read(remote));
  assert.equal(c.mode, 'remote');
  assert.equal(c.remoteExpectedHostName, 'OZKUSER');
  assert.ok(!('password' in c) && !JSON.stringify(c).match(/password/i), 'لا كلمات سر في الإعداد');
}

// حساب خدمة محدود: مسار جسر مطلق، واتصال الجسر من سرّ الأداة نفسه للعملية الفرعية وحدها.
const service = JSON.parse(read('config.service.example.json'));
assert.equal(service.mode, 'local');
assert.match(service.bridgeScriptPath, /^C:\\ProgramData\\OZK\\CashierReprint\\/, 'مسار الجسر لحساب الخدمة مطلق في ProgramData');
assert.doesNotMatch(service.bridgeScriptPath, /%/, 'لا متغيرات بيئة في مسار حساب الخدمة');
assert.equal(service.bridgeSqlSource, 'tool-secret');
assert.equal(service.enforceProtectedPaths, true);
assert.ok(!JSON.stringify(service).match(/password|pwd|connectionstring/i), 'لا أسرار في مثال حساب الخدمة');
assert.equal((lib.match(/EnvironmentVariables\[/g) || []).length, 1, 'متغيّر بيئة واحد فقط يُضبط للجسر');
assert.match(lib, /\$info\.EnvironmentVariables\["AMEEN_SQL_CONNECTION_STRING"\] = \$SqlConnectionString/, 'المتغيّر للعملية الفرعية وحدها');
assert.doesNotMatch(lib, /SetEnvironmentVariable/, 'لا كتابة لمتغيرات بيئة الجهاز أو المستخدم');
assert.doesNotMatch(lib, /\$arguments[^\n]*SqlConnectionString/, 'السرّ لا يدخل وسائط سطر الأوامر');
assert.match(lib, /Assert-CashierBridgeReady \$c \$r/, 'شرط الطباعة الافتراضي يشمل فحص الحماية حين يُفرض');

const config = JSON.parse(read('config.example.json'));
assert.equal(config.printerName, 'XPRINTER XP-T80Q 80MM');
assert.match(config.expectedBridgeSha256, /^[0-9a-f]{64}$/);

const workflow = readFileSync(path.join(root, '.github', 'workflows', 'check.yml'), 'utf8');
assert.match(workflow, /tools\\tests\\Test-CashierReprint\.ps1/, 'الاختبار السلوكي يعمل في وظيفة PowerShell 5.1');

console.log('check-cashier-reprint: OK');
