[CmdletBinding()]
param(
    [string]$BridgeRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$bridgeScript = Join-Path $BridgeRoot "ozk-print-bridge.ps1"
$previewPath = Join-Path $BridgeRoot "manual-preview.png"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    [Windows.Forms.MessageBox]::Show("ملف تشغيل OZK Print Bridge غير موجود.", "OZK", "OK", "Error") | Out-Null
    exit 1
}

$form = New-Object Windows.Forms.Form
$form.Text = "إعادة طباعة فاتورة OZK"
$form.RightToLeft = [Windows.Forms.RightToLeft]::Yes
$form.RightToLeftLayout = $true
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.ClientSize = New-Object Drawing.Size(540, 370)
$form.Font = New-Object Drawing.Font("Tahoma", 12)
$form.BackColor = [Drawing.Color]::White

$title = New-Object Windows.Forms.Label
$title.Text = "إعادة طباعة فاتورة معدّلة"
$title.Font = New-Object Drawing.Font("Tahoma", 19, [Drawing.FontStyle]::Bold)
$title.TextAlign = "MiddleCenter"
$title.SetBounds(30, 20, 480, 48)
$form.Controls.Add($title)

$hint = New-Object Windows.Forms.Label
$hint.Text = "اختر الفاتورة ثم عاينها أو اطبعها على XPRINTER"
$hint.ForeColor = [Drawing.Color]::DimGray
$hint.TextAlign = "MiddleCenter"
$hint.SetBounds(30, 68, 480, 32)
$form.Controls.Add($hint)

function Add-FieldLabel([string]$Text, [int]$Top) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $Text
    $label.TextAlign = "MiddleRight"
    $label.SetBounds(365, $Top, 135, 34)
    $form.Controls.Add($label)
}

Add-FieldLabel "نوع الفاتورة" 115
$typeBox = New-Object Windows.Forms.ComboBox
$typeBox.DropDownStyle = "DropDownList"
[void]$typeBox.Items.Add("مبيعات مركز")
[void]$typeBox.Items.Add("مبيعات")
[void]$typeBox.Items.Add("مبيعات ل.س")
$typeBox.SelectedIndex = 0
$typeBox.SetBounds(115, 115, 240, 34)
$form.Controls.Add($typeBox)

Add-FieldLabel "تاريخ الفاتورة" 160
$datePicker = New-Object Windows.Forms.DateTimePicker
$datePicker.Format = "Custom"
$datePicker.CustomFormat = "yyyy/MM/dd"
$datePicker.SetBounds(115, 160, 240, 34)
$form.Controls.Add($datePicker)

Add-FieldLabel "رقم الفاتورة" 205
$numberBox = New-Object Windows.Forms.TextBox
$numberBox.TextAlign = "Center"
$numberBox.SetBounds(115, 205, 240, 34)
$form.Controls.Add($numberBox)

$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Text = "جاهز"
$statusLabel.ForeColor = [Drawing.Color]::DarkGreen
$statusLabel.TextAlign = "MiddleCenter"
$statusLabel.SetBounds(40, 250, 460, 30)
$form.Controls.Add($statusLabel)

$previewButton = New-Object Windows.Forms.Button
$previewButton.Text = "معاينة الفاتورة"
$previewButton.SetBounds(285, 295, 205, 48)
$form.Controls.Add($previewButton)

$printButton = New-Object Windows.Forms.Button
$printButton.Text = "طباعة على XPRINTER"
$printButton.BackColor = [Drawing.Color]::FromArgb(32, 99, 155)
$printButton.ForeColor = [Drawing.Color]::White
$printButton.FlatStyle = "Flat"
$printButton.SetBounds(50, 295, 215, 48)
$form.Controls.Add($printButton)

$typeMap = @{
    "مبيعات مركز" = "Retail"
    "مبيعات" = "Wholesale"
    "مبيعات ل.س" = "WholesaleSyp"
}

function Get-InvoiceSelection {
    $number = 0
    if (-not [int]::TryParse($numberBox.Text.Trim(), [ref]$number) -or $number -le 0) {
        throw "أدخل رقم فاتورة صحيحاً."
    }
    return [pscustomobject]@{
        Number = $number
        Date = $datePicker.Value.ToString("yyyy-MM-dd")
        Type = $typeMap[[string]$typeBox.SelectedItem]
    }
}

function Invoke-Bridge([string]$Mode, [bool]$Print) {
    $selection = Get-InvoiceSelection
    $arguments = @(
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $bridgeScript),
        "-Mode", $Mode,
        "-InvoiceNumber", [string]$selection.Number,
        "-InvoiceDate", $selection.Date,
        "-InvoiceType", $selection.Type,
        "-PreviewPath", ('"{0}"' -f $previewPath),
        "-PrinterName", '"XPRINTER XP-T80Q 80MM"'
    )
    if ($Print) { $arguments += "-ConfirmPhysicalPrint" }
    $form.UseWaitCursor = $true
    $previewButton.Enabled = $false
    $printButton.Enabled = $false
    try {
        $process = Start-Process -FilePath $powershellPath -ArgumentList ($arguments -join " ") -Wait -PassThru -WindowStyle Hidden
        if ($process.ExitCode -ne 0) { throw "لم يتم العثور على فاتورة معتمدة بهذه البيانات، أو تعذرت العملية." }
        return $selection
    } finally {
        $form.UseWaitCursor = $false
        $previewButton.Enabled = $true
        $printButton.Enabled = $true
    }
}

$previewButton.Add_Click({
    try {
        [void](Invoke-Bridge "PreviewInvoice" $false)
        $statusLabel.Text = "تم إنشاء المعاينة"
        $statusLabel.ForeColor = [Drawing.Color]::DarkGreen
        Start-Process -FilePath $previewPath
    } catch {
        $statusLabel.Text = "تعذر العثور على الفاتورة أو معاينتها"
        $statusLabel.ForeColor = [Drawing.Color]::DarkRed
        [Windows.Forms.MessageBox]::Show([string]$_.Exception.Message, "OZK", "OK", "Warning") | Out-Null
    }
})

$printButton.Add_Click({
    try {
        $selection = Get-InvoiceSelection
        $answer = [Windows.Forms.MessageBox]::Show(
            "هل تريد طباعة الفاتورة رقم $($selection.Number) على XPRINTER؟",
            "تأكيد الطباعة",
            [Windows.Forms.MessageBoxButtons]::YesNo,
            [Windows.Forms.MessageBoxIcon]::Question
        )
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { return }
        [void](Invoke-Bridge "PrintInvoice" $true)
        $statusLabel.Text = "تم إرسال الفاتورة إلى XPRINTER"
        $statusLabel.ForeColor = [Drawing.Color]::DarkGreen
    } catch {
        $statusLabel.Text = "فشلت الطباعة"
        $statusLabel.ForeColor = [Drawing.Color]::DarkRed
        [Windows.Forms.MessageBox]::Show([string]$_.Exception.Message, "OZK", "OK", "Error") | Out-Null
    }
})

$form.Add_Shown({ $numberBox.Focus() })
[void]$form.ShowDialog()
