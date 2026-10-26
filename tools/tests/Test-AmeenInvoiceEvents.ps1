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
  $seq0 = [long]$state.last_seq
  Assert 'new state: sequence seeded from the clock (never restarts at 1)' ($seq0 -gt 1700000000000)
  $obs = { param($snap, $ops, $at) @{ guid = $G1; snapshot = $snap; ops = @($ops); detected_at_utc = $at; source = "incremental"; source_create_utc = "2026-10-20T15:25:06.000Z" } }
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @(@{ op = 1; at_utc = "2026-10-20T15:25:07.000Z" }) "2026-10-20T15:25:08.000Z"))
  Assert 'create: one upsert event' ($e.Count -eq 1 -and $e[0].kind -eq "upsert" -and $e[0].change -eq "created")
  Assert 'create: source time = log time' ($e[0].source_event_at -eq "2026-10-20T15:25:07.000Z")
  Assert 'create: event_id = sha256(guid|seq|kind|version|at) (same formula as the server)' ($e[0].event_id -eq (Get-AmeenSha256Hex ("{0}|{1}|upsert|{2}|2026-10-20T15:25:07.000Z" -f $G1.ToLowerInvariant(), ($seq0 + 1), $e[0].version_hash)))
  Assert 'create: seq = seed + 1' ($e[0].source_seq -eq ($seq0 + 1))
  $createId = $e[0].event_id

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @() "2026-10-20T15:25:10.000Z"), (& $obs $s1r @() "2026-10-20T15:25:12.000Z"))
  Assert 'same content seen again (twice, any line order): no event' ($e.Count -eq 0)

  $s2 = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Total 300) -Lines @($L1b, $L2)
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s2 @(@{ op = 3; at_utc = "2026-10-20T15:30:00.000Z" }, @{ op = 100; at_utc = "2026-10-20T15:30:00.500Z" }) "2026-10-20T15:30:02.000Z"))
  Assert 'edit: one updated event for the SAME bill_guid' ($e.Count -eq 1 -and $e[0].change -eq "updated" -and $e[0].bill_guid -eq $G1.ToLowerInvariant())
  Assert 'edit: new version, new event id' ($e[0].version_hash -ne (Get-AmeenInvoiceVersionHash $s1) -and $e[0].event_id -ne $createId)
  Assert 'edit: source time = latest op' ($e[0].source_event_at -eq "2026-10-20T15:30:00.500Z")
  Assert 'edit: seq increases' ($e[0].source_seq -eq ($seq0 + 2))
  Assert 'state: still one bill tracked' ($state.bills.Count -eq 1)

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $s1 @(@{ op = 3; at_utc = "2026-10-20T15:31:00.000Z" }) "2026-10-20T15:31:01.000Z"))
  Assert 'revert to earlier content: emitted (not treated as duplicate)' ($e.Count -eq 1 -and $e[0].event_id -ne $createId -and $e[0].version_hash -eq (Get-AmeenInvoiceVersionHash $s1))

  # ملاحظة المالك (2): A ← B ← A بنفس وقت المصدر تماماً — المفتاح يحمل التسلسل فلا يتطابق مع A الأول.
  $abaState = New-AmeenInvoiceState
  $sameAt = "2026-10-20T15:35:00.000Z"
  $aba = @()
  foreach ($snap in @($s1, $s2, $s1)) { $aba += Resolve-AmeenInvoiceChanges -State $abaState -Observations @((& $obs $snap @(@{ op = 3; at_utc = $sameAt }) "2026-10-20T15:35:01.000Z")) }
  Assert 'A->B->A same timestamp: three events' ($aba.Count -eq 3)
  Assert 'A->B->A same timestamp: last A key differs from first A key' ($aba[0].version_hash -eq $aba[2].version_hash -and $aba[0].event_id -ne $aba[2].event_id)
  Assert 'A->B->A same timestamp: all keys distinct' (@($aba | ForEach-Object { $_.event_id } | Sort-Object -Unique).Count -eq 3)
  Assert 'A->B->A same timestamp: strictly increasing seq' ($aba[0].source_seq -lt $aba[1].source_seq -and $aba[1].source_seq -lt $aba[2].source_seq)
  Assert 'event key contains the bill guid and seq, not content alone' ((Get-AmeenInvoiceEventId -BillGuid "x" -Seq 5 -Kind "upsert" -VersionHash "h" -SourceEventAt "t") -ne (Get-AmeenInvoiceEventId -BillGuid "x" -Seq 6 -Kind "upsert" -VersionHash "h" -SourceEventAt "t") -and (Get-AmeenInvoiceEventId -BillGuid "x" -Seq 5 -Kind "upsert" -VersionHash "h" -SourceEventAt "t") -ne (Get-AmeenInvoiceEventId -BillGuid "y" -Seq 5 -Kind "upsert" -VersionHash "h" -SourceEventAt "t"))

  $unposted = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Posted 0) -Lines @($L1, $L2)
  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $unposted @(@{ op = 9; at_utc = "2026-10-20T15:32:00.000Z" }) "2026-10-20T15:32:01.000Z"))
  Assert 'unpost: emitted as update with is_posted=false' ($e.Count -eq 1 -and $e[0].change -eq "updated" -and -not $e[0].bill.is_posted)

  $e = Resolve-AmeenInvoiceChanges -State $state -Observations @((& $obs $null @(@{ op = 2; at_utc = "2026-10-20T15:40:00.000Z" }) "2026-10-20T15:40:01.000Z"))
  Assert 'delete: one delete event' ($e.Count -eq 1 -and $e[0].kind -eq "delete" -and $e[0].version_hash -eq "deleted")
  Assert 'delete: event id formula' ($e[0].event_id -eq (Get-AmeenSha256Hex ("{0}|{1}|delete|deleted|2026-10-20T15:40:00.000Z" -f $G1.ToLowerInvariant(), $e[0].source_seq)))
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
  $b0 = [long]$st.last_seq
  $ev1 = Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s1 @(@{ op = 1; at_utc = "2026-10-20T16:00:00.000Z" }) "2026-10-20T16:00:01.000Z"))
  Add-AmeenOutboxEvents -Dir $box -Events $ev1
  Save-AmeenInvoiceState -Dir $box -State $st
  $ev2 = Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s2 @(@{ op = 3; at_utc = "2026-10-20T16:01:00.000Z" }) "2026-10-20T16:01:01.000Z"))
  Add-AmeenOutboxEvents -Dir $box -Events $ev2
  Save-AmeenInvoiceState -Dir $box -State $st
  $p = @(Get-AmeenOutboxPending -Dir $box)
  Assert 'outbox: two pending in seq order' ($p.Count -eq 2 -and [long]$p[0].event.source_seq -eq ($b0 + 1) -and [long]$p[1].event.source_seq -eq ($b0 + 2))
  Assert 'outbox: event survives JSON round trip (bill guid, version)' ($p[1].event.bill_guid -eq $G1.ToLowerInvariant() -and $p[1].event.version_hash -eq $ev2[0].version_hash)
  Assert 'outbox: no temp files left' (@(Get-ChildItem -LiteralPath (Join-Path $box "pending") -Filter "*.tmp-*").Count -eq 0)

  $reloaded = Read-AmeenInvoiceState -Dir $box
  Assert 'state: last_seq persisted' ($reloaded.last_seq -eq ($b0 + 2))
  Assert 'state: bill version persisted' ($reloaded.bills[$G1.ToLowerInvariant()].v -eq $ev2[0].version_hash)
  $e = Resolve-AmeenInvoiceChanges -State $reloaded -Observations @((& $obs $s2 @() "2026-10-20T16:02:00.000Z"))
  Assert 'restart: same content after restart = no duplicate event' ($e.Count -eq 0)
  Remove-Item -LiteralPath (Join-Path $box "state.json") -Force
  $lost = Read-AmeenInvoiceState -Dir $box
  Assert 'state lost: seq never goes back below pending events' ($lost.last_seq -ge ($b0 + 2))
  $later = New-AmeenInvoiceState -NowUtc ([datetime]::UtcNow.AddSeconds(5))
  Assert 'state lost with empty outbox: clock seed is above every earlier seq' ($later.last_seq -gt ($b0 + 2))

  # النقل يفشل (انقطاع إنترنت) ⇒ لا شيء يُحذف، وتأجيل تراجعي
  $failTransport = { param($Events) throw "network down" }
  $now = [datetime]::SpecifyKind([datetime]"2026-10-20T16:05:00", [DateTimeKind]::Utc)
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $failTransport -NowUtc $now
  Assert 'offline: error reported' ($r.error -match "network down")
  Assert 'offline: nothing removed' (@(Get-AmeenOutboxPending -Dir $box).Count -eq 2)
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
  Assert 'partial server reply: treated as failure, nothing removed' ($r.error -match "missing" -and @(Get-AmeenOutboxPending -Dir $box).Count -eq 3)
  $weird = { param($Events) return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "exploded" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $weird -NowUtc $now.AddMinutes(20)
  Assert 'unknown outcome: treated as failure' ($r.error -match "unexpected outcome" -and @(Get-AmeenOutboxPending -Dir $box).Count -eq 3)

  # عودة الإنترنت ⇒ الكل يُرسل مرة واحدة بالترتيب
  $script:seenSeqs = @()
  $ok = { param($Events) $script:seenSeqs += @($Events | ForEach-Object { [long]$_.source_seq }); return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "applied" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $ok -NowUtc $now.AddMinutes(30)
  Assert 'online again: all 3 acked' ($r.acked -eq 3 -and -not $r.error)
  Assert 'online again: sent strictly in seq order' (($script:seenSeqs -join ",") -eq ((@(1, 2, 3) | ForEach-Object { $b0 + $_ }) -join ","))
  Assert 'online again: outbox empty' (@(Get-AmeenOutboxPending -Dir $box).Count -eq 0)
  Assert 'online again: backoff cleared' ($st.send.failures -eq 0 -and $null -eq $st.send.next_at)
  Assert 'acked log has 3 lines' (@(Get-Content -LiteralPath (Join-Path $box "acked.log")).Count -eq 3)
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $ok -NowUtc $now.AddMinutes(31)
  Assert 'nothing left to resend' ($r.sent -eq 0)

  # الخادم يردّ duplicate/stale/noop ⇒ كلها استلام (لا حلقة إعادة إرسال)
  Add-AmeenOutboxEvents -Dir $box -Events (Resolve-AmeenInvoiceChanges -State $st -Observations @((& $obs $s1 @(@{ op = 3; at_utc = "2026-10-20T16:40:00.000Z" }) "2026-10-20T16:40:01.000Z")))
  $dup = { param($Events) return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "duplicate" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $box -State $st -Transport $dup -NowUtc $now.AddMinutes(40)
  Assert 'duplicate reply acknowledged' ($r.acked -eq 1 -and @(Get-AmeenOutboxPending -Dir $box).Count -eq 0)

  # ── ٥ب) مراجعة المالك P1: عزل الأحداث المعطوبة (Dead Letter) دون إفشال الدفعة ────────────────
  $dbox = Join-Path $tempDir "outbox-deadletter"
  Initialize-AmeenInvoiceOutbox -Dir $dbox
  $ds = New-AmeenInvoiceState
  $G2 = "C0000000-0000-0000-0000-000000000002"; $G3 = "C0000000-0000-0000-0000-000000000003"
  $obsG = { param($g, $snap, $at) @{ guid = $g; snapshot = $snap; ops = @(@{ op = 1; at_utc = $at }); detected_at_utc = $at } }
  $good1 = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G1 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G1) -Lines @($L1)) "2026-10-20T17:00:00.000Z"))
  # حدث بتاريخ مستقبلي (ساعة الجهاز خاطئة مثلاً): مفتاحه صحيح لكن وقته بعد الآن + 5 دقائق
  $future = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G2 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G2) -Lines @($L1)) "2027-01-01T00:00:00.000Z"))
  $good2 = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G3 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G3) -Lines @($L2)) "2026-10-20T17:00:02.000Z"))
  # حدث محتواه عُبث به بعد البصمة (المبلغ تغيّر والبصمة قديمة)
  $tampered = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G1 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G1 -Total 999) -Lines @($L1)) "2026-10-20T17:00:03.000Z"))
  $tampered[0].bill.total = 1.0
  Add-AmeenOutboxEvents -Dir $dbox -Events @($good1 + $future + $good2 + $tampered)
  $nowD = [datetime]::SpecifyKind([datetime]"2026-10-20T17:05:00", [DateTimeKind]::Utc)
  Assert 'validate: future timestamp flagged' ((Test-AmeenInvoiceEvent -InvoiceEvent $future[0] -NowUtc $nowD).code -eq "future")
  Assert 'validate: tampered content flagged' ((Test-AmeenInvoiceEvent -InvoiceEvent $tampered[0] -NowUtc $nowD).code -eq "version_hash")
  Assert 'validate: good event passes' ($null -eq (Test-AmeenInvoiceEvent -InvoiceEvent $good1[0] -NowUtc $nowD))
  $forged = @{}; foreach ($k in $good1[0].Keys) { $forged[$k] = $good1[0][$k] }; $forged.source_seq = [long]$good1[0].source_seq + 99
  Assert 'validate: forged seq (key mismatch) flagged' ((Test-AmeenInvoiceEvent -InvoiceEvent $forged -NowUtc $nowD).code -eq "event_id")

  # الخادم يرفض حدثاً سليماً محلياً (قاعدة على الخادم وحده) ⇒ يُعزل هو فقط
  $script:dlSent = @()
  $mixed = { param($Events)
    $script:dlSent += @($Events | ForEach-Object { [long]$_.source_seq })
    $i = 0
    return @($Events | ForEach-Object { $i++
      if ($_.bill_guid -eq $G3.ToLowerInvariant()) { @{ event_id = $_.event_id; index = $i; outcome = "rejected"; reason_code = "22023"; reason = "bill snapshot too large" } }
      else { @{ event_id = $_.event_id; index = $i; outcome = "applied" } } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $mixed -NowUtc $nowD
  Assert 'mixed batch: no batch failure' ($null -eq $r.error)
  Assert 'mixed batch: valid event acked' ($r.acked -eq 1)
  Assert 'mixed batch: 3 dead-lettered (future + tampered locally, 1 by server)' ($r.deadlettered -eq 3)
  Assert 'mixed batch: locally invalid events never sent' (-not ($script:dlSent -contains [long]$future[0].source_seq) -and -not ($script:dlSent -contains [long]$tampered[0].source_seq))
  Assert 'mixed batch: outbox empty, nothing lost' (@(Get-AmeenOutboxPending -Dir $dbox).Count -eq 0 -and (@(Get-AmeenDeadLetters -Dir $dbox).Count + $r.acked) -eq 4)
  $dl = @(Get-AmeenDeadLetters -Dir $dbox)
  Assert 'dead letter: reason and id recorded' (@($dl | Where-Object { $_.reason_code -eq "future" -and $_.event_id -eq $future[0].event_id -and $_.source -eq "local" }).Count -eq 1)
  Assert 'dead letter: server reason recorded' (@($dl | Where-Object { $_.reason_code -eq "22023" -and $_.source -eq "server" }).Count -eq 1)
  $reasonText = (Get-ChildItem -LiteralPath (Join-Path $dbox "deadletter") -Filter "*.reason.json" | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n"
  $logText = Get-Content -Raw -LiteralPath (Join-Path $dbox "deadletter.log")
  Assert 'dead letter: no sensitive data in reasons or log (no customer name, no amounts)' ($reasonText -notmatch 'customer_name|زبون|"total"|lines' -and $logText -notmatch 'زبون|customer_name')
  Assert 'dead letter: original event kept for repair' (Test-Path -LiteralPath $dl[0].file)

  # إصلاح ١: Requeue بعد تصحيح الوقت المستقبلي — يعود بتسلسله الأصلي
  $fe = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath (@($dl | Where-Object { $_.reason_code -eq "future" })[0].file) -Encoding UTF8 | ConvertFrom-Json)
  $fe.source_event_at = "2026-10-20T17:00:01.000Z"; $fe.detected_at = "2026-10-20T17:00:01.000Z"
  Write-AmeenAtomicFile -Path (@($dl | Where-Object { $_.reason_code -eq "future" })[0].file) -Content (ConvertTo-AmeenCanonicalJson $fe)
  $futureSeq = [long]$future[0].source_seq
  Assert 'repair requeue: accepted' ((Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $futureSeq -Mode Requeue -NowUtc $nowD) -eq "Requeue")
  $rq = @(Get-AmeenOutboxPending -Dir $dbox)
  Assert 'repair requeue: back in pending with ORIGINAL seq' ($rq.Count -eq 1 -and [long]$rq[0].event.source_seq -eq $futureSeq)
  Assert 'repair requeue: key recomputed and valid' ($null -eq (Test-AmeenInvoiceEvent -InvoiceEvent $rq[0].event -NowUtc $nowD) -and $rq[0].event.event_id -ne $future[0].event_id)
  Assert 'repair requeue: removed from dead letter, kept in resolved' (@(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $futureSeq }).Count -eq 0 -and @(Get-ChildItem -LiteralPath (Join-Path $dbox "deadletter\resolved") -Filter "*requeue*").Count -eq 2)
  $r = Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $mixed -NowUtc $nowD
  Assert 'repair requeue: sent and acked' ($r.acked -eq 1 -and @(Get-AmeenOutboxPending -Dir $dbox).Count -eq 0)

  # إصلاح يبقى معطوباً ⇒ يُرفض ويبقى معزولاً (لا يضيع)
  $tamperSeq = [long]$tampered[0].source_seq
  $tdl = @(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $tamperSeq })[0]
  $te = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath $tdl.file -Encoding UTF8 | ConvertFrom-Json)
  $te.bill.bill_type = 7
  Write-AmeenAtomicFile -Path $tdl.file -Content (ConvertTo-AmeenCanonicalJson $te)
  Assert 'repair requeue of still-broken event refused' (Throws { Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $tamperSeq -Mode Requeue -NowUtc $nowD })
  Assert 'refused repair stays in dead letter (not lost, not queued)' (@(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $tamperSeq }).Count -eq 1 -and @(Get-AmeenOutboxPending -Dir $dbox).Count -eq 0)

  # ── ٥ج) Codex P1-1: طابور Resnapshot دائم لفاتورة أقدم من 60 يوماً، بقراءة مباشرة بالـGUID ─────
  $G9 = "C0000000-0000-0000-0000-000000000009"; $g9l = $G9.ToLowerInvariant()
  $oldHeader = New-Header -Guid $G9 -Total 410
  $oldHeader.Date = [datetime]"2026-06-15"                          # أقدم من نافذة المطابقة (60 يوماً)
  $oldSnap = ConvertTo-AmeenInvoiceSnapshot -Header $oldHeader -Lines @($L1)
  # حدث للفاتورة القديمة رفضه الخادم ⇒ معزول
  $oldEvt = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G9 $oldSnap "2026-10-20T17:10:00.000Z"))
  Add-AmeenOutboxEvents -Dir $dbox -Events $oldEvt
  $rejectAll = { param($Events) $i = 0; return @($Events | ForEach-Object { $i++; @{ event_id = $_.event_id; index = $i; outcome = "rejected"; reason_code = "22023"; reason = "bill snapshot too large" } }) }
  $r = Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $rejectAll -NowUtc $nowD
  $oldSeq = [long]$oldEvt[0].source_seq
  Assert 'old invoice: rejected event isolated' ($r.deadlettered -eq 1 -and @(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $oldSeq }).Count -eq 1)
  # الحالة لا تعرف الفاتورة بعد الآن (خرجت من نافذة المطابقة) — لا يجوز أن يعتمد الإصلاح على النافذة
  $ds.bills.Remove($g9l)
  $seqBefore = [long]$ds.last_seq
  Assert 'resnapshot request: queued' ((Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $oldSeq -Mode Resnapshot -NowUtc $nowD) -eq "ResnapshotQueued")
  $second = $null; try { $second = Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $oldSeq -Mode Resnapshot -NowUtc $nowD } catch { $second = "threw" }
  Assert 'resnapshot request: second request does not duplicate it' ($second -eq "ResnapshotQueued" -and @(Get-AmeenDeadLetters -Dir $dbox | Where-Object { $_.status -eq "resnapshot_pending" }).Count -eq 1)
  Assert 'resnapshot request: NOT closed early (still in dead letter, not in resolved)' (@(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $oldSeq -and $_.status -eq "resnapshot_pending" }).Count -eq 1 -and @(Get-ChildItem -LiteralPath (Join-Path $dbox "deadletter\resolved") -Filter ("{0:D12}.resnapshot*" -f $oldSeq) -ErrorAction SilentlyContinue).Count -eq 0)
  Assert 'resnapshot request: survives losing state.json (stored with the dead letter)' (@(Get-AmeenDeadLetters -Dir $dbox | Where-Object { $_.status -eq "resnapshot_pending" -and $_.bill_guid -eq $g9l }).Count -eq 1)

  # قراءة الأمين تفشل ⇒ الطلب يبقى ولا حدث
  $script:readerCalls = @()
  $failReader = { param($Guid) $script:readerCalls += $Guid; return @{ status = "error"; error = "SqlException 1222" } }
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader $failReader -NowUtc $nowD
  Assert 'resnapshot read failure: request kept, no event' ($q.failed -eq 1 -and $q.emitted -eq 0 -and @(Get-AmeenOutboxPending -Dir $dbox).Count -eq 0 -and @(Get-AmeenDeadLetters -Dir $dbox | Where-Object { $_.status -eq "resnapshot_pending" -and [int]$_.attempts -eq 1 -and $_.last_error -eq "SqlException 1222" }).Count -eq 1)
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader $failReader -NowUtc $nowD.AddSeconds(10)
  Assert 'resnapshot read failure: retry waits (no hammering Ameen)' ($q.waiting -eq 1 -and $script:readerCalls.Count -eq 1)
  # استثناء من القارئ نفسه ⇒ لا يُسقط الوكيل، والطلب يبقى
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader { param($Guid) throw "connection reset" } -NowUtc $nowD.AddMinutes(2)
  Assert 'resnapshot reader exception: contained, request kept' ($q.failed -eq 1 -and @(Get-AmeenDeadLetters -Dir $dbox | Where-Object { $_.status -eq "resnapshot_pending" }).Count -eq 1)

  # قراءة مباشرة بالـGUID تنجح (فاتورة 2026-06-15، خارج النافذة) ⇒ حدث بتسلسل أحدث، ثم يُغلق الطلب
  $okReader = { param($Guid) $script:readerCalls += $Guid
    $h = New-Header -Guid $Guid -Total 410; $h.Date = [datetime]"2026-06-15"
    return @{ status = "found"; observation = @{ guid = $Guid; snapshot = (ConvertTo-AmeenInvoiceSnapshot -Header $h -Lines @($L1)); ops = @(); detected_at_utc = "2026-10-20T17:20:00.000Z"; source = "resnapshot" } } }
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader $okReader -NowUtc $nowD.AddMinutes(4)
  Assert 'resnapshot: reader called with the exact bill GUID (direct read, no date window)' ($script:readerCalls[-1] -eq $g9l)
  $pq = @(Get-AmeenOutboxPending -Dir $dbox | Where-Object { $_.event.bill_guid -eq $g9l })
  Assert 'resnapshot: exactly one new event in outbox' ($q.emitted -eq 1 -and $pq.Count -eq 1)
  Assert 'resnapshot: new seq is newer than the isolated event and every earlier seq' ([long]$pq[0].event.source_seq -gt $oldSeq -and [long]$pq[0].event.source_seq -gt $seqBefore)
  Assert 'resnapshot: event carries the old bill (date outside the 60-day window)' ($pq[0].event.bill.bill_date -eq "2026-06-15" -and $pq[0].event.kind -eq "upsert")
  Assert 'resnapshot: new event is valid' ($null -eq (Test-AmeenInvoiceEvent -InvoiceEvent $pq[0].event -NowUtc $nowD.AddMinutes(30)))
  Assert 'resnapshot: request closed only after the event was written' (@(Get-AmeenDeadLetters -Dir $dbox | Where-Object { [long]$_.source_seq -eq $oldSeq }).Count -eq 0 -and @(Get-ChildItem -LiteralPath (Join-Path $dbox "deadletter\resolved") -Filter ("{0:D12}.resnapshot*" -f $oldSeq)).Count -eq 2)
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader $okReader -NowUtc $nowD.AddMinutes(6)
  Assert 'resnapshot: running the queue again creates no duplicate event' ($q.emitted -eq 0 -and @(Get-AmeenOutboxPending -Dir $dbox | Where-Object { $_.event.bill_guid -eq $g9l }).Count -eq 1)
  [void](Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $mixed -NowUtc $nowD.AddMinutes(7))

  # انقطاع بعد كتابة الحدث وقبل إغلاق الطلب ⇒ يُغلق الطلب بلا حدث ثانٍ
  $G8 = "C0000000-0000-0000-0000-000000000008"; $g8l = $G8.ToLowerInvariant()
  $e8 = Resolve-AmeenInvoiceChanges -State $ds -Observations @((& $obsG $G8 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G8) -Lines @($L1)) "2026-10-20T17:30:00.000Z"))
  Add-AmeenOutboxEvents -Dir $dbox -Events $e8
  [void](Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $rejectAll -NowUtc $nowD.AddMinutes(8))
  $s8 = [long]$e8[0].source_seq
  [void](Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $s8 -Mode Resnapshot -NowUtc $nowD.AddMinutes(8))
  $crashEvt = Resolve-AmeenInvoiceChanges -State $ds -Observations @(@{ guid = $G8; snapshot = (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G8 -Total 5) -Lines @($L1)); ops = @(); detected_at_utc = "2026-10-20T17:31:00.000Z" })
  Add-AmeenOutboxEvents -Dir $dbox -Events $crashEvt                # كُتب الحدث ثم «انقطع التيار» قبل الإغلاق
  $script:readerCalls = @()
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader $okReader -NowUtc $nowD.AddMinutes(9)
  Assert 'resnapshot after crash: closed using the event already in outbox' ($q.completed -eq 1 -and $q.emitted -eq 0 -and $script:readerCalls.Count -eq 0)
  Assert 'resnapshot after crash: no duplicate event' (@(Get-AmeenOutboxPending -Dir $dbox | Where-Object { $_.event.bill_guid -eq $g8l }).Count -eq 1)

  # الفاتورة لم تعد موجودة في الأمين ⇒ حدث delete، ويُغلق الطلب
  [void](Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $rejectAll -NowUtc $nowD.AddMinutes(10))
  $s8b = [long]$crashEvt[0].source_seq
  [void](Repair-AmeenDeadLetter -Dir $dbox -State $ds -Seq $s8b -Mode Resnapshot -NowUtc $nowD.AddMinutes(10))
  $q = Invoke-AmeenResnapshotQueue -Dir $dbox -State $ds -Reader { param($Guid) @{ status = "missing"; observation = @{ guid = $Guid; snapshot = $null; ops = @(); detected_at_utc = "2026-10-20T17:40:00.000Z" } } } -NowUtc $nowD.AddMinutes(11)
  $del = @(Get-AmeenOutboxPending -Dir $dbox | Where-Object { $_.event.bill_guid -eq $g8l })
  Assert 'resnapshot of a bill gone from Ameen: delete event, request closed' ($q.emitted -eq 1 -and $del.Count -eq 1 -and $del[0].event.kind -eq "delete" -and [long]$del[0].event.source_seq -gt $s8b)
  [void](Send-AmeenInvoiceOutbox -Dir $dbox -State $ds -Transport $mixed -NowUtc $nowD.AddMinutes(12))

  # ── ٥د) Codex P1-2: ملف JSON مقطوع في pending لا يوقف الوكيل ──────────────────────────────────
  $nowC = [datetime]::SpecifyKind([datetime]"2026-10-20T18:05:00", [DateTimeKind]::Utc)
  $cbox = Join-Path $tempDir "outbox-corrupt"
  Initialize-AmeenInvoiceOutbox -Dir $cbox
  $cs = New-AmeenInvoiceState
  $cGood = Resolve-AmeenInvoiceChanges -State $cs -Observations @((& $obsG $G1 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G1) -Lines @($L1)) "2026-10-20T18:00:00.000Z"))
  $cGood2 = Resolve-AmeenInvoiceChanges -State $cs -Observations @((& $obsG $G2 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G2) -Lines @($L1)) "2026-10-20T18:00:01.000Z"))
  Add-AmeenOutboxEvents -Dir $cbox -Events @($cGood + $cGood2)
  # ملف مقطوع بتسلسل أصغر من السليمين (أول ما يُقرأ) — كتابة انقطعت في منتصفها
  $goodText = ConvertTo-AmeenCanonicalJson $cGood[0]
  $truncName = ([long]$cGood[0].source_seq - 1).ToString("D12") + ".json"
  $truncPath = Join-Path (Join-Path $cbox "pending") $truncName
  $truncBytes = [Text.Encoding]::UTF8.GetBytes($goodText.Substring(0, [int]($goodText.Length / 2)))
  [IO.File]::WriteAllBytes($truncPath, $truncBytes)
  [IO.File]::WriteAllText((Join-Path (Join-Path $cbox "pending") (([long]$cGood[0].source_seq - 2).ToString("D12") + ".json")), "   ")
  $script:cSent = @()
  $okT = { param($Events) $script:cSent += @($Events | ForEach-Object { [long]$_.source_seq }); return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "applied" } }) }
  $r = $null
  Assert 'corrupt json: send does not throw' (-not (Throws { $script:cr = Send-AmeenInvoiceOutbox -Dir $cbox -State $cs -Transport $okT -NowUtc $nowC }))
  $r = $script:cr
  Assert 'corrupt json: valid events sent and acked' ($r.acked -eq 2 -and -not $r.error)
  Assert 'corrupt json: valid events still sent in seq order' (($script:cSent -join ",") -eq ("{0},{1}" -f $cGood[0].source_seq, $cGood2[0].source_seq))
  Assert 'corrupt json: truncated and empty files isolated' ($r.deadlettered -eq 2 -and @(Get-AmeenOutboxPending -Dir $cbox).Count -eq 0)
  $cdl = @(Get-AmeenDeadLetters -Dir $cbox)
  $tdlc = @($cdl | Where-Object { $_.file_name -eq $truncName })[0]
  Assert 'corrupt json: reason, file name and safe id recorded' ($tdlc.reason_code -eq "unreadable_json" -and $tdlc.source_seq -eq ([string]([long]$cGood[0].source_seq - 1)) -and $tdlc.bill_guid -eq $G1.ToLowerInvariant())
  Assert 'corrupt json: isolated file preserved byte-for-byte (not deleted)' ([Convert]::ToBase64String([IO.File]::ReadAllBytes($tdlc.file)) -eq [Convert]::ToBase64String($truncBytes))
  $cReason = Get-Content -Raw -LiteralPath $tdlc.reason_file; $cLog = Get-Content -Raw -LiteralPath (Join-Path $cbox "deadletter.log")
  Assert 'corrupt json: no file content or bill data in reason or log' ($cReason -notmatch 'زبون|customer_name|"total"|lines|schema' -and $cLog -notmatch 'زبون|customer_name|"total"|lines')
  # الوكيل يستمر: حدث جديد بعد العزل يُرسل عادياً
  Add-AmeenOutboxEvents -Dir $cbox -Events (Resolve-AmeenInvoiceChanges -State $cs -Observations @((& $obsG $G3 (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G3) -Lines @($L2)) "2026-10-20T18:01:00.000Z")))
  $r = Send-AmeenInvoiceOutbox -Dir $cbox -State $cs -Transport $okT -NowUtc $nowC.AddMinutes(1)
  Assert 'corrupt json: agent keeps working (next event acked)' ($r.acked -eq 1 -and $r.deadlettered -eq 0)
  Assert 'corrupt json: requeue of still-unreadable file refused, kept isolated' ((Throws { Repair-AmeenDeadLetter -Dir $cbox -State $cs -Seq ([long]$cGood[0].source_seq - 1) -Mode Requeue -NowUtc $nowC }) -and @(Get-AmeenDeadLetters -Dir $cbox | Where-Object { $_.file_name -eq $truncName }).Count -eq 1)
  # ملف JSON صالح لكنه ليس كائناً ⇒ يُعزل كذلك
  [IO.File]::WriteAllText((Join-Path (Join-Path $cbox "pending") "999999999999999.json"), "[1,2,3]")
  $r = Send-AmeenInvoiceOutbox -Dir $cbox -State $cs -Transport $okT -NowUtc $nowC.AddMinutes(2)
  Assert 'non-object json isolated' ($r.deadlettered -eq 1 -and @(Get-AmeenOutboxPending -Dir $cbox).Count -eq 0)
  # state.json تالف لا يوقف الوكيل: يُنقل جانباً ويبدأ تسلسل أعلى من كل سابق
  $maxSeen = [long]$cs.last_seq
  Save-AmeenInvoiceState -Dir $cbox -State $cs
  [IO.File]::WriteAllText((Join-Path $cbox "state.json"), '{"schema":"ameen-invoice-agent-st')
  $rec = $null
  Assert 'corrupt state.json: read does not throw' (-not (Throws { $script:rec = Read-AmeenInvoiceState -Dir $cbox }))
  Assert 'corrupt state.json: moved aside, not deleted' (@(Get-ChildItem -LiteralPath $cbox -Filter "state.corrupt-*.json").Count -eq 1)
  Assert 'corrupt state.json: new seq above every earlier seq' ([long]$script:rec.last_seq -gt $maxSeen)

  # ── ٥هـ) Codex P1 (da7413e8): حدّ الدفعة بالبايتات تحت حدّ الخادم 4MB ───────────────────────────
  Assert 'batch byte limit: default is below the server 4MB request limit' ([int]$script:AmeenMaxBatchBytes -gt 0 -and [int]$script:AmeenMaxBatchBytes -lt 4194304)
  $bbox = Join-Path $tempDir "outbox-bytes"
  Initialize-AmeenInvoiceOutbox -Dir $bbox
  $bs = New-AmeenInvoiceState
  $bigLines = @(1..60 | ForEach-Object { New-Line (($_ % 9) + 1) ("b1000000-0000-0000-0000-{0:D12}" -f $_) })
  $nowB = [datetime]::SpecifyKind([datetime]"2026-10-21T10:00:00", [DateTimeKind]::Utc)
  foreach ($k in 1..12) {
    $gk = "D0000000-0000-0000-0000-{0:D12}" -f $k
    Add-AmeenOutboxEvents -Dir $bbox -Events (Resolve-AmeenInvoiceChanges -State $bs -Observations @((& $obsG $gk (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $gk) -Lines $bigLines) "2026-10-21T09:00:00.000Z")))
  }
  $oneSize = [Text.Encoding]::UTF8.GetByteCount((ConvertTo-AmeenCanonicalJson (@(Get-AmeenOutboxPending -Dir $bbox))[0].event))
  $limit = 4 * $oneSize + 100                                  # يتسع لأربعة أحداث تقريباً
  $script:reqBytes = @(); $script:reqSeqs = @()
  $sizeT = { param($Events)
    $script:reqBytes += [Text.Encoding]::UTF8.GetByteCount((ConvertTo-AmeenCanonicalJson @{ p_events = @($Events) }))
    $script:reqSeqs += @($Events | ForEach-Object { [long]$_.source_seq })
    return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "applied" } }) }
  $calls = 0
  while (@(Get-AmeenOutboxPending -Dir $bbox).Count -gt 0 -and $calls -lt 20) {
    $r = Send-AmeenInvoiceOutbox -Dir $bbox -State $bs -Transport $sizeT -NowUtc $nowB -MaxBatchBytes $limit
    $calls++
    if ($r.acked -eq 0) { break }
  }
  Assert 'batch byte limit: every request body within the byte limit' (@($script:reqBytes | Where-Object { $_ -gt $limit }).Count -eq 0)
  Assert 'batch byte limit: split into several requests, each making progress' ($calls -ge 3 -and @(Get-AmeenOutboxPending -Dir $bbox).Count -eq 0)
  Assert 'batch byte limit: all 12 events delivered exactly once' ($script:reqSeqs.Count -eq 12 -and @($script:reqSeqs | Sort-Object -Unique).Count -eq 12)
  Assert 'batch byte limit: order preserved across requests' ((($script:reqSeqs) -join ",") -eq ((@($script:reqSeqs | Sort-Object)) -join ","))
  # حدث واحد أكبر من الحدّ وحده يُرسل منفرداً ولا يحجز الصندوق
  Add-AmeenOutboxEvents -Dir $bbox -Events (Resolve-AmeenInvoiceChanges -State $bs -Observations @((& $obsG "D0000000-0000-0000-0000-000000000099" (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid "D0000000-0000-0000-0000-000000000099") -Lines $bigLines) "2026-10-21T09:00:00.000Z")))
  $r = Send-AmeenInvoiceOutbox -Dir $bbox -State $bs -Transport $sizeT -NowUtc $nowB -MaxBatchBytes ([int]($oneSize / 2))
  Assert 'batch byte limit: single event larger than the limit still sent alone (no stall)' ($r.acked -eq 1 -and @(Get-AmeenOutboxPending -Dir $bbox).Count -eq 0)
  # الخادم يرفض الطلب لحجمه رغم ذلك ⇒ يُنصَّف سقف العدد، والمحاولة التالية أصغر وتنجح، ثم يعود السقف
  foreach ($k in 20..27) {
    $gk = "D0000000-0000-0000-0000-{0:D12}" -f $k
    Add-AmeenOutboxEvents -Dir $bbox -Events (Resolve-AmeenInvoiceChanges -State $bs -Observations @((& $obsG $gk (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $gk) -Lines @($L1)) "2026-10-21T09:00:00.000Z")))
  }
  $tooLarge = { param($Events) throw "events payload too large (22023)" }
  $r = Send-AmeenInvoiceOutbox -Dir $bbox -State $bs -Transport $tooLarge -NowUtc $nowB
  Assert 'server size rejection: nothing removed, batch cap halved' ($r.error -match "too large" -and @(Get-AmeenOutboxPending -Dir $bbox).Count -eq 8 -and [int]$bs.send.batch_cap -eq 4)
  $script:reqSeqs = @()
  $r = Send-AmeenInvoiceOutbox -Dir $bbox -State $bs -Transport $sizeT -NowUtc $nowB.AddMinutes(5)
  Assert 'server size rejection: next request uses the smaller cap and succeeds' ($r.acked -eq 4 -and $script:reqSeqs.Count -eq 4)
  Assert 'server size rejection: cap cleared after success' ($null -eq $bs.send.batch_cap)
  $r = Send-AmeenInvoiceOutbox -Dir $bbox -State $bs -Transport $sizeT -NowUtc $nowB.AddMinutes(6)
  Assert 'server size rejection: remaining events then delivered' ($r.acked -eq 4 -and @(Get-AmeenOutboxPending -Dir $bbox).Count -eq 0)

  # ── ٥و) Codex P1 (da7413e8): قفل مثيل واحد على مجلد الصندوق ───────────────────────────────────
  $lbox = Join-Path $tempDir "outbox-lock"
  $lock1 = Enter-AmeenOutboxLock -Dir $lbox
  Assert 'outbox lock: first instance acquires' ($null -ne $lock1)
  $lock2 = Enter-AmeenOutboxLock -Dir $lbox
  Assert 'outbox lock: second acquire in the same process refused' ($null -eq $lock2)
  $shell = (Get-Process -Id $PID).Path
  $libPath = Join-Path $repoRoot "tools\ameen-invoice-events-lib.ps1"
  $probeCmd = ". '{0}'; `$l = Enter-AmeenOutboxLock -Dir '{1}'; if (`$null -eq `$l) {{ 'LOCKED' }} else {{ 'ACQUIRED'; Exit-AmeenOutboxLock `$l }}" -f $libPath, $lbox
  $other = (& $shell -NoProfile -Command $probeCmd 2>&1 | Out-String).Trim()
  Assert 'outbox lock: another process is refused while held' ($other -match 'LOCKED')
  # الوكيل نفسه كمثيل ثانٍ: يخرج برمز 5 قبل قراءة الحالة أو أي اتصال، ولا يكتب شيئاً
  $agentLog = Join-Path $tempDir "agent-lock.log"
  & $shell -NoProfile -File $agentPath -Once -OutboxDir $lbox -LogFile $agentLog -EnvFile (Join-Path $tempDir "no.env") *> $null
  $agentExit = $LASTEXITCODE
  Assert 'outbox lock: second agent instance exits with code 5' ($agentExit -eq 5)
  Assert 'outbox lock: refused agent wrote no state or pending files' (-not (Test-Path -LiteralPath (Join-Path $lbox "state.json")) -and -not (Test-Path -LiteralPath (Join-Path $lbox "pending")))
  Exit-AmeenOutboxLock $lock1
  $other = (& $shell -NoProfile -Command $probeCmd 2>&1 | Out-String).Trim()
  Assert 'outbox lock: released lock can be acquired again' ($other -match 'ACQUIRED')

  # ── ٥ز) Codex P1 (7dbd9915): bill_type غير رقمي يُعزل ولا يُسقط الوكيل ──────────────────────────
  $tbox = Join-Path $tempDir "outbox-billtype"
  Initialize-AmeenInvoiceOutbox -Dir $tbox
  $ts = New-AmeenInvoiceState
  $nowT = [datetime]::SpecifyKind([datetime]"2026-10-21T11:00:00", [DateTimeKind]::Utc)
  $tg = @("E1000000-0000-0000-0000-000000000001", "E1000000-0000-0000-0000-000000000002", "E1000000-0000-0000-0000-000000000003")
  $tev = @()
  foreach ($g in $tg) { $tev += Resolve-AmeenInvoiceChanges -State $ts -Observations @((& $obsG $g (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $g) -Lines @($L1)) "2026-10-21T10:00:00.000Z")) }
  $tev[0].bill.bill_type = "abc"                                # نص غير رقمي
  $tev[1].bill.bill_type = 99999999999                          # خارج Int32
  Add-AmeenOutboxEvents -Dir $tbox -Events $tev
  Assert 'bill_type text: validation returns a reason instead of throwing' (-not (Throws { $script:bt1 = Test-AmeenInvoiceEvent -InvoiceEvent (@(Get-AmeenOutboxPending -Dir $tbox))[0].event -NowUtc $nowT }) -and $script:bt1.code -eq "bill")
  Assert 'bill_type out of Int32: validation returns a reason instead of throwing' (-not (Throws { $script:bt2 = Test-AmeenInvoiceEvent -InvoiceEvent (@(Get-AmeenOutboxPending -Dir $tbox))[1].event -NowUtc $nowT }) -and $script:bt2.code -eq "bill")
  $script:tSent = @()
  $okB = { param($Events) $script:tSent += @($Events | ForEach-Object { $_.bill_guid }); return @($Events | ForEach-Object { @{ event_id = $_.event_id; outcome = "applied" } }) }
  Assert 'bad bill_type: send does not throw' (-not (Throws { $script:tr = Send-AmeenInvoiceOutbox -Dir $tbox -State $ts -Transport $okB -NowUtc $nowT }))
  Assert 'bad bill_type: both bad events isolated, valid one sent' ($script:tr.deadlettered -eq 2 -and $script:tr.acked -eq 1 -and $script:tSent.Count -eq 1 -and $script:tSent[0] -eq $tg[2].ToLowerInvariant())
  Assert 'bad bill_type: isolated with code bill, outbox empty' (@(Get-AmeenDeadLetters -Dir $tbox | Where-Object { $_.reason_code -eq "bill" }).Count -eq 2 -and @(Get-AmeenOutboxPending -Dir $tbox).Count -eq 0)

  # ── ٥ح) Codex P1 (7dbd9915): رفض الحجم من جسم استجابة PostgREST (HTTP 400) يُنصّف الدفعة ───────────
  $tcp = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $tcp.Start(); $port = $tcp.LocalEndpoint.Port; $tcp.Stop()
  $server = Start-Job -ArgumentList $port -ScriptBlock {
    param($Port)
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port); $l.Start()
    try {
      foreach ($k in 1..3) {
        $c = $l.AcceptTcpClient(); $st = $c.GetStream(); $st.ReadTimeout = 5000
        $buf = New-Object byte[] 65536; $acc = New-Object System.IO.MemoryStream
        do { $n = $st.Read($buf, 0, $buf.Length); $acc.Write($buf, 0, $n); $txt = [Text.Encoding]::ASCII.GetString($acc.ToArray()) } while ($n -gt 0 -and $txt.IndexOf("`r`n`r`n") -lt 0)
        $hdrEnd = $txt.IndexOf("`r`n`r`n") + 4
        $len = 0; if ($txt -match '(?i)content-length:\s*(\d+)') { $len = [int]$Matches[1] }
        while (($acc.Length - $hdrEnd) -lt $len) { $n = $st.Read($buf, 0, $buf.Length); if ($n -le 0) { break }; $acc.Write($buf, 0, $n) }
        $body = '{"code":"22023","details":null,"hint":null,"message":"events payload too large"}'
        $resp = "HTTP/1.1 400 Bad Request`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: " + $body.Length + "`r`nConnection: close`r`n`r`n" + $body
        $bytes = [Text.Encoding]::ASCII.GetBytes($resp); $st.Write($bytes, 0, $bytes.Length); $st.Flush(); $c.Close()
      }
    } finally { $l.Stop() }
  }
  $up = $false
  foreach ($w in 1..60) { try { $tc = New-Object System.Net.Sockets.TcpClient; $tc.Connect("127.0.0.1", $port); $tc.Close(); $up = $true; break } catch { Start-Sleep -Milliseconds 250 } }
  # (اتصال الفحص أعلاه يستهلك قبولاً واحداً بلا طلب؛ الخادم يقرأ صفراً ويغلق، فيبقى قبولان للطلبين الحقيقيين.)
  Assert 'rpc test server started' ($up)
  $rpcMsg = $null
  try { [void](Invoke-AmeenRpc -Url ("http://127.0.0.1:{0}/rest/v1/rpc/apply_ameen_invoice_events" -f $port) -Headers @{ apikey = "test" } -Body ([Text.Encoding]::UTF8.GetBytes('{"p_events":[]}')) -TimeoutSec 10) } catch { $rpcMsg = $_.Exception.Message }
  Assert 'rpc 400: error message carries status and PostgREST message from the body' ($rpcMsg -match 'HTTP 400' -and $rpcMsg -match '22023' -and $rpcMsg -match 'events payload too large')
  Assert 'rpc 400: details/hint not copied into the message' ($rpcMsg -notmatch 'details|hint')
  $hbox = Join-Path $tempDir "outbox-http400"
  Initialize-AmeenInvoiceOutbox -Dir $hbox
  $hs = New-AmeenInvoiceState
  foreach ($k in 1..6) { $gk = "E2000000-0000-0000-0000-{0:D12}" -f $k; Add-AmeenOutboxEvents -Dir $hbox -Events (Resolve-AmeenInvoiceChanges -State $hs -Observations @((& $obsG $gk (ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $gk) -Lines @($L1)) "2026-10-21T10:00:00.000Z"))) }
  $httpT = { param($Events) $r = Invoke-AmeenRpc -Url ("http://127.0.0.1:{0}/rest/v1/rpc/apply_ameen_invoice_events" -f $port) -Headers @{ apikey = "test" } -Body ([Text.Encoding]::UTF8.GetBytes((ConvertTo-AmeenCanonicalJson @{ p_events = @($Events) }))) -TimeoutSec 10; return @($r.results) }
  $r = Send-AmeenInvoiceOutbox -Dir $hbox -State $hs -Transport $httpT -NowUtc $nowT
  Assert 'http 400 size rejection: batch cap halved (not retried forever at the same size)' ($r.error -match 'payload too large' -and [int]$hs.send.batch_cap -eq 3 -and @(Get-AmeenOutboxPending -Dir $hbox).Count -eq 6)
  Stop-Job $server -ErrorAction SilentlyContinue; Remove-Job $server -Force -ErrorAction SilentlyContinue

  # ── ٥ط) Codex P1 (51783c90): حذف ملف التفعيل يوقف الإرسال في الدورة التالية ─────────────────────
  $fbox = Join-Path $tempDir "outbox-flag"
  Initialize-AmeenInvoiceOutbox -Dir $fbox
  $flagPath = Join-Path $fbox "send-enabled.flag"
  Set-Content -LiteralPath $flagPath -Value "enabled-by-owner" -Encoding ASCII
  Assert 'send switch: on with -Send and the owner flag' (Test-AmeenSendActivated -Dir $fbox -SendRequested)
  Assert 'send switch: off without -Send even when the flag exists (explicit)' (-not (Test-AmeenSendActivated -Dir $fbox))
  Remove-Item -LiteralPath $flagPath -Force
  Assert 'send switch: deleting the flag turns sending off on the next check' (-not (Test-AmeenSendActivated -Dir $fbox -SendRequested))
  Set-Content -LiteralPath $flagPath -Value "yes" -Encoding ASCII
  Assert 'send switch: wrong flag content keeps sending off' (-not (Test-AmeenSendActivated -Dir $fbox -SendRequested))
  # الوكيل يعيد الفحص داخل الحلقة قبل كل دفعة، لا مرة واحدة قبلها
  $loopBody = $agentTextForLoop = (Get-Content -Raw -LiteralPath $agentPath -Encoding UTF8)
  $doIdx = $loopBody.IndexOf("    do {"); $whileIdx = $loopBody.IndexOf("} while (`$true)"); $chkIdx = $loopBody.IndexOf('$sendNow = Test-AmeenSendActivated -Dir $OutboxDir -SendRequested:$Send')
  Assert 'send switch: agent re-checks the flag inside the loop before each send' ($doIdx -gt 0 -and $chkIdx -gt $doIdx -and $chkIdx -lt $whileIdx)

  # ── ٥ي) أداء حفظ الحالة (2026-10-22): الحالة الكاملة عند تغيّرها فقط، والعلامة المائية كل دورة ────
  # JSON القانوني: المسار السريع للنص الذي لا يحتاج هروباً يعطي البايتات نفسها
  Assert 'canonical json: plain text fast path is byte-identical' ((ConvertTo-AmeenCanonicalJson "عربي — 7f5b0921-61f3 2026-10-22T07:00:00.000Z") -eq '"عربي — 7f5b0921-61f3 2026-10-22T07:00:00.000Z"')
  Assert 'canonical json: escapes still applied when needed' ((ConvertTo-AmeenCanonicalJson ("a`"b\c`td" + [char]1)) -eq '"a\"b\\c\u0009d\u0001"')

  Assert 'state save mode: unchanged cycle saves the watermark only' ((Get-AmeenStateSaveMode -Dirty $false -LastFullSaveUtc ([datetime]::UtcNow.AddMinutes(-1))) -eq "watermark")
  Assert 'state save mode: a real change saves the full state' ((Get-AmeenStateSaveMode -Dirty $true -LastFullSaveUtc ([datetime]::UtcNow)) -eq "full")
  Assert 'state save mode: periodic full save after the interval' ((Get-AmeenStateSaveMode -Dirty $false -LastFullSaveUtc ([datetime]::UtcNow.AddMinutes(-11))) -eq "full")

  # حالة واقعية الحجم (2000 فاتورة، مثل خط الأساس الفعلي على OZK2026)
  $pbox = Join-Path $tempDir "outbox-perf"
  Initialize-AmeenInvoiceOutbox -Dir $pbox
  $ps = New-AmeenInvoiceState; $ps.watermark = "2026-10-22T07:00:00.000"
  for ($i = 0; $i -lt 2000; $i++) { $g = ("{0:x8}-0000-4000-8000-{1:x12}" -f $i, ($i * 7919)); $ps.bills[$g] = @{ v = (Get-AmeenSha256Hex $g); seen = "2026-10-22T04:00:00.000Z"; seq = [long]($ps.last_seq + $i); fp = ("{0}:{1}:3" -f ($i * 31), ($i * 17)) } }
  $ps.last_seq = [long]$ps.last_seq + 2000
  $sw = [Diagnostics.Stopwatch]::StartNew(); Save-AmeenInvoiceState -Dir $pbox -State $ps; $fullMs = $sw.Elapsed.TotalMilliseconds
  $statePath = Join-Path $pbox "state.json"
  $stateHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
  $wmTimes = @()
  for ($k = 1; $k -le 20; $k++) {
    $ps.watermark = ([datetime]"2026-10-22T07:00:00").AddSeconds(2 * $k).ToString("yyyy-MM-ddTHH:mm:ss.fff", [Globalization.CultureInfo]::InvariantCulture)
    $sw.Restart(); [void](Save-AmeenInvoiceWatermark -Dir $pbox -State $ps); $wmTimes += $sw.Elapsed.TotalMilliseconds
  }
  $wmAvg = ($wmTimes | Measure-Object -Average).Average
  Write-Host ("  perf: full save {0:n0} ms, watermark save avg {1:n1} ms (2000 bills)" -f $fullMs, $wmAvg)
  Assert 'performance: 20 unchanged cycles never rewrite state.json' ((Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash -eq $stateHash)
  Assert 'performance: watermark save stays well under the 500ms cycle budget' ($wmAvg -lt 100)
  Assert 'performance: watermark save is at least 10x cheaper than a full save' (($wmAvg * 10) -lt [math]::Max($fullMs, 1))

  # إعادة التشغيل: العلامة الأحدث تُعتمد إن كانت لنفس نسخة الحالة، ولا تُفقد التغييرات
  $rs = Read-AmeenInvoiceState -Dir $pbox
  Assert 'restart: newer watermark of the same state version is used' ($rs.watermark -eq "2026-10-22T07:00:40.000")
  Assert 'restart: bills and seq come back intact' ($rs.bills.Count -eq 2000 -and [long]$rs.last_seq -eq [long]$ps.last_seq)
  $wmOnly = Join-Path $tempDir "outbox-wm-verbatim"; Initialize-AmeenInvoiceOutbox -Dir $wmOnly
  $vs = New-AmeenInvoiceState; $vs.watermark = "2026-10-22T07:00:00.000"; Save-AmeenInvoiceState -Dir $wmOnly -State $vs
  Remove-Item -LiteralPath (Join-Path $wmOnly "watermark.json") -Force
  Assert 'restart: watermark kept verbatim in server-local time (no UTC shift on PowerShell 7)' ((Read-AmeenInvoiceState -Dir $wmOnly).watermark -eq "2026-10-22T07:00:00.000")
  # حدث بعد آخر حفظ كامل لم تُحفظ حالته (انقطاع بين الصندوق والحالة) ⇒ العلامة لا تُعتمد ويُعاد الرصد
  $ps2 = Read-AmeenInvoiceState -Dir $pbox
  $ps2.last_seq = [long]$ps2.last_seq + 1; $ps2.watermark = "2026-10-22T07:05:00.000"
  [void](Save-AmeenInvoiceWatermark -Dir $pbox -State $ps2)
  $rs2 = Read-AmeenInvoiceState -Dir $pbox
  Assert 'restart: watermark from an unsaved state version is ignored (safe rescan)' ($rs2.watermark -eq "2026-10-22T07:00:00.000")
  # علامة أقدم من الحالة لا تُرجع الحالة إلى الوراء
  Save-AmeenInvoiceState -Dir $pbox -State $rs
  $old = @{ schema = "ameen-invoice-agent-watermark/v1"; watermark = "2026-10-22T06:00:00.000"; state_seq = [long]$rs.last_seq }
  Write-AmeenAtomicFile -Path (Join-Path $pbox "watermark.json") -Content (ConvertTo-AmeenCanonicalJson $old)
  Assert 'restart: an older watermark never moves the state back' ((Read-AmeenInvoiceState -Dir $pbox).watermark -eq "2026-10-22T07:00:40.000")
  # ملف علامة تالف أو مقطوع ⇒ يُتجاهل بلا رمي، وتبقى علامة الحالة
  [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), '{"schema":"ameen-invoice-agent-water')
  $rs3 = $null
  Assert 'corrupt watermark.json: read does not throw' (-not (Throws { $script:rs3 = Read-AmeenInvoiceState -Dir $pbox }))
  Assert 'corrupt watermark.json: state watermark kept' ($script:rs3.watermark -eq "2026-10-22T07:00:40.000" -and $script:rs3.bills.Count -eq 2000)
  # Codex P1 (42af3a30): JSON صالح لكن state_seq تالف/مفقود/خارج Int64 ⇒ تُتجاهل العلامة ولا يفشل الإقلاع
  $goodSeq = [long]$rs.last_seq
  $wmHead = '{"schema":"ameen-invoice-agent-watermark/v1",'
  $badSeqCases = [ordered]@{
    'non-numeric'      = $wmHead + '"state_seq":"abc","watermark":"2026-10-22T07:09:00.000"}'
    'missing'          = $wmHead + '"watermark":"2026-10-22T07:09:00.000"}'
    'beyond Int64'     = $wmHead + '"state_seq":99999999999999999999,"watermark":"2026-10-22T07:09:00.000"}'
    'negative'         = $wmHead + '"state_seq":-' + $goodSeq + ',"watermark":"2026-10-22T07:09:00.000"}'
    'fractional'       = $wmHead + '"state_seq":' + $goodSeq + '.5,"watermark":"2026-10-22T07:09:00.000"}'
    'null'             = $wmHead + '"state_seq":null,"watermark":"2026-10-22T07:09:00.000"}'
    'object'           = $wmHead + '"state_seq":{"n":' + $goodSeq + '},"watermark":"2026-10-22T07:09:00.000"}'
  }
  foreach ($case in $badSeqCases.Keys) {
    [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), $badSeqCases[$case])
    $script:rsb = $null
    $threw = Throws { $script:rsb = Read-AmeenInvoiceState -Dir $pbox }
    Assert ("watermark state_seq ${case}: startup does not fail, watermark ignored, state intact") ((-not $threw) -and $script:rsb.watermark -eq "2026-10-22T07:00:40.000" -and $script:rsb.bills.Count -eq 2000 -and [long]$script:rsb.last_seq -eq $goodSeq)
  }
  # القيمة الصحيحة تُعتمد، وإعادة التشغيل بعد تجاهل علامة تالفة تعود طبيعية بلا فقد ولا تكرار
  [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), $wmHead + '"state_seq":' + $goodSeq + ',"watermark":"2026-10-22T07:09:00.000"}')
  Assert 'watermark state_seq valid: newer watermark used' ((Read-AmeenInvoiceState -Dir $pbox).watermark -eq "2026-10-22T07:09:00.000")
  [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), $badSeqCases['non-numeric'])
  $rr = Read-AmeenInvoiceState -Dir $pbox
  $rr.watermark = "2026-10-22T07:10:00.000"
  [void](Save-AmeenInvoiceWatermark -Dir $pbox -State $rr)
  $rr2 = Read-AmeenInvoiceState -Dir $pbox
  Assert 'watermark state_seq restart: bad file replaced by the next save, no seq change' ($rr2.watermark -eq "2026-10-22T07:10:00.000" -and [long]$rr2.last_seq -eq $goodSeq -and $rr2.bills.Count -eq 2000)
  Assert 'watermark state_seq restart: no event emitted for known versions after recovery' ((Resolve-AmeenInvoiceChanges -State $rr2 -Observations @()).Count -eq 0 -and [long]$rr2.last_seq -eq $goodSeq)
  # Codex P1 (37be4ca8): تاريخ مستحيل بالشكل الصحيح وتسلسل مطابق ⇒ يُتجاهل الملف، ويبقى ما يقرؤه الوكيل قابلاً لـ ParseExact
  [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), '{"schema":"ameen-invoice-agent-watermark/v1","state_seq":0,"watermark":"x"}')
  $baseWm = (Read-AmeenInvoiceState -Dir $pbox).watermark
  foreach ($bad in @("2026-99-22T07:00:00.000", "2026-02-30T07:00:00.000", "2026-10-22T25:00:00.000", "2026-10-22T07:61:00.000", "0000-10-22T07:00:00.000")) {
    [IO.File]::WriteAllText((Join-Path $pbox "watermark.json"), $wmHead + '"state_seq":' + $goodSeq + ',"watermark":"' + $bad + '"}')
    $script:rbd = $null
    $threw = Throws { $script:rbd = Read-AmeenInvoiceState -Dir $pbox }
    $parses = $false
    if (-not $threw -and $script:rbd.watermark) { $parses = -not (Throws { [void][datetime]::ParseExact([string]$script:rbd.watermark, "yyyy-MM-ddTHH:mm:ss.fff", [Globalization.CultureInfo]::InvariantCulture) }) }
    Assert ("watermark invalid date ${bad}: ignored, state watermark kept, agent ParseExact safe") ((-not $threw) -and $script:rbd.watermark -eq $baseWm -and $parses -and $script:rbd.bills.Count -eq 2000)
  }
  # تاريخ مستحيل داخل state.json نفسه ⇒ لا رمي، والعلامة فارغة فيبدأ الوكيل من وقت الخادم (والمطابقة تلتقط ما فات)
  $sbox = Join-Path $tempDir "outbox-bad-state-date"; Initialize-AmeenInvoiceOutbox -Dir $sbox
  [IO.File]::WriteAllText((Join-Path $sbox "state.json"), '{"bills":{},"last_seq":1792641146179,"schema":"ameen-invoice-agent-state/v1","send":{"failures":0,"next_at":null},"watermark":"2026-13-40T07:00:00.000"}')
  $script:rsd = $null
  Assert 'state.json invalid watermark date: read does not throw and watermark is cleared' ((-not (Throws { $script:rsd = Read-AmeenInvoiceState -Dir $sbox })) -and $null -eq $script:rsd.watermark -and [long]$script:rsd.last_seq -eq 1792641146179)
  Assert 'watermark parser: valid date returned verbatim, impossible dates rejected' ((Get-AmeenRawWatermark '{"watermark":"2026-10-22T07:00:00.000"}') -eq "2026-10-22T07:00:00.000" -and $null -eq (Get-AmeenRawWatermark '{"watermark":"2026-99-22T07:00:00.000"}') -and $null -eq (Get-AmeenRawWatermark '{"watermark":"2026-02-29T07:00:00.000"}') -and (Get-AmeenRawWatermark '{"watermark":"2028-02-29T07:00:00.000"}') -eq "2028-02-29T07:00:00.000")
  Assert 'watermark state_seq parser: TryParse rejects text, overflow and zero' ($null -eq (Get-AmeenRawStateSeq '{"state_seq":"1"}') -and $null -eq (Get-AmeenRawStateSeq '{"state_seq":99999999999999999999}') -and $null -eq (Get-AmeenRawStateSeq '{"state_seq":0}') -and (Get-AmeenRawStateSeq ('{"state_seq":' + $goodSeq + '}')) -eq $goodSeq)
  # حفظ غير مكتمل (انقطاع قبل الاستبدال): يبقى الأصل كاملاً، وتُزال البقايا عند البدء
  [IO.File]::WriteAllText((Join-Path $pbox ("state.json.tmp-" + [guid]::NewGuid().ToString("N"))), '{"schema":"ameen-invoice-agent-state/v1","bil')
  [IO.File]::WriteAllText((Join-Path $pbox ("watermark.json.tmp-" + [guid]::NewGuid().ToString("N"))), '{"sch')
  Initialize-AmeenInvoiceOutbox -Dir $pbox
  Assert 'interrupted save: temp leftovers removed on start' (@(Get-ChildItem -LiteralPath $pbox -Filter "*.tmp-*").Count -eq 0)
  $rs4 = Read-AmeenInvoiceState -Dir $pbox
  Assert 'interrupted save: original state.json intact and readable' ($rs4.bills.Count -eq 2000 -and @(Get-ChildItem -LiteralPath $pbox -Filter "state.corrupt-*.json").Count -eq 0)
  # الكتابة الذرّية: لا ملف مؤقت باقٍ بعد حفظ ناجح
  Assert 'atomic write: no temp file left after a successful save' (@(Get-ChildItem -LiteralPath $pbox -Filter "*.tmp-*").Count -eq 0)
  # ملف مقفول من برنامج آخر (مكافح فيروسات/فهرسة — ثبت على OZK2026): العلامة لا توقف الوكيل، والحالة
  # الكاملة ترمي بعد المحاولات بلا بقايا ويبقى الأصل كاملاً. القفل الحصري يُفرض على Windows وحده.
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $wmFile = Join-Path $pbox "watermark.json"
    $held = [IO.File]::Open($wmFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      $okSave = $true
      Assert 'locked watermark.json: save does not throw' (-not (Throws { $script:okSave = Save-AmeenInvoiceWatermark -Dir $pbox -State $rs4 }))
      Assert 'locked watermark.json: save reports failure and leaves no temp file' (($script:okSave -eq $false) -and @(Get-ChildItem -LiteralPath $pbox -Filter "watermark.json.tmp-*").Count -eq 0)
    } finally { $held.Dispose() }
    Assert 'locked watermark.json: next save succeeds once released' (Save-AmeenInvoiceWatermark -Dir $pbox -State $rs4)
    $stFile = Join-Path $pbox "state.json"
    $stBefore = (Get-FileHash -LiteralPath $stFile -Algorithm SHA256).Hash
    $held = [IO.File]::Open($stFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { $threw = Throws { Save-AmeenInvoiceState -Dir $pbox -State $rs4 } } finally { $held.Dispose() }
    Assert 'locked state.json: full save fails loudly, original intact, no temp file' ($threw -and (Get-FileHash -LiteralPath $stFile -Algorithm SHA256).Hash -eq $stBefore -and @(Get-ChildItem -LiteralPath $pbox -Filter "state.json.tmp-*").Count -eq 0)
  }

  # الوكيل: الحالة الكاملة تُحفظ عند التغيّر فقط، والعلامة وحدها في الدورة الهادئة
  $agentSaveText = Get-Content -Raw -LiteralPath $agentPath -Encoding UTF8
  Assert 'agent: detection loop chooses the save mode (no unconditional full save)' ($agentSaveText -match '\(Get-AmeenStateSaveMode -Dirty \$stateDirty -LastFullSaveUtc \$lastFullSave\) -eq "full"' -and $agentSaveText -match 'if \(Save-AmeenInvoiceWatermark -Dir \$OutboxDir -State \$state\)')
  Assert 'agent: send path saves state only when something was sent or failed' ($agentSaveText -match 'if \(\$r\.sent -gt 0 -or \$r\.error -or \$r\.deadlettered -gt 0\) \{ Save-AmeenInvoiceState')
  Assert 'agent: new events, fingerprint changes and removals mark the state dirty' (([regex]::Matches($agentSaveText, '\$stateDirty = \$true')).Count -ge 3)

  # ── ٥ك) تعافي اتصال SQL (تدقيق انقطاع الكهرباء 2026-10-26): بعد الإسبات انكسر الاتصال فخرج الوكيل برمز 1
  # بلا سطر. محاكاة آمنة كلها: لا اتصال بالأمين، ولا قاعدة بيانات إطلاقاً.
  $delays = @(1..10 | ForEach-Object { Get-AmeenReconnectDelaySeconds -Attempt $_ })
  Assert 'reconnect backoff: 2,4,8 doubling up to the 300s cap' (($delays -join ",") -eq "2,4,8,16,32,64,128,256,300,300")
  Assert 'reconnect backoff: no wait for attempt 0, cap holds for huge attempts' ((Get-AmeenReconnectDelaySeconds -Attempt 0) -eq 0 -and (Get-AmeenReconnectDelaySeconds -Attempt 500) -eq 300)

  $refs = @(); if ($PSVersionTable.PSEdition -ne "Core") { $refs = @("System.Data") }
  if (-not ("OzkFakeSqlError" -as [type])) {
    $fakeSrc = "public class OzkFakeSqlError : System.Data.Common.DbException { public OzkFakeSqlError(string m, byte c) : base(m) { Class = c; } public byte Class { get; private set; } }"
    if ($refs.Count -gt 0) { Add-Type -TypeDefinition $fakeSrc -ReferencedAssemblies $refs } else { Add-Type -TypeDefinition $fakeSrc }
  }
  $wrap = { param($inner) New-Object System.Management.Automation.MethodInvocationException("Exception calling ""Fill"" with ""1"" argument(s)", $inner) }
  $lockTimeout = New-Object OzkFakeSqlError("Lock request time out period exceeded.", [byte]16)
  $transport = New-Object OzkFakeSqlError("A transport-level error has occurred when receiving results from the server.", [byte]20)
  $closedOp = New-Object System.InvalidOperationException("ExecuteReader requires an open and available Connection. The connection's current state is closed.")
  Assert 'failure kind: lock timeout on an open connection is transient (no reconnect)' ((Get-AmeenSqlFailureKind -Exception (& $wrap $lockTimeout) -ConnectionState "Open") -eq "transient")
  Assert 'failure kind: transport-level SQL error (class 20) is a connection loss' ((Get-AmeenSqlFailureKind -Exception (& $wrap $transport) -ConnectionState "Open") -eq "connection")
  Assert 'failure kind: closed connection after hibernation is a connection loss' ((Get-AmeenSqlFailureKind -Exception (& $wrap $closedOp) -ConnectionState "Closed") -eq "connection")
  Assert 'failure kind: broken connection state alone means reconnect' ((Get-AmeenSqlFailureKind -Exception (New-Object System.Exception("x")) -ConnectionState "Broken") -eq "connection")
  Assert 'failure kind: socket/IO error is a connection loss' ((Get-AmeenSqlFailureKind -Exception (& $wrap (New-Object System.IO.IOException("Unable to read data from the transport connection"))) -ConnectionState "Open") -eq "connection")
  Assert 'failure kind: non-SQL bug on an open connection stays fatal' ((Get-AmeenSqlFailureKind -Exception (New-Object System.FormatException("bad")) -ConnectionState "Open") -eq "fatal")
  # خطأ SqlClient حقيقي: اتصال أول فاسد إلى منفذ محلي مغلق (لا خادم ولا أمين)
  Add-Type -AssemblyName "System.Data"
  $deadConn = New-Object System.Data.SqlClient.SqlConnection("Server=127.0.0.1,1;Database=AmnDb002;User ID=ozk_test;Password=Sim-Secret-91;Connect Timeout=2")
  $realErr = $null
  try { $deadConn.Open() } catch { $realErr = $_.Exception }
  Assert 'first connection to a dead server: real SqlException classified as connection loss' ($null -ne $realErr -and (Get-AmeenSqlFailureKind -Exception $realErr -ConnectionState ([string]$deadConn.State)) -eq "connection")

  $pwErr = New-Object System.InvalidOperationException("Login failed; Data Source=OZK-TOBACCO;Initial Catalog=AmnDb002;User ID=tobacco_sync_reader;Password=Sim-Secret-91;pwd = other;")
  $safe = Format-AmeenSafeError (& $wrap $pwErr)
  Assert 'safe error: passwords masked in logged text' ($safe -notmatch 'Sim-Secret-91' -and $safe -notmatch 'other' -and $safe -match 'Password=\*\*\*' -and $safe -match 'pwd=\*\*\*')
  Assert 'safe error: SQL number and message kept for diagnosis' ((Format-AmeenSafeError $realErr) -match '^SqlException \d+: ')

  # إعادة الاتصال: نجاح بعد فشلين، بتراجع 2 ← 4 ← 8، وسجلات RECONNECTING/RECOVERED
  $sim = @{ opens = 0; failFirst = 2; sleeps = New-Object System.Collections.Generic.List[int]; log = New-Object System.Collections.Generic.List[string] }
  $simOpen = { $sim.opens++; if ($sim.opens -le $sim.failFirst) { throw (& $wrap (New-Object System.IO.IOException("network down; Password=Sim-Secret-91"))) } }
  $simProbe = { [pscustomobject]@{ d = "AmnDb002"; t = [datetime]"2026-10-26T06:41:00" } }
  $simSleep = { param($s) $sim.sleeps.Add([int]$s) }
  $simLog = { param($m) $sim.log.Add([string]$m) }
  $r = Invoke-AmeenSqlReconnect -Open $simOpen -Probe $simProbe -Log $simLog -Sleep $simSleep -MaxAttempts 5
  Assert 'reconnect: recovers on the 3rd attempt after 2 failures' ($r.ok -and $r.attempts -eq 3 -and $r.recovered -and $r.probe.d -eq "AmnDb002")
  Assert 'reconnect: waits 2,4,8 seconds (exponential backoff)' (($sim.sleeps -join ",") -eq "2,4,8")
  Assert 'reconnect: logs RECONNECTING and RECOVERED' ((@($sim.log | Where-Object { $_ -like "RECONNECTING*" }).Count -eq 5) -and (@($sim.log | Where-Object { $_ -like "RECOVERED*" }).Count -eq 1))
  Assert 'reconnect: no password in any log line' (@($sim.log | Where-Object { $_ -match 'Sim-Secret-91' }).Count -eq 0)

  # حد المحاولات: لا رمي، نتيجة فاشلة وسطر FATAL، وعدد المحاولات لا يتجاوز الحد
  $sim = @{ opens = 0; failFirst = 99; sleeps = New-Object System.Collections.Generic.List[int]; log = New-Object System.Collections.Generic.List[string] }
  $threw = Throws { $script:rx = Invoke-AmeenSqlReconnect -Open $simOpen -Probe $simProbe -Log $simLog -Sleep $simSleep -MaxAttempts 4 }
  Assert 'reconnect limit: does not throw, reports failure after max attempts' ((-not $threw) -and -not $script:rx.ok -and $sim.opens -eq 4 -and ($sim.sleeps -join ",") -eq "2,4,8,16")
  Assert 'reconnect limit: FATAL logged once' (@($sim.log | Where-Object { $_ -like "FATAL*" }).Count -eq 1)
  Assert 'reconnect limit: cap applies to every wait' (-not (@(1..60 | ForEach-Object { Get-AmeenReconnectDelaySeconds -Attempt $_ }) | Where-Object { $_ -gt 300 }))

  # استعلام الاختبار يفشل بعد فتح ناجح (اتصال فاسد) = محاولة فاشلة لا نجاح كاذب
  $sim = @{ opens = 0; probes = 0; failFirst = 0; sleeps = New-Object System.Collections.Generic.List[int]; log = New-Object System.Collections.Generic.List[string] }
  $badProbe = { $sim.probes++; if ($sim.probes -eq 1) { throw (& $wrap $transport) }; [pscustomobject]@{ d = "AmnDb002"; t = Get-Date } }
  $r = Invoke-AmeenSqlReconnect -Open $simOpen -Probe $badProbe -Log $simLog -Sleep $simSleep -MaxAttempts 5
  Assert 'reconnect: a failing probe after Open counts as a failed attempt' ($r.ok -and $r.attempts -eq 2 -and $sim.probes -eq 2)

  # الاتصال الأول عند البدء: المحاولة الأولى فوراً بلا انتظار؛ فشلها DISCONNECTED ثم تراجع 2 ← 4
  $sim = @{ opens = 0; failFirst = 2; sleeps = New-Object System.Collections.Generic.List[int]; log = New-Object System.Collections.Generic.List[string] }
  $r = Invoke-AmeenSqlReconnect -Open $simOpen -Probe $simProbe -Log $simLog -Sleep $simSleep -MaxAttempts 5 -FirstAttemptNow
  Assert 'first connection failure: no wait before the first try, then 2,4' ($r.ok -and $r.attempts -eq 3 -and ($sim.sleeps -join ",") -eq "2,4")
  Assert 'first connection failure: DISCONNECTED then RECOVERED logged' (($sim.log[0] -like "DISCONNECTED*") -and ($sim.log[$sim.log.Count - 1] -like "RECOVERED*"))
  $sim = @{ opens = 0; failFirst = 0; sleeps = New-Object System.Collections.Generic.List[int]; log = New-Object System.Collections.Generic.List[string] }
  $r = Invoke-AmeenSqlReconnect -Open $simOpen -Probe $simProbe -Log $simLog -Sleep $simSleep -FirstAttemptNow
  Assert 'first connection ok: no wait and no recovery noise in the log' ($r.ok -and -not $r.recovered -and $sim.sleeps.Count -eq 0 -and $sim.log.Count -eq 0)

  # دورة رصد محاكاة بنفس ترتيب الوكيل (كل القراءات أولاً، ثم Resolve، ثم الصندوق، ثم العلامة، ثم الحفظ):
  # انقطاع ثم عودة ثم إعادة تشغيل ⇒ لا حدث ضائع ولا مكرر، والعلامة لا تتقدّم قبل نجاح المعالجة.
  $cbox = Join-Path $tempDir "outbox-reconnect"
  Initialize-AmeenInvoiceOutbox -Dir $cbox
  $cs = New-AmeenInvoiceState; $cs.watermark = "2026-10-25T23:22:30.000"; Save-AmeenInvoiceState -Dir $cbox -State $cs
  $seqStart = [long]$cs.last_seq
  $G2 = "c0000000-0000-4000-8000-000000000002"
  $sA = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header) -Lines @($L1, $L2)
  $sB = ConvertTo-AmeenInvoiceSnapshot -Header (New-Header -Guid $G2 -Total 62) -Lines @($L2)
  $world = @{ conn = "Open"; failOn = ""; failWrite = $false; now = [datetime]"2026-10-26T06:40:05" }
  $simRead = {
    param($What)
    if ($world.failOn -eq $What) { $world.conn = "Broken"; throw (& $wrap $transport) }
    if ($world.conn -ne "Open") { throw (& $wrap $closedOp) }
    if ($What -eq "now") { return $world.now }
    return @(
      @{ guid = $G1; snapshot = $sA; ops = @(@{ op = 1; at_utc = "2026-10-26T03:41:00.000Z" }); detected_at_utc = "2026-10-26T03:41:05.000Z"; source = "incremental" },
      @{ guid = $G2; snapshot = $sB; ops = @(@{ op = 1; at_utc = "2026-10-26T03:41:10.000Z" }); detected_at_utc = "2026-10-26T03:41:05.000Z"; source = "incremental" }
    )
  }
  $simCycle = {
    param($State)
    $readsDone = $false
    try {
      $now = & $simRead "now"
      $observations = & $simRead "observations"
      $readsDone = $true
      $events = Resolve-AmeenInvoiceChanges -State $State -Observations $observations
      if ($world.failWrite) { throw (New-Object System.IO.IOException("The process cannot access the file because it is being used by another process")) }
      if ($events.Count -gt 0) { Add-AmeenOutboxEvents -Dir $cbox -Events $events }
      $State.watermark = Format-AmeenSqlDate $now
      Save-AmeenInvoiceState -Dir $cbox -State $State
      return "ok"
    } catch {
      if ($readsDone) { throw }
      $k = Get-AmeenSqlFailureKind -Exception $_.Exception -ConnectionState $world.conn
      if ($k -eq "fatal") { throw }
      return $k
    }
  }
  $pendingCount = { @(Get-ChildItem -LiteralPath (Join-Path $cbox "pending") -Filter "*.json" -ErrorAction SilentlyContinue).Count }
  # (١) الاستعلام الأول في الدورة (GETDATE) يرمي بعد الإسبات
  $world.failOn = "now"
  $res1 = & $simCycle $cs
  Assert 'disconnect at first query: classified as connection loss' ($res1 -eq "connection")
  Assert 'disconnect at first query: watermark not advanced (memory and disk)' ($cs.watermark -eq "2026-10-25T23:22:30.000" -and (Read-AmeenInvoiceState -Dir $cbox).watermark -eq "2026-10-25T23:22:30.000")
  Assert 'disconnect at first query: no event and no seq allocated' ((& $pendingCount) -eq 0 -and [long]$cs.last_seq -eq $seqStart)
  # (٢) الاتصال ما زال مكسوراً، والانقطاع في منتصف القراءات
  $world.failOn = "observations"; $world.conn = "Open"
  $res2 = & $simCycle $cs
  Assert 'disconnect mid-cycle: nothing emitted, watermark and checkpoint unchanged' ($res2 -eq "connection" -and (& $pendingCount) -eq 0 -and [long]$cs.last_seq -eq $seqStart -and (Read-AmeenInvoiceState -Dir $cbox).watermark -eq "2026-10-25T23:22:30.000")
  # (٢ب) Codex P1 (49bee87): فشل كتابة الصندوق (IOException) بعد Resolve والاتصال سليم ليس انقطاع SQL:
  # يُرمى (الوكيل يسجّل FATAL ويخرج) فلا تُحفظ حالة تحمل أحداثاً لم تُكتب، وإعادة التشغيل تلتقطها من القرص.
  $world.failOn = ""; $world.conn = "Open"; $world.failWrite = $true
  $memState = Read-AmeenInvoiceState -Dir $cbox
  $writeThrew = Throws { & $simCycle $memState }
  Assert 'outbox write failure after reads: not treated as a SQL disconnect (agent stops instead)' ($writeThrew)
  Assert 'outbox write failure after reads: nothing saved, disk state and watermark unchanged' ((& $pendingCount) -eq 0 -and [long](Read-AmeenInvoiceState -Dir $cbox).last_seq -eq $seqStart -and (Read-AmeenInvoiceState -Dir $cbox).watermark -eq "2026-10-25T23:22:30.000")
  $world.failWrite = $false
  $world.conn = "Broken"
  # (٣) العودة: إعادة اتصال ناجحة، والدورة التالية من العلامة نفسها تلتقط الفاتورتين مرة واحدة
  $world.failOn = ""
  $rc = Invoke-AmeenSqlReconnect -Open { $world.conn = "Open" } -Probe $simProbe -Log { param($m) } -Sleep { param($s) } -MaxAttempts 3
  $res3 = & $simCycle $cs
  $after = @(Get-ChildItem -LiteralPath (Join-Path $cbox "pending") -Filter "*.json" | Sort-Object Name | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName -Encoding UTF8 | ConvertFrom-Json })
  Assert 'after reconnect: both invoices from the outage emitted exactly once' ($rc.ok -and $res3 -eq "ok" -and $after.Count -eq 2 -and @($after | Select-Object -ExpandProperty bill_guid -Unique).Count -eq 2)
  Assert 'after reconnect: seq strictly increasing from the last checkpoint' ([long]$after[0].source_seq -eq ($seqStart + 1) -and [long]$after[1].source_seq -eq ($seqStart + 2))
  Assert 'after reconnect: watermark advances only after the successful cycle' ((Read-AmeenInvoiceState -Dir $cbox).watermark -eq "2026-10-26T06:40:05.000")
  # (٤) الدورة التالية ترى الفاتورتين نفسيهما ⇒ لا تكرار
  $world.now = [datetime]"2026-10-26T06:40:07"
  [void](& $simCycle $cs)
  Assert 'after reconnect: re-reading the same invoices creates no duplicate' ((& $pendingCount) -eq 2 -and [long]$cs.last_seq -eq ($seqStart + 2))
  # (٥) إعادة تشغيل الوكيل: الحالة من القرص، ثم الدورة نفسها ⇒ لا حدث جديد ولا تسلسل جديد
  $restarted = Read-AmeenInvoiceState -Dir $cbox
  $world.now = [datetime]"2026-10-26T06:45:00"
  [void](& $simCycle $restarted)
  Assert 'agent restart after recovery: no lost and no duplicate events' ((& $pendingCount) -eq 2 -and [long]$restarted.last_seq -eq ($seqStart + 2) -and $restarted.bills.Count -eq 2)

  # الوكيل الفعلي باتصال أول فاسد (منفذ محلي مغلق؛ لا أمين): يسجّل DISCONNECTED/RECONNECTING/FATAL، يخرج برمز 6،
  # لا يكتب حالة ولا أحداثاً، لا كلمة مرور في السجل، ويحرّر القفل.
  $dbox = Join-Path $tempDir "outbox-dead-sql"
  $denv = Join-Path $tempDir "dead-sql.env"
  [IO.File]::WriteAllText($denv, "AMEEN_SQL_CONNECTION_STRING=Server=127.0.0.1,1;Database=AmnDb002;User ID=ozk_test;Password=Sim-Secret-91;Connect Timeout=2`n")
  $dlog = Join-Path $tempDir "agent-dead-sql.log"
  & $shell -NoProfile -File $agentPath -Once -OutboxDir $dbox -LogFile $dlog -EnvFile $denv -MaxReconnectAttempts 2 -ReconnectBaseSeconds 1 -ReconnectMaxSeconds 1 *> $null
  $deadExit = $LASTEXITCODE
  $dtext = ""; if (Test-Path -LiteralPath $dlog) { $dtext = Get-Content -Raw -LiteralPath $dlog -Encoding UTF8 }
  Assert 'agent with a dead first connection: exits with code 6 after the attempt limit' ($deadExit -eq 6)
  Assert 'agent with a dead first connection: logs DISCONNECTED, RECONNECTING and FATAL' ($dtext -match 'DISCONNECTED' -and $dtext -match 'RECONNECTING' -and $dtext -match 'FATAL')
  Assert 'agent with a dead first connection: no password in the log' ($dtext -notmatch 'Sim-Secret-91')
  Assert 'agent with a dead first connection: no state, watermark or pending written' (-not (Test-Path -LiteralPath (Join-Path $dbox "state.json")) -and -not (Test-Path -LiteralPath (Join-Path $dbox "watermark.json")) -and -not (Test-Path -LiteralPath (Join-Path $dbox "pending")))
  $relock = Enter-AmeenOutboxLock -Dir $dbox
  Assert 'agent with a dead first connection: single-instance lock released on exit' ($null -ne $relock)
  Exit-AmeenOutboxLock $relock

  # الوكيل: نص الحلقة يطبّق ما سبق
  $agentRc = Get-Content -Raw -LiteralPath $agentPath -Encoding UTF8
  $loopStart = $agentRc.IndexOf("    do {"); $tryAt = $agentRc.IndexOf("        try {", $loopStart)
  $getdateAt = $agentRc.IndexOf('$nowSrv = [datetime](Invoke-AmeenRead "SELECT GETDATE() t")', $loopStart)
  Assert 'agent: cycle GETDATE runs inside the protected block' ($tryAt -gt $loopStart -and $getdateAt -gt $tryAt)
  Assert 'agent: first connection goes through the reconnect routine' ($agentRc -match 'Restore-AgentSqlConnection -FirstAttemptNow' -and $agentRc -notmatch '(?m)^\s*\$conn\.Open\(\)\s*$\r?\n\s*\$db = ')
  Assert 'agent: database name re-verified after reconnect' ($agentRc -match '\[string\]\$link\.probe\.d -ne \$ExpectedDatabase')
  Assert 'agent: outer catch logs FATAL before exit 1' ($agentRc -match '(?s)\} catch \{\s*#[^\n]*\n\s*Write-AgentLog \("FATAL: ')
  $disc = $agentRc.IndexOf('if ($connectionLost) {'); $discEnd = $agentRc.IndexOf('} else {', $disc)
  $resolveAt = $agentRc.IndexOf('$events = Resolve-AmeenInvoiceChanges', $loopStart)
  Assert 'agent: only failures before Resolve can trigger SQL recovery' ($agentRc.LastIndexOf('$readsDone = $true', $resolveAt) -gt $getdateAt -and $agentRc -match '\} catch \{\s*#[^\n]*\n[^\n]*\n\s*if \(\$readsDone\) \{ throw \}')
  Assert 'agent: reconnect branch saves nothing (no state or watermark write)' ($disc -gt 0 -and $agentRc.Substring($disc, $discEnd - $disc) -notmatch 'Save-AmeenInvoice')

  # ── ٦) الوكيل: يُحلَّل بلا أخطاء، ولا يسجّل مهمة، ولا يرسل افتراضياً ───────────────────────────
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($agentPath, [ref]$tokens, [ref]$errors)
  Assert 'agent parses without errors' ($errors.Count -eq 0)
  $agentText = Get-Content -Raw -LiteralPath $agentPath -Encoding UTF8
  Assert 'agent never registers a scheduled task' ($agentText -notmatch '(?i)Register-ScheduledTask|schtasks')
  Assert 'agent never reads the write connection string' ($agentText -notmatch 'AMEEN_SQL_WRITE_CONNECTION_STRING|WRITE_CONNECTION')
  Assert 'agent sends only with -Send AND the owner flag file' ($agentText -match 'Test-AmeenSendActivated -Dir \$OutboxDir -SendRequested:\$Send')
  # (من Cursor 25965c77، مُحدَّث للدالة Test-AmeenSendActivated) الفحص داخل الحلقة وقبل استدعاء الإرسال
  $loopAt = $agentText.IndexOf("do {")
  $recheckAt = $agentText.IndexOf('$sendNow = Test-AmeenSendActivated', $loopAt)
  $sendCallAt = $agentText.IndexOf("Send-AmeenInvoiceOutbox", $loopAt)
  Assert 'send flag: re-checked inside the loop before each send' ($loopAt -ge 0 -and $recheckAt -gt $loopAt -and $sendCallAt -gt $recheckAt)
  Assert 'agent runs every SQL through the read-only guard' ($agentText -match 'Assert-AmeenReadOnlySql \$Sql' -and $agentText -notmatch 'ExecuteNonQuery|ExecuteReader|ExecuteScalar')
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ("Ameen invoice events: {0} PASS, {1} FAIL" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
exit 0
