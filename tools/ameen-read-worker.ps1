param([int]$PollSeconds=3)
$ErrorActionPreference="Stop"
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
# 30 ثانية: سقف زمني معقول لأبطأ حالة (cold start لدالة Supabase Edge) — قصير كفاية
# ليمنع تعليق حلقة العامل للأبد عند تعثر شبكي، وطويل كفاية لتفادي فشل زائف بسبب بطء عابر.
$RestTimeoutSec=30
# heartbeat: ملف حالة محلي غير حسّاس (لا أسرار) تحت tools\logs (مستبعد من git) يثبت أن
# دورة poll/idle اكتملت فعلياً — يميّز "Running وسليم" عن "Running ومتجمّد" لصالح ensure-ameen-sync.ps1.
$heartbeatPath=Join-Path $PSScriptRoot "logs\ameen-read-worker.heartbeat.json"
function Require-Env($Name){$v=[Environment]::GetEnvironmentVariable($Name,"User");if(-not $v){$v=[Environment]::GetEnvironmentVariable($Name,"Process")};if(-not $v){throw "Missing environment variable: $Name"};$v}
function Session($Url,$Key,$Email,$Password){Invoke-RestMethod -Method Post -Uri "$Url/auth/v1/token?grant_type=password" -Headers @{apikey=$Key} -ContentType "application/json" -Body (@{email=$Email;password=$Password}|ConvertTo-Json) -TimeoutSec $RestTimeoutSec}
# محاولات متكررة لتسجيل الدخول بدل خروج فوري: 5s -> 10s -> 20s -> 30s ثم تستمر كل 30s إلى ما لا نهاية.
# لا تطبع أي secret/token — فقط نص رسالة الخطأ من Invoke-RestMethod (لا يتضمن كلمة المرور أو المفتاح).
function Get-AuthSession($Url,$Key,$Email,$Password){
 $backoffs=@(5,10,20,30)
 $attempt=0
 while($true){
  try{
   $s=Session $Url $Key $Email $Password
   if($attempt -gt 0){Write-Warning "Ameen read worker: auth recovered after retry"}
   return $s
  }catch{
   $delay=if($attempt -lt $backoffs.Count){$backoffs[$attempt]}else{30}
   Write-Warning ("Ameen read worker: auth attempt failed - "+$_.Exception.Message)
   Write-Warning ("Ameen read worker: retry delay ${delay}s")
   # القسم ٤: العملية حيّة وتحاول فعلياً — نثبت ذلك بنبض status=auth_retry كي لا يظنّها
   # ensure-ameen-sync.ps1 متجمّدة فيعيد تشغيلها بلا داعٍ أثناء انقطاع مصادقة طويل (لا يُعيد
   # تشغيل العملية نفسها أي فائدة هنا؛ العطل خارجي: بيانات اعتماد/شبكة/خدمة المصادقة).
   Write-Heartbeat "auth_retry"
   Start-Sleep -Seconds $delay
   $attempt++
  }
 }
}
function Broker($Url,$Key,$Token,$Body){$json=$Body|ConvertTo-Json -Depth 30;$utf8Body=[System.Text.Encoding]::UTF8.GetBytes($json);Invoke-RestMethod -Method Post -Uri "$Url/functions/v1/ameen-read-broker" -Headers @{apikey=$Key;Authorization="Bearer $Token"} -ContentType "application/json; charset=utf-8" -Body $utf8Body -TimeoutSec $RestTimeoutSec}
# $Status: "ok" = دورة poll/idle اكتملت فعلياً (صحة المزامنة نفسها).
# "auth_retry" = العملية حيّة وتحاول تسجيل الدخول لكنه لم ينجح بعد بعد — ليست دورة مزامنة ناجحة،
# لكنها تثبت أن العملية ليست متجمّدة/ميتة. الفصل هنا مقصود: ensure-ameen-sync.ps1 يعتمد على
# طزاجة الطابع الزمني وحدها لقرار "حيّة أم لا"، وعلى قيمة status لقرار "سليمة أم متدهورة" —
# فلا نسجّل أبداً "ok" أثناء إعادة محاولة المصادقة (قد يوهم بنجاح مزامنة لم تحدث).
function Write-Heartbeat([string]$Status="ok"){
 try{
  $dir=Split-Path -Parent $heartbeatPath
  if(-not (Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Force -Path $dir|Out-Null}
  @{timestampUtc=(Get-Date).ToUniversalTime().ToString("o");pid=$PID;status=$Status}|ConvertTo-Json|Set-Content -LiteralPath $heartbeatPath -Encoding utf8
 }catch{Write-Warning ("Ameen read worker: heartbeat write failed - "+$_.Exception.Message)}
}
$url=(Require-Env "TOBACCO_SUPABASE_URL").TrimEnd('/');$key=Require-Env "TOBACCO_SUPABASE_PUBLIC_KEY";$email=Require-Env "TOBACCO_SYNC_EMAIL";$password=Require-Env "TOBACCO_SYNC_PASSWORD"
$session=Get-AuthSession $url $key $email $password;$token=$session.access_token
while($true){
 try{
  $poll=Broker $url $key $token @{action='poll'};$job=$poll.job
  if($job){
   try{$result=& "$PSScriptRoot\ameen-read-gateway.ps1" -Resource ([string]$job.resource)|ConvertFrom-Json;Broker $url $key $token @{action='complete';id=[string]$job.id;ok=$true;response=$result}|Out-Null}
   catch{Broker $url $key $token @{action='complete';id=[string]$job.id;ok=$false;error=$_.Exception.Message}|Out-Null}
  }
  # وصلنا هنا يعني اكتمال دورة poll/idle كاملة بنجاح (سواء وُجدت مهمة أم لا) — هذا تعريف "الدورة السليمة".
  Write-Heartbeat
 }catch{
  # فشل أي جزء من الدورة (بما فيه timeout الشبكة) لا يكتب heartbeat — يبقى heartbeat آخر دورة سليمة كما هو.
  if($_.Exception.Message -match '401|JWT|token'){$session=Get-AuthSession $url $key $email $password;$token=$session.access_token}else{Write-Warning ("Ameen read worker: "+$_.Exception.Message)}
 }
 Start-Sleep -Seconds ([math]::Max(2,$PollSeconds))
}
