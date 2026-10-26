// حارس ساكن لأداة «إعادة طباعة فاتورة كاشير» (tools/cashier-reprint).
// يثبت الحدود التي لا تُكسر: لا مساس بجسر الطباعة التلقائية ولا بحالته، كاشير Retail وحده
// على XPRINTER وحدها، والاستعلامات SELECT فقط. الاختبار السلوكي في tools/tests/Test-CashierReprint.ps1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

// الطابعة والطابور عبر winspool: WMI/CIM يرفض دخول الشبكة (ssh) لحساب غير مدير.
const cli = code(read('cashier-reprint.ps1'));
for (const [name, body] of [['cashier-reprint-lib.ps1', lib], ['cashier-reprint.ps1', cli]]) {
  assert.doesNotMatch(body, /Get-PrintJob|Get-Printer\b|CimInstance|CimSession|Get-WmiObject/i, `${name}: لا WMI/CIM لفحص الطابعة أو الطابور`);
}
assert.match(lib, /DllImport\("winspool\.drv"/, 'الطابور عبر winspool مباشرة');
assert.match(lib, /if \(error == 87\) return -1;/, 'مهمة غادرت الطابور تُعرف بـERROR_INVALID_PARAMETER');
assert.match(cli, /Get-CashierPrinterInfo \$config\.printerName/, 'فحص Health للطابعة عبر winspool');
assert.doesNotMatch(lib, /\$arguments[^\n]*SqlConnectionString/, 'السرّ لا يدخل وسائط سطر الأوامر');
assert.match(lib, /Assert-CashierBridgeReady \$c \$r/, 'شرط الطباعة الافتراضي يشمل فحص الحماية حين يُفرض');

// نسخة الـrenderer للجسر الثابت (حساب الخدمة): فحص الطابور عبر winspool بلا CIM، قبل الرسم والإرسال،
// وبصمتها مثبّتة في مثال حساب الخدمة. الجسر التلقائي الأصلي لا يُمسّ ولا يستعمل هذه النسخة.
const rendererRel = path.join('static-bridge', 'ozk-print-bridge', 'OzkReceiptRenderer.psm1');
const rendererBytes = readFileSync(path.join(dir, rendererRel));
assert.ok(rendererBytes[0] === 0xef && rendererBytes[1] === 0xbb && rendererBytes[2] === 0xbf, 'renderer: يحتاج BOM لـWindows PowerShell 5.1');
assert.ok(!rendererBytes.includes(0x0d), 'renderer: نهايات LF وحدها كي تبقى البصمة ثابتة');
const renderer = code(rendererBytes.toString('utf8'));
assert.doesNotMatch(renderer, /Get-PrintJob|Get-Printer\b|CimInstance|CimSession|Get-WmiObject|Win32_Printer/i, 'renderer: لا WMI/CIM');
assert.match(renderer, /\$script:CashierPrinterName = "XPRINTER XP-T80Q 80MM"/, 'renderer: طابعة الكاشير وحدها');
assert.match(renderer, /pDataType = "RAW"/, 'renderer: الإرسال RAW كما هو');
const send = renderer.slice(renderer.indexOf('function Send-OzkReceiptToPrinter'));
const order = ['if (-not $ConfirmPhysicalPrint)', '$PrinterName -cne $script:CashierPrinterName', 'Assert-OzkPrinterQueueReady $PrinterName', 'New-OzkReceiptBitmap', '[OzkRawThermalPrinter]::Send('].map((t) => send.indexOf(t));
assert.ok(order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'renderer: التأكيد ثم الطابعة ثم فحص الطابور ثم الرسم ثم الإرسال');
assert.match(renderer, /Export-ModuleMember -Function New-OzkReceiptBitmap, Save-OzkReceiptPreview, Send-OzkReceiptToPrinter\s*$/, 'renderer: الدوال المصدَّرة كما هي');
const rendererHash = createHash('sha256').update(rendererBytes).digest('hex');
assert.equal(service.expectedRendererSha256, rendererHash, 'مثال حساب الخدمة يثبّت بصمة الـrenderer في المستودع');
assert.match(lib, /\[void\]\(Assert-CashierRendererPinned \$Config\)/, 'بصمة الـrenderer ضمن شرط الطباعة');

const config = JSON.parse(read('config.example.json'));
assert.equal(config.printerName, 'XPRINTER XP-T80Q 80MM');
assert.match(config.expectedBridgeSha256, /^[0-9a-f]{64}$/);

// العامل المحلي (printDispatch=agent): حساب الخدمة يكتب تذكرة وينتظر النتيجة ولا يطبع أبداً؛ العامل يطبع
// بجلسة الكاشير بعد التحقق، بالترتيب: المهلة ثم المالك ثم الصيغة ثم الطباعة. لا تسجيل مهام من الكود.
const fnBody = (text, name) => {
  const start = text.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} موجود`);
  const next = text.indexOf('\nfunction ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
};
const submit = fnBody(lib, 'Submit-CashierAgentPrint');
assert.doesNotMatch(submit, /Invoke-CashierReprint|Invoke-LocalPrint|Invoke-CashierBridge|Start-CashierProcess|Register-CashierReprintRequest|& \$Print/, 'Serve في وضع العامل لا يطبع ولا يحجز');
assert.doesNotMatch(submit, /Get-Item[^\n]*\$ticketPath/, 'Serve لا يقرأ التذكرة بعد نشرها (قد يلتقطها العامل فوراً)');
assert.match(submit, /agent_unavailable/, 'Serve يرفض الطلب بلا نبضة عامل حديثة قبل كتابة أي تذكرة');
assert.ok(submit.indexOf('agent_unavailable') < submit.indexOf('New-CashierAgentTicket'), 'فحص النبضة قبل كتابة التذكرة');
const ticket = fnBody(lib, 'Invoke-CashierAgentTicket');
const agentOrder = ['[IO.File]::Move($TicketPath, $claimed)', '"pickup_timeout"', '"clock_skew"', '"owner_not_allowed"', '"malformed"', '& $Print'].map((t) => ticket.indexOf(t));
assert.ok(agentOrder.every((i) => i >= 0) && agentOrder.every((i, k) => k === 0 || i > agentOrder[k - 1]), 'العامل: الالتقاط الذري ثم المهلة ثم الساعة ثم المالك ثم الصيغة ثم الطباعة');
assert.equal((ticket.match(/& \$Print/g) || []).length, 1, 'العامل: طباعة واحدة لكل تذكرة');
const restore = fnBody(lib, 'Restore-CashierAgentState');
assert.doesNotMatch(restore, /Invoke-CashierReprint|Invoke-LocalPrint|& \$Print/, 'الاستعادة بعد الانقطاع لا تطبع أبداً');
assert.match(fnBody(lib, 'New-CashierAgentTicket'), /FileMode\]::CreateNew/, 'التذكرة حصرية: CreateNew');
assert.doesNotMatch(fnBody(lib, 'Write-CashierAgentResult'), /Move\([^)]*,\s*\$true\)|Move-Item|Copy-Item|Set-Content[^\n]*\$final/, 'النتيجة لا تُستبدل');
assert.match(cli, /if \(\$config\.printDispatch -eq "agent"\) \{ \$r = Submit-CashierAgentPrint/, 'Serve يحوّل الطباعة للعامل في وضع agent');
assert.match(cli, /\$agentLock = Open-CashierAgentLock \$Root/, 'نسخة واحدة من العامل بقفل ملف');
assert.doesNotMatch(cli, /Threading\.Mutex/, 'لا Mutex عام: أي حساب محلي يستطيع حجز اسمه فيعطّل العامل');
assert.match(fnBody(lib, 'Open-CashierAgentLock'), /FileShare\]::None/, 'قفل العامل حصري');
assert.match(fnBody(lib, 'Get-CashierAgentPaths'), /Lock = Join-Path \(Join-Path \$base "processing"\) "agent\.lock"/, 'القفل داخل processing حيث لا يصل حساب الخدمة');
assert.match(fnBody(lib, 'Open-CashierAgentTicketHold'), /FileAccess\]::Read, \[IO\.FileShare\]::Read\)/, 'مقبض الاستلام يمنع الكتابة والحذف');
assert.ok(ticket.indexOf('Open-CashierAgentTicketHold $claimed') > ticket.indexOf('[IO.File]::Move($TicketPath, $claimed)') && ticket.indexOf('Open-CashierAgentTicketHold $claimed') < ticket.indexOf('"pickup_timeout"'), 'العامل يمسك التذكرة قبل أي فحص');
assert.match(ticket, /Read-CashierAgentTicketStream \$hold/, 'المحتوى يُقرأ من مقبض الاستلام نفسه');
assert.doesNotMatch(ticket, /Read-CashierAgentTicket \$claimed|ReadAllText|ReadAllBytes/, 'لا قراءة ثانية للتذكرة من المسار');
assert.ok(ticket.indexOf('$hold.Dispose()') < ticket.indexOf('& $Print'), 'المقبض يُغلق قبل الطباعة (الطباعة من الذاكرة)');
assert.equal(service.printDispatch, 'agent', 'حساب الخدمة يطبع عبر العامل المحلي');
assert.ok(service.agentRequesterSids.every((sid) => /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(sid)), 'معرّفات حسابات محلية فقط');
assert.ok(service.agentResultTimeoutSeconds >= service.agentPickupSeconds + service.bridgeTimeoutSeconds + service.jobWatchSeconds, 'مهلة النتيجة تغطي الطباعة كاملة');
const remoteCfg = JSON.parse(read('config.remote.example.json'));
assert.ok(remoteCfg.remoteTimeoutSeconds > service.agentResultTimeoutSeconds, 'مهلة ssh على OZK2026 أطول من انتظار Serve');
const task = read('agent-task.example.xml');
assert.match(task, /<LogonType>InteractiveToken<\/LogonType>/, 'العامل بجلسة الكاشير التفاعلية');
assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/, 'العامل بلا رفع صلاحيات');
assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, 'لا نسخة ثانية من المهمة');
assert.match(task, /-Mode Agent -Root "C:\\ProgramData\\OZK\\CashierReprint"/, 'المهمة تشغّل وضع العامل وحده');
assert.doesNotMatch(task, /PrintBridge|state\.json|-Once/i, 'المهمة لا تمسّ الجسر التلقائي');

const workflow = readFileSync(path.join(root, '.github', 'workflows', 'check.yml'), 'utf8');
assert.match(workflow, /tools\\tests\\Test-CashierReprint\.ps1/, 'الاختبار السلوكي يعمل في وظيفة PowerShell 5.1');
assert.match(workflow, /tools\\tests\\Test-CashierReprintAgent\.ps1/, 'اختبار العامل المحلي يعمل في وظيفة PowerShell 5.1');

console.log('check-cashier-reprint: OK');
