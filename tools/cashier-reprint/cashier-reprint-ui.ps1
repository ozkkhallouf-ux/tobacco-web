# واجهة «إعادة طباعة فاتورة كاشير»: حقل رقم الفاتورة وزر «طباعة».
# كل العمل الفعلي في cashier-reprint.ps1 (عملية منفصلة)، والواجهة تعرض نتيجته فقط.
[CmdletBinding()]
param([string]$Root = "")

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$cliPath = Join-Path $PSScriptRoot "cashier-reprint.ps1"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function Invoke-ReprintCli([string[]]$Arguments) {
    $all = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $cliPath)) + $Arguments
    if (-not [string]::IsNullOrWhiteSpace($Root)) { $all += @("-Root", ('"{0}"' -f $Root)) }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powershellPath
    $info.Arguments = ($all -join " ")
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $process = [Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    [void]$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $line = @($stdoutTask.Result -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if ($line.Count -eq 0) { return [pscustomobject]@{ Status = "error"; Message = "لم تُرجع الأداة نتيجة مفهومة." } }
    return ($line[0] | ConvertFrom-Json)
}

$form = New-Object Windows.Forms.Form
$form.Text = "إعادة طباعة فاتورة كاشير"
$form.RightToLeft = [Windows.Forms.RightToLeft]::Yes
$form.RightToLeftLayout = $true
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.ClientSize = New-Object Drawing.Size(500, 330)
$form.Font = New-Object Drawing.Font("Tahoma", 12)
$form.BackColor = [Drawing.Color]::White

$title = New-Object Windows.Forms.Label
$title.Text = "إعادة طباعة فاتورة كاشير"
$title.Font = New-Object Drawing.Font("Tahoma", 18, [Drawing.FontStyle]::Bold)
$title.TextAlign = "MiddleCenter"
$title.SetBounds(20, 18, 460, 44)
$form.Controls.Add($title)

$numberLabel = New-Object Windows.Forms.Label
$numberLabel.Text = "رقم الفاتورة"
$numberLabel.TextAlign = "MiddleRight"
$numberLabel.SetBounds(330, 85, 140, 34)
$form.Controls.Add($numberLabel)

$numberBox = New-Object Windows.Forms.TextBox
$numberBox.TextAlign = "Center"
$numberBox.Font = New-Object Drawing.Font("Tahoma", 16)
$numberBox.SetBounds(90, 82, 230, 38)
$form.Controls.Add($numberBox)

# يظهر فقط حين يتكرر الرقم بأكثر من تاريخ.
$dateLabel = New-Object Windows.Forms.Label
$dateLabel.Text = "التاريخ"
$dateLabel.TextAlign = "MiddleRight"
$dateLabel.SetBounds(330, 135, 140, 34)
$dateLabel.Visible = $false
$form.Controls.Add($dateLabel)

$dateBox = New-Object Windows.Forms.ComboBox
$dateBox.DropDownStyle = "DropDownList"
$dateBox.SetBounds(90, 135, 230, 34)
$dateBox.Visible = $false
$form.Controls.Add($dateBox)

$statusLabel = New-Object Windows.Forms.Label
$statusLabel.Text = "أدخل رقم الفاتورة ثم اضغط «طباعة»"
$statusLabel.ForeColor = [Drawing.Color]::DimGray
$statusLabel.TextAlign = "MiddleCenter"
$statusLabel.SetBounds(20, 180, 460, 60)
$form.Controls.Add($statusLabel)

$printButton = New-Object Windows.Forms.Button
$printButton.Text = "طباعة"
$printButton.Font = New-Object Drawing.Font("Tahoma", 14, [Drawing.FontStyle]::Bold)
$printButton.BackColor = [Drawing.Color]::FromArgb(32, 99, 155)
$printButton.ForeColor = [Drawing.Color]::White
$printButton.FlatStyle = "Flat"
$printButton.SetBounds(150, 255, 200, 52)
$form.Controls.Add($printButton)
$form.AcceptButton = $printButton

function Set-Status([string]$Text, [string]$Kind) {
    $statusLabel.Text = $Text
    switch ($Kind) {
        "ok" { $statusLabel.ForeColor = [Drawing.Color]::DarkGreen }
        "error" { $statusLabel.ForeColor = [Drawing.Color]::DarkRed }
        "warn" { $statusLabel.ForeColor = [Drawing.Color]::DarkOrange }
        default { $statusLabel.ForeColor = [Drawing.Color]::DimGray }
    }
}

function Reset-DateChoice {
    $dateBox.Items.Clear()
    $dateBox.Visible = $false
    $dateLabel.Visible = $false
}

$numberBox.Add_TextChanged({ Reset-DateChoice })
$script:busy = $false

$printButton.Add_Click({
    if ($script:busy) { return }
    $script:busy = $true
    $printButton.Enabled = $false
    $numberBox.Enabled = $false
    $form.UseWaitCursor = $true
    try {
        $number = 0
        if (-not [int]::TryParse($numberBox.Text.Trim(), [ref]$number) -or $number -le 0) {
            Set-Status "أدخل رقم فاتورة صحيحاً." "error"
            return
        }
        $date = ""
        if ($dateBox.Visible) {
            if ($null -eq $dateBox.SelectedItem) { Set-Status "اختر تاريخ الفاتورة أولاً." "warn"; return }
            $date = [string]$dateBox.SelectedItem
        }
        Set-Status "جارٍ البحث عن الفاتورة في الأمين…" "info"
        $form.Refresh()
        $resolveArgs = @("-Mode", "Resolve", "-InvoiceNumber", [string]$number)
        if ($date) { $resolveArgs += @("-InvoiceDate", $date) }
        $found = Invoke-ReprintCli $resolveArgs

        if ($found.Status -eq "ambiguous" -and @($found.Dates).Count -gt 1) {
            $dateBox.Items.Clear()
            foreach ($d in @($found.Dates)) { [void]$dateBox.Items.Add([string]$d) }
            $dateBox.Visible = $true
            $dateLabel.Visible = $true
            Set-Status ([string]$found.Message) "warn"
            return
        }
        if ($found.Status -ne "ok") {
            Set-Status ([string]$found.Message) "error"
            return
        }

        $inv = $found.Invoice
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add("فاتورة كاشير رقم $($inv.Number)")
        $lines.Add("التاريخ: $($inv.Date)")
        if ($null -ne $inv.Total) { $lines.Add("الإجمالي: $($inv.Total)") }
        if ($inv.Customer) { $lines.Add("الزبون: $($inv.Customer)") }
        if ($null -ne $inv.AgeSeconds -and $inv.AgeSeconds -ge 0 -and $inv.AgeSeconds -lt [int]$found.NewInvoiceWarningSeconds) {
            $lines.Add("")
            $lines.Add("تنبيه: الفاتورة أُنشئت قبل لحظات، وقد تطبعها الطباعة التلقائية أيضاً.")
        }
        if ($found.LastReprintAt) {
            $lines.Add("")
            $lines.Add("طُبعت يدوياً من قبل على هذا الجهاز: $($found.LastReprintAt)")
        }
        $lines.Add("")
        $lines.Add("هل تريد طباعة نسخة على طابعة الكاشير؟")
        $answer = [Windows.Forms.MessageBox]::Show(($lines -join "`n"), "تأكيد الطباعة",
            [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question,
            [Windows.Forms.MessageBoxDefaultButton]::Button2, [Windows.Forms.MessageBoxOptions]::RtlReading)
        if ($answer -ne [Windows.Forms.DialogResult]::Yes) { Set-Status "أُلغيت الطباعة." "info"; return }

        # معرّف جديد لكل طلب صريح؛ إعادة المحاولة التقنية للطلب نفسه تُرفض في cashier-reprint.ps1.
        $requestId = [guid]::NewGuid().ToString()
        Set-Status "جارٍ الإرسال إلى طابعة الكاشير…" "info"
        $form.Refresh()
        $printArgs = @("-Mode", "Print", "-InvoiceNumber", [string]$number, "-InvoiceDate", [string]$inv.Date, "-RequestId", $requestId)
        $result = Invoke-ReprintCli $printArgs
        switch ([string]$result.Status) {
            "printed" { Set-Status ([string]$result.Message) "ok" }
            "uncertain" { Set-Status ([string]$result.Message) "warn" }
            default { Set-Status ([string]$result.Message) "error" }
        }
    } catch {
        Set-Status ("تعذّرت العملية: " + [string]$_.Exception.Message) "error"
    } finally {
        # تُستهلك أي نقرات تراكمت أثناء التنفيذ والزر ما زال معطّلاً، فلا تُطلق طلباً ثانياً.
        [Windows.Forms.Application]::DoEvents()
        $form.UseWaitCursor = $false
        $numberBox.Enabled = $true
        $printButton.Enabled = $true
        $script:busy = $false
    }
})

$form.Add_Shown({ $numberBox.Focus() })
[void]$form.ShowDialog()
