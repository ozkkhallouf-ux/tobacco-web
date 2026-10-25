# اختبار قالب المهمة المجدولة OZK-DriveArchive-DryRun.task.xml تحت Windows PowerShell 5.1 (وPowerShell 7).
# التثبيت على OZK2026 نسخة من المستودع داخل %ProgramData%\OZK\DriveArchive\app، فالعامل في
# app\tools\drive-invoice-archive\worker.js. القالب الأول أشار إلى app\run-scheduled.ps1، والغلاف يعدّ
# مجلده مجلد العامل، فكانت كل دورة ستفشل بـ12 (worker.js غير موجود). هذا الاختبار يمنع عودة ذلك.
# قراءة ملفات فقط: لا يسجّل مهمة ولا يشغّل الغلاف ولا العامل.

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $toolDir)
$templatePath = Join-Path $toolDir 'scheduled-task\OZK-DriveArchive-DryRun.task.xml'
$appRoot = 'C:\ProgramData\OZK\DriveArchive\app'

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

function Get-TemplateAction([string]$Xml) {
    $doc = New-Object Xml.XmlDocument
    $doc.LoadXml($Xml)
    $ns = New-Object Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $exec = $doc.SelectSingleNode('/t:Task/t:Actions/t:Exec', $ns)
    $m = [regex]::Match([string]$exec.SelectSingleNode('t:Arguments', $ns).InnerText, '-File\s+"([^"]+)"')
    return [pscustomobject]@{
        Doc = $doc; Ns = $ns
        File = if ($m.Success) { $m.Groups[1].Value } else { '' }
        Arguments = [string]$exec.SelectSingleNode('t:Arguments', $ns).InnerText
        WorkingDirectory = [string]$exec.SelectSingleNode('t:WorkingDirectory', $ns).InnerText
    }
}

# يحوّل مسار التثبيت إلى مساره في المستودع؛ نص فارغ إن كان خارج app.
function ConvertTo-RepoPath([string]$InstalledPath) {
    $prefix = $appRoot + '\'
    if (-not $InstalledPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    $rel = $InstalledPath.Substring($prefix.Length).Replace('\', [IO.Path]::DirectorySeparatorChar)
    return Join-Path $repoRoot $rel
}

# أخطاء المسار بلغة واحدة يستعملها القالب الحقيقي ونسخة الانحدار معاً.
function Get-PathErrors($Action) {
    $errors = @()
    if (-not $Action.File) { return @('لا -File في الوسائط') }
    $cut = $Action.File.LastIndexOf('\')
    $installedDir = if ($cut -gt 0) { $Action.File.Substring(0, $cut) } else { '' }
    if ($Action.File.Substring($cut + 1) -ne 'run-scheduled.ps1') { $errors += 'الملف ليس run-scheduled.ps1' }
    $repoWrapper = ConvertTo-RepoPath $Action.File
    if (-not $repoWrapper) { $errors += "الغلاف خارج $appRoot" }
    elseif (-not (Test-Path -LiteralPath $repoWrapper -PathType Leaf)) { $errors += "لا غلاف في المسار المقابل بالمستودع: $repoWrapper" }
    else {
        # الغلاف يعدّ مجلده مجلد العامل (-WorkerDir = $PSScriptRoot) ويقرأ config.json بجانبه.
        $workerDir = Split-Path -Parent $repoWrapper
        if (-not (Test-Path -LiteralPath (Join-Path $workerDir 'worker.js') -PathType Leaf)) { $errors += 'لا worker.js بجانب الغلاف' }
        if (-not (Test-Path -LiteralPath (Join-Path $workerDir 'config.example.json') -PathType Leaf)) { $errors += 'لا config.example.json بجانب الغلاف' }
    }
    if ($Action.WorkingDirectory.TrimEnd('\') -ne $installedDir) { $errors += 'WorkingDirectory ليس مجلد الغلاف' }
    return $errors
}

$xml = [IO.File]::ReadAllText($templatePath, [Text.Encoding]::UTF8)
$a = Get-TemplateAction $xml

# ── مسار الغلاف ───────────────────────────────────────────────────────────────
$errors = @(Get-PathErrors $a)
Assert ('مسار الغلاف يطابق التثبيت الفعلي' + $(if ($errors.Count) { ': ' + ($errors -join '؛ ') } else { '' })) ($errors.Count -eq 0)
Assert 'المسار المتوقع حرفياً' ($a.File -eq "$appRoot\tools\drive-invoice-archive\run-scheduled.ps1")
Assert 'مجلد العمل هو مجلد العامل' ($a.WorkingDirectory -eq "$appRoot\tools\drive-invoice-archive")

# ── انحدار: المسار القديم يُرفض ───────────────────────────────────────────────
$old = $xml.Replace("$appRoot\tools\drive-invoice-archive\run-scheduled.ps1", "$appRoot\run-scheduled.ps1").Replace("<WorkingDirectory>$appRoot\tools\drive-invoice-archive</WorkingDirectory>", "<WorkingDirectory>$appRoot</WorkingDirectory>")
Assert 'نسخة الانحدار تحمل المسار القديم' ($old -ne $xml -and $old.Contains("$appRoot\run-scheduled.ps1"))
Assert 'المسار القديم app\run-scheduled.ps1 يُرفض' (@(Get-PathErrors (Get-TemplateAction $old)).Count -gt 0)

# ── إعدادات الأمان لم تتغير ───────────────────────────────────────────────────
$doc = $a.Doc; $ns = $a.Ns
Assert 'القالب معطَّل' ($doc.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $ns).InnerText -eq 'false')
Assert 'الوضع dry-run وحده' ($a.Arguments -match '-AllowedModes dry-run(\s|$)' -and $a.Arguments -notmatch 'drive,|live')
Assert 'مهلة الغلاف 600' ($a.Arguments -match '-TimeoutSeconds 600(\s|$)')
Assert 'نسخة واحدة IgnoreNew' ($doc.SelectSingleNode('/t:Task/t:Settings/t:MultipleInstancesPolicy', $ns).InnerText -eq 'IgnoreNew')
Assert 'S4U بلا كلمة مرور' ($doc.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:LogonType', $ns).InnerText -eq 'S4U' -and $xml -notmatch '<Password>')

Write-Host ''
Write-Host "task-template: $script:pass PASS, $script:fail FAIL"
if ($script:fail -gt 0) { exit 1 }
exit 0
