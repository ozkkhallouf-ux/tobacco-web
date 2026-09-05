# سحب يومي لآخر نسخة من GitHub — يعمل فقط عندما يكون المستودع نظيفاً ولا توجد مهمة ذكاء اصطناعي نشطة.
# متوافق مع Windows PowerShell 5.1 (تشغّله مهمة «TOBACCO Daily Git Pull» عبر register-daily-git-pull-task.ps1).
$ErrorActionPreference = "Continue"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

$logDirectory = Join-Path $projectRoot "tools\logs"
if (-not (Test-Path -LiteralPath $logDirectory)) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}
$logPath = Join-Path $logDirectory "daily-git-pull.log"
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# ── تصلّب التشغيل غير التفاعلي ──────────────────────────────────────────────
# هذه السطور كانت تعيش في نسخة مكرّرة من هذا المنطق داخل
# C:\ProgramData\OZK-TOBACCO\TaskWrappers\tobacco-daily-git-pull-launcher.ps1
# — ملف غير متعقَّب خارج المستودع، وهو ما كانت المهمة المجدولة تشغّله فعلاً.
# فبقي هذا الملف يُعدَّل بلا أثر على الإنتاج. نُقلت الحماية إلى هنا ليصير
# المستودع المصدر الوحيد، ويصير ما في ProgramData مجرد shim يستدعي هذا الملف.
#
# مهمة Task Scheduler قد تعمل بـPATH لا يحوي git، فالمسار الصريح أولاً.
$git = "C:\Program Files\Git\cmd\git.exe"
if (-not (Test-Path -LiteralPath $git)) { $git = "git" }

# لا مطالبة اعتماد تفاعلية أبداً: تعليق صامت في مهمة مجدولة أسوأ من فشل صريح.
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "Never"

# credential.helper= يعطّل أي معين اعتماد (المستودع عام فالجلب لا يحتاجه)،
# وsafe.directory يمنع رفض git للمجلد بحجة «ملكية مريبة» عند اختلاف المستخدم.
$gitArgs = @("-C", $projectRoot, "-c", "credential.helper=", "-c", "safe.directory=$projectRoot")

function Send-FailureAlert([string]$Reason) {
  $notifyPath = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
  if (Test-Path -LiteralPath $notifyPath) {
    & $notifyPath -Message ("فشل السحب اليومي من GitHub على جهاز Windows: " + $Reason) -EventType "windows" -DedupeKey "daily-git-pull-fail" -DedupeMinutes 360
  }
}

$dirty = & $git @gitArgs status --porcelain 2>$null
if ($LASTEXITCODE -ne 0) {
  Add-Content -LiteralPath $logPath -Value "$stamp FAIL: git status failed"
  Send-FailureAlert "git status failed"
  exit 1
}
if ($dirty) {
  Add-Content -LiteralPath $logPath -Value "$stamp SKIP: uncommitted changes present"
  exit 0
}

# الجلب أولاً وبلا شرط. `git fetch` لا يمسّ شجرة العمل ولا أي فرع محلي، فهو آمن
# سواء وُجد قفل أم لا: القفل لا يحرس الجلب، بل يحرس **تحريك الفرع** بالـrebase.
#
# العطل الذي يعالجه هذا الترتيب (مقيس على جهاز Windows في 2026-09-05): كان القفل
# يُقرأ من نسخة العمل المحلية قبل أي جلب، فقيمته هي حتماً قيمة آخر سحب ناجح. فمتى
# دخل قفل `active` ثم أُفلت على main، استحال على الجهاز رؤية الإفلات — الشيء الوحيد
# القادر على إحضاره هو السحب الذي تمنعه القيمة القديمة نفسها. قفلٌ حُجز في
# 2026-08-31 أوقف السحب اليومي ثلاثة أيام متتالية (09-02 و09-03 و09-04) وسجّل
# «SKIP: active AI task lock» في كل مرة، ولم يُفكّ الشلل إلا بسحب يدوي.
$fetchLines = & $git @gitArgs fetch origin main 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) {
  $fetchText = ($fetchLines | Select-Object -Last 3) -join " | "
  Add-Content -LiteralPath $logPath -Value "$stamp FAIL: fetch - $fetchText"
  Send-FailureAlert "git fetch failed: $fetchText"
  exit 1
}

# القفل يُقرأ من النسخة **المنشورة على origin/main**، لا من نسخة العمل المحلية.
# وهي المرجع الصحيح أصلاً: AI_WORK_SYNC يوجب نشر الحجز فوراً بـcommit وpush على
# main «كي تراه الجلسات والأجهزة الأخرى» — فالقفل المنشور هو إشارة التنسيق بين
# الأجهزة، والنسخة المحلية مجرد لقطة قديمة منه. قراءته بعد الجلب تجعل القيمة حيّة
# في الاتجاهين: لا قفل مُفلَت يبقى حاجزاً، ولا قفل حيّ يمرّ غير مرئي.
$publishedLock = & $git @gitArgs show origin/main:AI_ACTIVE_TASK.json 2>$null
if ($LASTEXITCODE -eq 0 -and $publishedLock) {
  try {
    $activeTask = ($publishedLock -join "`n") | ConvertFrom-Json
    if ($activeTask.status -eq "active") {
      Add-Content -LiteralPath $logPath -Value "$stamp SKIP: active AI task lock"
      exit 0
    }
  } catch {
    # تعذّر التحليل يمضي كما كان دائماً — لا يُقرأ الغموض قفلاً.
    Add-Content -LiteralPath $logPath -Value "$stamp WARN: could not parse AI_ACTIVE_TASK.json"
  }
} else {
  # غياب الملف عن main يمضي أيضاً، تماماً كما كان غيابه محلياً يمضي سابقاً.
  Add-Content -LiteralPath $logPath -Value "$stamp WARN: could not read AI_ACTIVE_TASK.json from origin/main"
}

# ملاحظة PowerShell 5.1: git يكتب رسائل عادية على stderr، ومع 2>&1 تصير كائنات خطأ —
# نحوّلها إلى نص ونحكم على النجاح برمز الخروج فقط.
$outputLines = & $git @gitArgs pull --rebase origin main 2>&1 | ForEach-Object { "$_" }
$outputText = ($outputLines | Select-Object -Last 3) -join " | "
if ($LASTEXITCODE -ne 0) {
  Add-Content -LiteralPath $logPath -Value "$stamp FAIL: $outputText"
  Send-FailureAlert $outputText
  & $git @gitArgs rebase --abort 2>$null | Out-Null
  exit 1
}
Add-Content -LiteralPath $logPath -Value "$stamp OK: $outputText"
exit 0
