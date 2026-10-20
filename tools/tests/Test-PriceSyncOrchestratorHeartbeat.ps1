# اختبار نبض sync-approved-prices-to-ameen.ps1 في كل مسار خروج (وظيفة ps51-compat).
# ينسخ المنسِّق إلى مجلد مؤقت مع بدائل وهمية لـ pull/apply/verify/publish/telegram/heartbeat،
# فيُشغَّل المنطق الحقيقي بلا أمين ولا Supabase ولا Telegram. يتحقق من:
#   • النتيجة المنشورة في النبض لكل مسار، وأن رموز الخروج القديمة لم تتغير.
#   • أن ameen_price_sync_status وتنبيهات تيليغرام القديمة ما زالت تُستدعى كما كانت.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$orchestrator = Join-Path $repoRoot "tools\sync-approved-prices-to-ameen.ps1"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("price-orchestrator-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Copy-Item -LiteralPath $orchestrator -Destination (Join-Path $tempDir "sync-approved-prices-to-ameen.ps1")
$calls = Join-Path $tempDir "calls.log"
$csv = Join-Path $tempDir "prices.csv"
$log = Join-Path $tempDir "sync.log"
$utf8 = New-Object Text.UTF8Encoding($true)

function Write-Fake([string]$Name, [string]$Body) {
  [IO.File]::WriteAllText((Join-Path $tempDir $Name), $Body, $utf8)
}

Write-Fake "pull-approved-prices.ps1" @'
param([string]$EnvFile, [string]$OutputCsv, [string]$LogFile)
if ($env:FAKE_PULL -eq "fail") { exit 1 }
"item_key,item_name,sale_price,unit1_price,unit1_name,unit2_name,unit2_factor,unit2_price,retail_carton_usd,retail_unit1_usd,updated_at`nA,A,1,7.4,ك,ك,50,370,370,7.4,2026-10-18T08:00:00Z`nB,B,1,8,ك,ك,50,400,403,8.06,2026-10-18T08:00:00Z" | Set-Content -LiteralPath $OutputCsv -Encoding UTF8
exit 0
'@
Write-Fake "apply-approved-prices-to-ameen.ps1" @'
param([string]$CsvFile, [string]$EnvFile, [string]$LogFile)
switch ($env:FAKE_APPLY) {
  "network" { Add-Content -LiteralPath $LogFile -Value "[2026-10-18 10:00:00] AMEEN ERROR: A network-related or instance-specific error occurred"; exit 1 }
  "generic" { Add-Content -LiteralPath $LogFile -Value "[2026-10-18 10:00:00] AMEEN ERROR: Invalid column name 'X'"; exit 1 }
  "conflict" { Write-Output "PRICE_APPLY jumla=320 retail=316 skipped=0 notfound=1 conflict=2"; exit 0 }
  default { Write-Output "PRICE_APPLY jumla=2 retail=2 skipped=0 notfound=0 conflict=0"; exit 0 }
}
'@
Write-Fake "verify-prices.ps1" @'
param([string]$ResultFile)
if ($env:FAKE_VERIFY -eq "garbage") { [IO.File]::WriteAllText($ResultFile, "nothing", [Text.Encoding]::ASCII); exit 0 }
$mismatch = if ($env:FAKE_VERIFY -eq "mismatch") { 3 } else { 0 }
[IO.File]::WriteAllText($ResultFile, "PRICE_VERIFY wholesale=2 retail=2 mismatches=$mismatch missing=0", [Text.Encoding]::ASCII)
exit 0
'@
Write-Fake "publish-price-sync-status.ps1" @'
param([string]$Status, $WholesaleMatched, $RetailMatched, $MismatchCount, $MissingCount, [string]$Message)
Add-Content -LiteralPath $env:FAKE_CALLS -Value "status:$Status"
exit 0
'@
Write-Fake "send-telegram-notification.ps1" @'
param([string]$Message, [string]$EventType, [string]$DedupeKey, $DedupeMinutes, [string]$EnvFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value "telegram:$EventType"
exit 0
'@
Write-Fake "publish-price-sync-heartbeat.ps1" @'
param([string]$Mode, [string]$Outcome, [string]$StageFailed, [string]$AttemptStartedAt, [switch]$AmeenContact,
      [int]$SentCount = -1, [int]$AppliedWholesale = -1, [int]$AppliedRetail = -1, [int]$Skipped = -1,
      [int]$NotInAmeen = -1, [int]$ConflictCount = -1, [int]$WholesaleMatched = -1, [int]$RetailMatched = -1,
      [int]$Mismatches = -1, [int]$Missing = -1, [string]$PricesFingerprint, [string]$Message, [string]$EnvFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value ("heartbeat:{0}|stage={1}|contact={2}|sent={3}|applied={4}/{5}|conflict={6}|notin={7}|mismatch={8}|fp={9}|started={10}" -f $Outcome, $StageFailed, [bool]$AmeenContact, $SentCount, $AppliedWholesale, $AppliedRetail, $ConflictCount, $NotInAmeen, $Mismatches, ($PricesFingerprint.Length -gt 0), ($AttemptStartedAt.Length -gt 0))
Write-Output "PRICE-SYNC-HEARTBEAT DRYRUN (attempt outcome=$Outcome)"
exit 0
'@

$env:FAKE_CALLS = $calls
# على CI هو powershell.exe (5.1)؛ محلياً على macOS لا يوجد إلا pwsh.
$shellExe = if (Get-Command powershell.exe -ErrorAction SilentlyContinue) { "powershell.exe" } else { "pwsh" }
function Invoke-Scenario([string]$Pull, [string]$ApplyMode, [string]$Verify, [switch]$NoApply) {
  if (Test-Path -LiteralPath $calls) { Remove-Item -LiteralPath $calls -Force }
  if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
  $env:FAKE_PULL = $Pull; $env:FAKE_APPLY = $ApplyMode; $env:FAKE_VERIFY = $Verify
  $script = Join-Path $tempDir "sync-approved-prices-to-ameen.ps1"
  if ($NoApply) {
    & $shellExe -NoProfile -ExecutionPolicy Bypass -File $script -EnvFile (Join-Path $tempDir "none.env") -CsvFile $csv -LogFile $log *> $null
  } else {
    & $shellExe -NoProfile -ExecutionPolicy Bypass -File $script -Apply -EnvFile (Join-Path $tempDir "none.env") -CsvFile $csv -LogFile $log *> $null
  }
  $code = $LASTEXITCODE
  $lines = @(); if (Test-Path -LiteralPath $calls) { $lines = @(Get-Content -LiteralPath $calls -Encoding UTF8) }
  return @{ Code = $code; Lines = $lines; Heartbeats = @($lines | Where-Object { $_ -like 'heartbeat:*' }) }
}

try {
  $r = Invoke-Scenario "ok" "ok" "ok"
  Assert 'نجاح: خروج 0' ($r.Code -eq 0)
  Assert 'نجاح: نبض واحد applied مع اتصال بالأمين وأعداد' ($r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:applied|stage=|contact=True|sent=2|applied=2/2|conflict=0|notin=0|mismatch=0|fp=True|started=True')
  Assert 'نجاح: ameen_price_sync_status=ok باقٍ' ($r.Lines -contains 'status:ok')
  Assert 'نجاح: بلا تيليغرام' (-not ($r.Lines -like 'telegram:*'))

  $r = Invoke-Scenario "fail" "ok" "ok"
  Assert 'فشل السحب: خروج 1 ونبض pull_failed' ($r.Code -eq 1 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:pull_failed|stage=pull|contact=False*')

  $r = Invoke-Scenario "ok" "ok" "ok" -NoApply
  Assert 'معاينة بلا -Apply: خروج 0 ونبض preview_only' ($r.Code -eq 0 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:preview_only|stage=apply*')

  $r = Invoke-Scenario "ok" "network" "ok"
  Assert 'تعذّر الاتصال بالأمين: خروج 1 ونبض ameen_unreachable' ($r.Code -eq 1 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:ameen_unreachable|stage=connect|contact=False*')
  Assert 'تعذّر الاتصال: تنبيه sync_failure القديم باقٍ' ($r.Lines -contains 'telegram:sync_failure')

  $r = Invoke-Scenario "ok" "generic" "ok"
  Assert 'فشل التطبيق: خروج 1 ونبض apply_failed' ($r.Code -eq 1 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:apply_failed|stage=apply*')

  $r = Invoke-Scenario "ok" "conflict" "ok"
  Assert 'تعارض: خروج 0 ونبض applied_with_conflicts' ($r.Code -eq 0 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:applied_with_conflicts|stage=|contact=True|sent=2|applied=320/316|conflict=2|notin=1*')

  $r = Invoke-Scenario "ok" "ok" "mismatch"
  Assert 'فروق بعد الفحص: خروج 2 ونبض verify_mismatch' ($r.Code -eq 2 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:verify_mismatch|*mismatch=3*')
  Assert 'فروق: status=mismatch وتنبيه price_sync_mismatch باقيان' (($r.Lines -contains 'status:mismatch') -and ($r.Lines -contains 'telegram:price_sync_mismatch'))

  $r = Invoke-Scenario "ok" "ok" "garbage"
  Assert 'فحص غير مقروء: خروج 3 ونبض verify_failed' ($r.Code -eq 3 -and $r.Heartbeats.Count -eq 1 -and $r.Heartbeats[0] -like 'heartbeat:verify_failed|stage=verify|contact=True*')
  Assert 'فحص غير مقروء: status=error وتنبيه price_sync_failure باقيان' (($r.Lines -contains 'status:error') -and ($r.Lines -contains 'telegram:price_sync_failure'))
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:FAKE_CALLS, Env:FAKE_PULL, Env:FAKE_APPLY, Env:FAKE_VERIFY -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
if ($script:fail -gt 0) { exit 1 }
exit 0
