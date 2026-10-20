# اختبار «أحداث فواتير الأمين» (tools/ameen-invoice-events-lib.ps1) تحت Windows PowerShell 5.1 وPowerShell 7.
# بلا اتصال بالأمين ولا Supabase ولا Task Scheduler: اللقطات مصطنعة، والنقل (Transport) دالة وهمية،
# وصندوق الإرسال في مجلد مؤقت يُحذف بعد الاختبار. لا بيانات زبائن حقيقية.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot "tools\ameen-invoice-events-lib.ps1")
$agentPath = Join-Path $repoRoot "tools\ameen-invoice-event-agent.ps1"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

# ── بيانات مصطنعة ───────────────────────────────────────────────────────────────────────────────
$G1 = "C0000000-0000-0000-0000-000000000001"
function New-Header([string]$Guid = $G1, [int]$BillType = 1, [double]$Total = 286, [string]$Name = "  زبون تجريبي  ", [int]$Posted = 1) {
  return [pscustomobject]@{
    GUID = [guid]$Guid; Number = 1001; Date = [datetime]"2026-10-20"; CreateDate = [datetime]"2026-10-20T18:25:06"
    LastUpdateDate = [datetime]"1980-01-01"; TypeGUID = [guid]"7f5b0921-61f3-4f23-a1f4-fbfae4144bf4"; BillType = $BillType
    IsPosted = $Posted; RecState = 0; PayType = 1; CustGUID = [guid]"aaaaaaaa-0000-0000-0000-000000000001"
    CustAccGUID = [guid]"aaaaaaaa-0000-0000-0000-000000000002"; Cust_Name = $Name; StoreGUID = [guid]"dddddddd-0000-0000-0000-000000000001"
    CurrencyGUID = [guid]"eeeeeeee-0000-0000-0000-000000000001"; CurrencyVal = 1.0; Total = $Total; TotalDisc = 0.0; TotalExtra = 0.0
    ItemsDisc = 0.0; ItemsExtra = 0.0; BonusDisc = 0.0; FirstPay = 0.0; VAT = 0.0; RefundedBillGUID = [guid]"00000000-0000-0000-0000-000000000000"
  }
}
function New-Line([int]$Number, [string]$Guid, [double]$Qty = 50, [double]$Price = 5.72) {
  return [pscustomobject]@{
    GUID = [guid]$Guid; Number = $Number; MatGUID = [guid]"ffffffff-0000-0000-0000-00000000000$Number"; Qty = $Qty; Qty2 = 1.0; Qty3 = 0.0
    Unity = 2.0; Price = $Price; Discount = 0.0; Extra = 0.0; BonusQnt = 0.0; VAT = 0.0; StoreGUID = [guid]"dddddddd-0000-0000-0000-000000000001"
    CostGUID = [DBNull]::Value
  }
}
$L1 = New-Line 1 "b0000000-0000-0000-0000-000000000001"
$L2 = New-Line 2 "b0000000-0000-0000-0000-000000000002" 20 3.1

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("ameen-invoice-events-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
  # ── ١) حارس القراءة فقط ──────────────────────────────────────────────────────────────────────
  Assert 'guard: SELECT accepted' (-not (Throws { Assert-AmeenReadOnlySql "SELECT 1" }))
  Assert 'guard: WITH accepted' (-not (Throws { Assert-AmeenReadOnlySql "WITH x AS (SELECT 1 a) SELECT a FROM x" }))
  foreach ($bad in @("UPDATE dbo.bu000 SET Total = 0", "DELETE FROM dbo.bu000", "INSERT INTO dbo.bu000 VALUES (1)", "SELECT * INTO #t FROM dbo.bu000",
                     "SELECT * FROM dbo.bu000 WITH (NOLOCK)", "EXEC sp_who", "SELECT 1; DROP TABLE dbo.bu000", "TRUNCATE TABLE dbo.log000",
                     "SELECT 1; SELECT 2", "MERGE dbo.bu000 AS t USING x ON 1=1", "SELECT * FROM OPENQUERY(x, 'q')")) {
    Assert ("guard: refused [" + $bad + "]") (Throws { Assert-AmeenReadOnlySql $bad })
  }
  Assert 'guard: comment cannot hide a write' (Throws { Assert-AmeenReadOnlySql "SELECT 1 /* x */ ; UPDATE t SET a=1" })

  $q = Get-AmeenInvoiceDetectionSql -Watermark ([datetime]"2026-10-20T18:30:00")
  $snapQ = Get-AmeenInvoiceSnapshotSql -BillGuid $G1
  foreach ($sql in @($q.Log, $q.Bills, $snapQ.Header, $snapQ.Lines, (Get-AmeenInvoiceFingerprintSql))) {
    Assert ('agent SQL passes read-only guard: ' + $sql.Substring(0, 40)) (-not (Throws { Assert-AmeenReadOnlySql $sql }))
    Assert ('agent SQL has no NOLOCK: ' + $sql.Substring(0, 40)) ($sql -notmatch '(?i)nolock')
  }
  Assert 'detection: 10s overlap before watermark' ($q.Log -match "LogTime > '2026-10-20T18:29:50.000'")
  Assert 'detection: bills use CreateDate OR LastUpdateDate (1980 = never edited)' ($q.Bills -match 'CreateDate >' -and $q.Bills -match 'LastUpdateDate >')
  Assert 'detection: sales and returns only' ($q.Log -match 'BillType IN \(1,3\)' -and $q.Bills -match 'BillType IN \(1,3\)')

  # ── ٢) JSON قانوني ثابت ─────────────────────────────────────────────────────────────────────────
  $j = ConvertTo-AmeenCanonicalJson ([ordered]@{ b = 1; a = "x`"y\z"; c = @(1.5, $null, $true); _u = 0.1 })
  Assert 'canonical: ordinal key order, escaping, arrays' ($j -eq '{"_u":0.1,"a":"x\"y\\z","b":1,"c":[1.5,null,true]}')
  Assert 'canonical: integral double as integer' ((ConvertTo-AmeenCanonicalJson 286.0) -eq '286')
  Assert 'canonical: float noise rounded' ((ConvertTo-AmeenCanonicalJson (0.1 + 0.2)) -eq '0.3')
  Assert 'canonical: arabic text kept as-is' ((ConvertTo-AmeenCanonicalJson "مبيعات مركز") -eq '"مبيعات مركز"')
  $orig = [Threading.Thread]::CurrentThread.CurrentCulture
  $hashes = @()
  foreach ($c in @("en-US", "ar-SY", "de-DE", "tr-TR")) {
    [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo($c)
    $hashes += Get-AmeenInvoiceVersionHash (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header) -Lines @($L1, $L2))
  }
  [Threading.Thread]::CurrentThread.CurrentCulture = $orig
  Assert 'version hash identical under en/ar/de/tr cultures' (@($hashes | Sort-Object -Unique).Count -eq 1)
  Assert 'version hash is sha256 hex' ($hashes[0] -match '^[0-9a-f]{64}$')

  # ── ٣) اللقطة والبصمة ─────────────────────────────────────────────────────────────────────────
  $s1 = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header) -Lines @($L1, $L2)
  $s1r = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header) -Lines @($L2, $L1)
  Assert 'snapshot: line read order does not change version' ((Get-AmeenInvoiceVersionHash $s1) -eq (Get-AmeenInvoiceVersionHash $s1r))
  $h2 = New-Header; $h2.LastUpdateDate = [datetime]"2026-10-20T19:00:00"; $h2.CreateDate = [datetime]"2026-10-21"
  Assert 'snapshot: timestamps are not content (save without change = same version)' ((Get-AmeenInvoiceVersionHash $s1) -eq (Get-AmeenInvoiceVersionHash (ConvertTo-AmeenInvoiceSnapshot -Header $h2 -Lines @($L1, $L2))))
  $L1b = New-Line 1 "b0000000-0000-0000-0000-000000000001" 51
  Assert 'snapshot: qty change = new version' ((Get-AmeenInvoiceVersionHash $s1) -ne (Get-AmeenInvoiceVersionHash (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header) -Lines @($L1b, $L2))))
  Assert 'snapshot: unpost = new version' ((Get-AmeenInvoiceVersionHash $s1) -ne (Get-AmeenInvoiceVersionHash (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Posted 0) -Lines @($L1, $L2))))
  Assert 'snapshot: guid lowercased' ($s1.bill_guid -eq $G1.ToLowerInvariant())
  Assert 'snapshot: name trimmed, named' ($s1.customer_name -eq "زبون تجريبي" -and $s1.is_named)
  Assert 'snapshot: zero refunded guid -> null' ($null -eq $s1.refunded_bill_guid)
  Assert 'snapshot: DBNull cost guid -> null' ($null -eq $s1.lines[0].cost_guid)
  $center = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Name "") -Lines @($L1)
  Assert 'snapshot: unnamed center sale flagged' (-not $center.is_named -and $null -eq $center.customer_name)
  $ret = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -BillType 3) -Lines @($L1)
  Assert 'snapshot: return flagged' ($ret.is_return -and $ret.bill_type -eq 3)
  Assert 'real update date: 1980 means never edited' (-not (Test-AmeenRealUpdateDate ([datetime]"1980-01-01")) -and (Test-AmeenRealUpdateDate ([datetime]"2026-10-20")))

  # ── ٤) محلّل التغييرات: لا تكرار، نفس الفاتورة عند التعديل ─────────────────────────────────────
  $state = New-AmeenInvoiceState
  $obs = { param($snap, $ops, $at) @{ guid = $G1; snapshot = $snap; ops = @($ops); detected_at_utc = $at; source = "incremental"; source_create_utc = "2026-10-20T15:25:06.000Z" } }
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @(@{ op = 1; at_utc = "2026-10-20T15:25:07.000Z" }) "2026-10-20T15:25:08.000Z"))
  Assert 'create: one upsert event' ($e.Count -eq 1 -and $e[0].kind -eq "upsert" -and $e[0].change -eq "created")
  Assert 'create: source time = log time' ($e[0].source_event_at -eq "2026-10-20T15:25:07.000Z")
  Assert 'create: event_id = sha256(guid|kind|version|at) (same formula as the server)' ($e[0].event_id -eq (Get-AmeenSha256Hex ("{0}|upsert|{1}|2026-10-20T15:25:07.000Z" -f $G1.ToLowerInvariant(), $e[0].version_hash)))
  Assert 'create: seq 1' ($e[0].source_seq -eq 1)
  $createId = $e[0].event_id

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @() "2026-10-20T15:25:10.000Z"), (& $obs $s1r @() "2026-10-20T15:25:12.000Z"))
  Assert 'same content seen again (twice, any line order): no event' ($e.Count -eq 0)

  $s2 = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Total 300) -Lines @($L1b, $L2)
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s2 @(@{ op = 3; at_utc = "2026-10-20T15:30:00.000Z" }, @{ op = 100; at_utc = "2026-10-20T15:30:00.500Z" }) "2026-10-20T15:30:02.000Z"))
  Assert 'edit: one updated event for the SAME bill_guid' ($e.Count -eq 1 -and $e[0].change -eq "updated" -and $e[0].bill_guid -eq $G1.ToLowerInvariant())
  Assert 'edit: new version, new event id' ($e[0].version_hash -ne (Get-AmeenInvoiceVersionHash $s1) -and $e[0].event_id -ne $createId)
  Assert 'edit: source time = latest op' ($e[0].source_event_at -eq "2026-10-20T15:30:00.500Z")
  Assert 'edit: seq 2' ($e[0].source_seq -eq 2)
  Assert 'state: still one bill tracked' ($state.bills.Count -eq 1)

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @(@{ op = 3; at_utc = "2026-10-20T15:31:00.000Z" }) "2026-10-20T15:31:01.000Z"))
  Assert 'revert to earlier content: emitted (not treated as duplicate)' ($e.Count -eq 1 -and $e[0].event_id -ne $createId -and $e[0].version_hash -eq (Get-AmeenInvoiceVersionHash $s1))

  $unposted = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Posted 0) -Lines @($L1, $L2)
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $unposted @(@{ op = 9; at_utc = "2026-10-20T15:32:00.000Z" }) "2026-10-20T15:32:01.000Z"))
  Assert 'unpost: emitted as update with is_posted=false' ($e.Count -eq 1 -and $e[0].change -eq "updated" -and -not $e[0].bill.is_posted)

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $null @(@{ op = 2; at_utc = "2026-10-20T15:40:00.000Z" }) "2026-10-20T15:40:01.000Z"))
  Assert 'delete: one delete event' ($e.Count -eq 1 -and $e[0].kind -eq "delete" -and $e[0].version_hash -eq "deleted")
  Assert 'delete: event id formula' ($e[0].event_id -eq (Get-AmeenSha256Hex ("{0}|delete|deleted|2026-10-20T15:40:00.000Z" -f $G1.ToLowerInvariant())))
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $null @() "2026-10-20T15:41:00.000Z"))
  Assert 'delete: not repeated' ($e.Count -eq 0)
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s2 @(@{ op = 1; at_utc = "2026-10-20T15:50:00.000Z" }) "2026-10-20T15:50:01.000Z"))
  Assert 'reappearing bill: restored' ($e.Count -eq 1 -and $e[0].change -eq "restored")

  $other = New-AmeenInvoiceState
  $e = Resolve-AmeenInvoiceChanges -State $other -Observations @(@{ guid = $G1; snapshot = $null; ops = @(); detected_at_utc = "2026-10-20T15:00:00.000Z" })
  Assert 'unknown bill absent without delete op: no event' ($e.Count -eq 0)
  $e = Resolve-AmeenInvoiceChanges -State $other -Observations @(@{ guid = $G1; snapshot = $null; ops = @(@{ op = 2; at_utc = "2026-10-20T15:00:00.000Z" }); detected_at_utc = "2026-10-20T15:00:01.000Z" })
  Assert 'unknown bill with delete op: delete event (tombstone)' ($e.Count -eq 1 -and $e[0].kind -eq "delete")
  $e = Resolve-AmeenInvoiceChanges -State (New-AmeenInvoiceState) -Observations @(@{ guid = $G1; snapshot = $s1; ops = @(); detected_at_utc = "2026-10-20T15:00:09.000Z"; source_create_utc = "2026-10-20T15:00:00.000Z"; source_update_utc = "2026-10-20T15:00:05.000Z" })
  Assert 'no log op: source time = real LastUpdateDate before CreateDate' ($e[0].source_event_at -eq "2026-10-20T15:00:05.000Z")

  # ── ٥) صندوق الإرسال: لا فقدان، لا تكرار، ترتيب ───────────────────────────────────────────────
  $box = Join-Path $tempDir "outbox"
  Initialize-AmeenInvoiceOutbox -Dir $box
  $st = New-AmeenInvoiceState
  $ev1 = Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s1 @(@{ op = 1; at_utc = "2026-10-20T16:00:00.000Z" }) "2026-10-20T16:00:01.000Z"))
  Add-AmeenOutboxEvents -Dir $box -Events $ev1
  Save-AmeenInvoiceState -Dir $box -State $st
  $ev2 = Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s2 @(@{ op = 3; at_utc = "2026-10-20T16:01:00.000Z" }) "2026-10-20T16:01:01.000Z"))
  Add-AmeenOutboxEvents -Dir $box -Events $ev2
  Save-AmeenInvoiceState -Dir $box -State $st
  $p = Get-AmeenOutboxPending -Dir $box
  Assert 'outbox: two pending in seq order' ($p.Count -eq 2 -and [long]$p[0].event.source_seq -eq 1 -and [long]$p[1].event.source_seq -eq 2)
  Assert 'outbox: event survives JSON round trip (bill guid, version)' ($p[1].event.bill_guid -eq $G1.ToLowerInvariant() -and $p[1].event.version_hash -eq $ev2[0].version_hash)
  Assert 'outbox: no temp files left' (@(Get-ChildItem -LiteralPath (Join-Path $box "pending") -Filter "*.tmp-*").Count -eq 0)

  $reloaded = Read-AmeenInvoiceState -Dir $box
  Assert 'state: last_seq persisted' ($reloaded.last_seq -eq 2)
  Assert 'state: bill version persisted' ($reloaded.bills[$G1.ToLowerInvariant()].v -eq $ev2[0].version_hash)
  $e = Resolve-AmeenInvoiceChanges -State $reloaded -Observations @((& $obs $s2 @() "2026-10-20T16:02:00.000Z"))
  Assert 'restart: same content after restart = no duplicate event' ($e.Count -eq 0)
  Remove-Item -LiteralPath (Join-Path $box "state.json") -Force
  $lost = Read-AmeenInvoiceState -Dir $box
  Assert 'state lost: seq never goes back below pending events' ($lost.last_seq -ge 2)

  # النقل يفشل (انقطاع إنترنت) ⇒ لا شيء يُحذف، وتأجيل تراجعي
  $failTransport = { param($Events) throw "network down" }
  $now = [datetime]::SpecifyKind([datetime]"2026-10-20T16:05:00", [DateTimeKind]::Utc)
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $failTransport -NowUtc $now
  Assert 'offline: error reported' ($r.error -match "network down")
  Assert 'offline: nothing removed' ((Get-AmeenOutboxPending -Dir $box).Count -eq 2)
  Assert 'offline: backoff 2s after first failure' ($st.send.failures -eq 1 -and $st.send.next_at -eq "2026-10-20T16:05:02Z")
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $failTransport -NowUtc $now.AddSeconds(1)
  Assert 'offline: retry waits for backoff' ($r.skipped_backoff)
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $failTransport -NowUtc $now.AddSeconds(3)
  Assert 'offline: backoff grows (4s)' ($st.send.failures -eq 2 -and $st.send.next_at -eq "2026-10-20T16:05:07Z")
  Assert 'backoff capped at 300s' ((Get-AmeenBackoffSeconds 30) -eq 300)

  # الرصد يستمر أثناء الانقطاع: حدث ثالث يتراكم خلف السابقين
  $s3 = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Total 310) -Lines @($L1, $L2)
  Add-AmeenOutboxEvents -Dir $box -Events (Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s3 @(@{ op = 3; at_utc = "2026-10-20T16:06:00.000Z" }) "2026-10-20T16:06:01.000Z")))

  # رد ناقص أو نتيجة غير معروفة ⇒ فشل بلا حذف
  $partial = { param($Events) return @(@{ event_id = $Events[0].event_id; outcome = "applied" }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $partial -NowUtc $now.AddMinutes(10)
  Assert 'partial server reply: treated as failure, nothing removed' ($r.error -match "missing" -and (Get-AmeenOutboxPending -Dir $box).Count -eq 3)
  $weird = { param($Events) return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "rejected" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $weird -NowUtc $now.AddMinutes(20)
  Assert 'unknown outcome: treated as failure' ($r.error -match "unexpected outcome" -and (Get-AmeenOutboxPending -Dir $box).Count -eq 3)

  # عودة الإنترنت ⇒ الكل يُرسل مرة واحدة بالترتيب
  $script:seenSeqs = @()
  $ok = { param($Events) $script:seenSeqs += @($Events | ForEach-Object { [long]$_.source_seq }); return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "applied" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $ok -NowUtc $now.AddMinutes(30)
  Assert 'online again: all 3 acked' ($r.acked -eq 3 -and -not $r.error)
  Assert 'online again: sent strictly in seq order' (($script:seenSeqs -join ",") -eq "1,2,3")
  Assert 'online again: outbox empty' ((Get-AmeenOutboxPending -Dir $box).Count -eq 0)
  Assert 'online again: backoff cleared' ($st.send.failures -eq 0 -and $null -eq $st.send.next_at)
  Assert 'acked log has 3 lines' (@(Get-Content -LiteralPath (Join-Path $box "acked.log")).Count -eq 3)
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $ok -NowUtc $now.AddMinutes(31)
  Assert 'nothing left to resend' ($r.sent -eq 0)

  # الخادم يردّ duplicate/stale/noop ⇒ كلها استلام (لا حلقة إعادة إرسال)
  Add-AmeenOutboxEvents -Dir $box -Events (Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s1 @(@{ op = 3; at_utc = "2026-10-20T16:40:00.000Z" }) "2026-10-20T16:40:01.000Z")))
  $dup = { param($Events) return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "duplicate" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $dup -NowUtc $now.AddMinutes(40)
  Assert 'duplicate reply acknowledged' ($r.acked -eq 1 -and (Get-AmeenOutboxPending -Dir $box).Count -eq 0)

  # ── ٦) الوكيل: يُحلَّل بلا أخطاء، ولا يسجّل مهمة، ولا يرسل افتراضياً ───────────────────────────
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($agentPath, [ref]$tokens, [ref]$errors)
  Assert 'agent parses without errors' ($errors.Count -eq 0)
  $agentText = Get-Content -Raw -LiteralPath $agentPath -Encoding UTF8
  Assert 'agent never registers a scheduled task' ($agentText -notmatch '(?i)Register-ScheduledTask|schtasks')
  Assert 'agent never reads the write connection string' ($agentText -notmatch 'AMEEN_SQL_WRITE_CONNECTION_STRING|WRITE_CONNECTION')
  Assert 'agent sends only with -Send AND the owner flag file' ($agentText -match 'if \(-not \$Send\) \{ return \$false \}' -and $agentText -match 'send-enabled\.flag')
  Assert 'agent runs every SQL through the read-only guard' ($agentText -match 'Assert-AmeenReadOnlySql \$Sql' -and $agentText -notmatch 'ExecuteNonQuery|ExecuteReader|ExecuteScalar')
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ("Ameen invoice events: {0} PASS, {1} FAIL" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
exit 0
