# OzkPrintBridgeCommon.psm1
#
# مصدر واحد لحساب مسار state.json الكانوني (canonical) الذي يجب أن يشترك فيه
# كل من الواجهة اليدوية (ozk-print-bridge-ui.ps1) والمراقب الإنتاجي
# (watchdog + task wrapper) وسكربت الجسر نفسه (ozk-print-bridge.ps1) — إصلاح
# P1-D. عدم تطابق هذا المسار بين الكاتب اليدوي والمراقب كان يعني أن الواجهة
# اليدوية تكتب إلى ملف حالة مختلف تماماً عن الذي يقرأه المراقب، فلا "يرى"
# المراقب أبداً أن الفاتورة طُبعت يدوياً.
#
# القاعدة: %LOCALAPPDATA%\OZK-TOBACCO\PrintBridge\state.json فقط. لا fallback
# صامت إلى ProgramData (لأنه مسار مختلف بصلاحيات مختلفة وهو أصل مشكلة P1-D)،
# ولا استخدام Documents/Desktop (غير مخصصين لبيانات تطبيق آلية وقد لا يكونان
# مكتوبين من خدمة/مهمة مجدولة تعمل بسياق مختلف).

Set-StrictMode -Version Latest

function Get-OzkPrintBridgeUserStatePath {
    <#
    .SYNOPSIS
        يحسب المسار الكانوني الوحيد لملف state.json الذي يجب أن تشترك فيه
        الواجهة اليدوية، سكربت الجسر، والمراقب الإنتاجي معاً (إصلاح P1-D).
    .DESCRIPTION
        يعتمد حصراً على [Environment]::GetFolderPath("LocalApplicationData")
        أي %LOCALAPPDATA% الخاص بالمستخدم الحالي. إذا تعذّر تحديد هذا المجلد
        (يرجع فارغاً أو فشل استدعاؤه)، تُرمى استثناء واضح فوراً — لا يوجد أي
        fallback صامت إلى ProgramData أو Documents أو Desktop.
    #>
    [CmdletBinding()]
    param()

    $localAppData = $null
    try {
        $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    } catch {
        $localAppData = $null
    }

    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw "تعذّر تحديد مجلد LocalApplicationData (%LOCALAPPDATA%) الخاص بالمستخدم الحالي؛ لا يمكن حساب مسار state.json الكانوني بأمان. لا يوجد fallback صامت إلى ProgramData أو Documents أو Desktop — يجب إصلاح بيئة التشغيل (مثلاً حساب مستخدم بدون ملف تعريف محمّل بشكل صحيح) قبل المتابعة."
    }

    return Join-Path $localAppData "OZK-TOBACCO\PrintBridge\state.json"
}

Export-ModuleMember -Function Get-OzkPrintBridgeUserStatePath
