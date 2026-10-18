# اختبار publish-price-sync-heartbeat.ps1 تحت Windows PowerShell 5.1 (وظيفة ps51-compat).
# كل التشغيلات بوضع -DryRun: الحمولة تُكتب لملف مؤقت بدل النشر. حالة المهمة مصطنعة عبر
# -TaskInfoJson. لا اتصال بالأمين، لا Supabase، لا Task Scheduler حقيقي، لا Telegram.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$publisher = Join-Path $repoRoot "tools\publish-price-sync-heartbeat.ps1"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("price-heartbeat-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$stateFile = Join-Path $tempDir "state.json"
$resultFile = Join-Path $tempDir "payload.json"
$enabledTask = '{"exists":true,"enabled":true,"state":"Ready","last_run_time":"2026-10-18T08:34:00Z","last_result":0}'
$disabledTask = '{"exists":true,"enabled":false,"state":"Disabled","last_run_time":"2026-10-18T04:29:00Z","last_result":0}'
$missingTask = '{"exists":false,"enabled":false,"state":"Missing"}'

# PowerShell 7 يحوّل نصوص ISO إلى DateTime عند ConvertFrom-Json، و5.1 لا يفعل؛ نوحّد للمقارنة.
function IsoOf($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss") }
  return ([string]$Value).Substring(0, [Math]::Min(19, ([string]$Value).Length))
}

function Invoke-Publisher([hashtable]$Arguments) {
  if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
  $output = (& $publisher -DryRun -ResultFile $resultFile -StateFile $stateFile @Arguments | Out-String)
  $code = $LASTEXITCODE
  $payload = $null
  if (Test-Path -LiteralPath $resultFile) { $payload = Get-Content -Raw -LiteralPath $resultFile -Encoding UTF8 | ConvertFrom-Json }
  return @{ Output = $output; Code = $code; Payload = $payload }
}

try {
  # ١) أول نجاح: لا حالة سابقة ⇒ applied، prices_changed غير معروف
  $r = Invoke-Publisher @{ Mode = "Attempt"; Outcome = "applied"; Now = "2026-10-18T08:30:00Z"; AmeenContact = $true; SentCount = 321; AppliedWholesale = 321; AppliedRetail = 317; NotInAmeen = 0; ConflictCount = 0; WholesaleMatched = 321; RetailMatched = 317; Mismatches = 0; Missing = 0; PricesFingerprint = "aaa"; TaskInfoJson = $enabledTask }
  Assert 'أول نجاح: رمز الخروج 0' ($r.Code -eq 0)
  Assert 'أول نجاح: سطر DRYRUN' ($r.Output -match 'PRICE-SYNC-HEARTBEAT DRYRUN \(attempt outcome=applied\)')
  Assert 'أول نجاح: المصدر والمخطط' ($r.Payload.source -eq 'ameen_price_sync_heartbeat' -and $r.Payload.summary.schema -eq 'price-sync-heartbeat/v1' -and $r.Payload.summary.kind -eq 'attempt')
  Assert 'أول نجاح: تاريخ التقرير بتوقيت دمشق' ($r.Payload.report_date -eq '2026-10-18')
  Assert 'أول نجاح: الأعداد' ($r.Payload.summary.sent_count -eq 321 -and $r.Payload.summary.applied_wholesale -eq 321 -and $r.Payload.summary.applied_retail -eq 317 -and $r.Payload.summary.conflict_count -eq 0)
  Assert 'أول نجاح: نتيجة الفحص' ($r.Payload.summary.verify.mismatches -eq 0 -and $r.Payload.summary.verify.wholesale_matched -eq 321)
  Assert 'أول نجاح: وقت الاتصال بالأمين' ((IsoOf $r.Payload.summary.ameen_contact_at) -eq '2026-10-18T08:30:00')
  Assert 'أول نجاح: prices_changed غير معروف' ($null -eq $r.Payload.summary.prices_changed)
  Assert 'أول نجاح: last_success_at' ((IsoOf $r.Payload.summary.last_success_at) -eq '2026-10-18T08:30:00')
  Assert 'أول نجاح: حالة المهمة مضمّنة' ($r.Payload.summary.task.enabled -eq $true -and $r.Payload.summary.task.state -eq 'Ready')

  # ٢) نفس البصمة ⇒ no_changes (المهمة تعمل ولا أسعار جديدة)
  $r = Invoke-Publisher @{ Mode = "Attempt"; Outcome = "applied"; Now = "2026-10-18T08:35:00Z"; AmeenContact = $true; PricesFingerprint = "aaa"; TaskInfoJson = $enabledTask }
  Assert 'بلا أسعار جديدة: outcome=no_changes' ($r.Payload.summary.outcome -eq 'no_changes')
  Assert 'بلا أسعار جديدة: prices_changed=false' ($r.Payload.summary.prices_changed -eq $false)

  # ٣) بصمة مختلفة ⇒ applied و prices_changed=true
  $r = Invoke-Publisher @{ Mode = "Attempt"; Outcome = "applied"; Now = "2026-10-18T08:40:00Z"; AmeenContact = $true; PricesFingerprint = "bbb"; TaskInfoJson = $enabledTask }
  Assert 'أسعار جديدة: outcome=applied' ($r.Payload.summary.outcome -eq 'applied')
  Assert 'أسعار جديدة: prices_changed=true' ($r.Payload.summary.prices_changed -eq $true)

  # ٤) فشل الاتصال: آخر نجاح يبقى، وآخر فشل يُسجّل، ولا وقت اتصال
  $r = Invoke-Publisher @{ Mode = "Attempt"; Outcome = "ameen_unreachable"; StageFailed = "connect"; Now = "2026-10-18T08:45:00Z"; PricesFingerprint = "bbb"; Message = "A network-related error"; TaskInfoJson = $enabledTask }
  Assert 'فشل الاتصال: outcome محفوظ' ($r.Payload.summary.outcome -eq 'ameen_unreachable' -and $r.Payload.summary.stage_failed -eq 'connect')
  Assert 'فشل الاتصال: آخر نجاح باقٍ' ((IsoOf $r.Payload.summary.last_success_at) -eq '2026-10-18T08:40:00')
  Assert 'فشل الاتصال: آخر فشل' ((IsoOf $r.Payload.summary.last_failure_at) -eq '2026-10-18T08:45:00')
  Assert 'فشل الاتصال: لا وقت اتصال بالأمين' ($null -eq $r.Payload.summary.ameen_contact_at)
  Assert 'فشل الاتصال: الأعداد غير المعروفة null لا صفر' ($null -eq $r.Payload.summary.applied_wholesale -and $null -eq $r.Payload.summary.verify.mismatches)

  # ٥) الفشل لا يحوّل نتيجة applied إلى no_changes ولا يغيّر البصمة المحفوظة
  $state = Get-Content -Raw -LiteralPath $stateFile -Encoding UTF8 | ConvertFrom-Json
  Assert 'الحالة: بصمة آخر نجاح = bbb' ($state.last_success_fingerprint -eq 'bbb')

  # ٦) فحص المهمة: مفعّلة ⇒ يُنشر أول مرة، ثم يُخنق خلال 30 دقيقة، ثم يُنشر بعدها
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:00:00Z"; TaskInfoJson = $enabledTask }
  Assert 'فحص المهمة الأول: منشور' ($r.Output -match 'PRICE-SYNC-HEARTBEAT DRYRUN \(task_probe enabled=True state=Ready\)' -and $r.Payload.summary.kind -eq 'task_probe')
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:10:00Z"; TaskInfoJson = $enabledTask }
  Assert 'فحص المهمة خلال 30 د: مخنوق' ($r.Output -match 'SKIPPED' -and $null -eq $r.Payload)
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:31:00Z"; TaskInfoJson = $enabledTask }
  Assert 'فحص المهمة بعد 30 د: منشور' ($r.Output -match 'DRYRUN' -and $null -ne $r.Payload)

  # ٧) المهمة معطّلة ⇒ يُنشر فوراً رغم الخنق
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:32:00Z"; TaskInfoJson = $disabledTask }
  Assert 'مهمة معطّلة: منشور فوراً' ($r.Payload.summary.task.enabled -eq $false -and $r.Payload.summary.task.state -eq 'Disabled')
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:33:00Z"; TaskInfoJson = $disabledTask }
  Assert 'مهمة معطّلة: منشور في كل دورة' ($null -ne $r.Payload)

  # ٨) المهمة غير مسجّلة
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:34:00Z"; TaskInfoJson = $missingTask }
  Assert 'مهمة مفقودة: exists=false' ($r.Payload.summary.task.exists -eq $false)

  # ٩) خطأ داخلي ⇒ سطر FAILED ورمز الخروج 0 (لا يكسر المزامنة)
  $r = Invoke-Publisher @{ Mode = "TaskProbe"; Now = "2026-10-18T09:35:00Z"; TaskInfoJson = "{not json" }
  Assert 'خطأ داخلي: FAILED ورمز 0' ($r.Output -match 'PRICE-SYNC-HEARTBEAT FAILED' -and $r.Code -eq 0)

  # ١٠) حالة محلية تالفة لا تخترع نجاحاً سابقاً
  [IO.File]::WriteAllText($stateFile, "garbage", (New-Object Text.UTF8Encoding($false)))
  $r = Invoke-Publisher @{ Mode = "Attempt"; Outcome = "pull_failed"; StageFailed = "pull"; Now = "2026-10-18T09:40:00Z"; TaskInfoJson = $enabledTask }
  Assert 'حالة تالفة: لا last_success_at' ($null -eq $r.Payload.summary.last_success_at -and $r.Payload.summary.outcome -eq 'pull_failed')
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
if ($script:fail -gt 0) { exit 1 }
exit 0
