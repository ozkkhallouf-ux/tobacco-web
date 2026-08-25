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
function Broker($Url,$Key,$Token,$Body){$json=$Body|ConvertTo-Json -Depth 30;$utf8Body=[System.Text.Encoding]::UTF8.GetBytes($json);Invoke-RestMethod -Method Post -Uri "$Url/functions/v1/ameen-read-broker" -Headers @{apikey=$Key;Authorization="Bearer $Token"} -ContentType "application/json; charset=utf-8" -Body $utf8Body -TimeoutSec $RestTimeoutSec}
function Write-Heartbeat{
 try{
  $dir=Split-Path -Parent $heartbeatPath
  if(-not (Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Force -Path $dir|Out-Null}
  @{timestampUtc=(Get-Date).ToUniversalTime().ToString("o");pid=$PID;status="ok"}|ConvertTo-Json|Set-Content -LiteralPath $heartbeatPath -Encoding utf8
 }catch{Write-Warning ("Ameen read worker: heartbeat write failed - "+$_.Exception.Message)}
}
$url=(Require-Env "TOBACCO_SUPABASE_URL").TrimEnd('/');$key=Require-Env "TOBACCO_SUPABASE_PUBLIC_KEY";$email=Require-Env "TOBACCO_SYNC_EMAIL";$password=Require-Env "TOBACCO_SYNC_PASSWORD"
$session=Session $url $key $email $password;$token=$session.access_token
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
  if($_.Exception.Message -match '401|JWT|token'){$session=Session $url $key $email $password;$token=$session.access_token}else{Write-Warning ("Ameen read worker: "+$_.Exception.Message)}
 }
 Start-Sleep -Seconds ([math]::Max(2,$PollSeconds))
}
