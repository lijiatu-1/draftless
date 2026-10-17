# 验证粘贴真的能落地。自己开一个 WinForms 窗口当靶子（不用记事本：Windows 11 的记事本是 UWP，
# 窗口挂在 ApplicationFrameHost 名下，找句柄和抢焦点都不稳），让小帮手往它的输入框发 Ctrl+V，
# 再把输入框的内容读出来比对。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev\verify-paste.ps1
# 退出码 0 = 粘贴成功；1 = 没进去；2 = 内容不对；3 = 找不到小帮手

param([string]$Text = "粘贴验证-OK-42")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$helper = Join-Path $PSScriptRoot "..\..\build\draftless-helper.exe"
if (-not (Test-Path $helper)) {
  Write-Output "找不到小帮手：$helper（先跑 npm run native）"
  exit 3
}

# 这些变量要在 timer 的 scriptblock 里用，所以放 script 作用域
# （PowerShell 的 scriptblock 不会自动捕获局部变量，直接用 $x 会是 null——踩过）
$script:helperProcess = $null
$script:events = New-Object System.Collections.ArrayList
$script:result = ""
$script:helper = $helper
$script:text = $Text

$form = New-Object System.Windows.Forms.Form
$form.Text = "Draftless 粘贴验证"
$form.Width = 640
$form.Height = 160
$form.StartPosition = "CenterScreen"
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = "Fill"
$box.Font = New-Object System.Drawing.Font("Consolas", 12)
$form.Controls.Add($box)

$form.Add_Shown({
  $form.Activate()
  $box.Focus()

  # 窗口先出来、拿到焦点，再让小帮手动手：它发的 Ctrl+V 是给"当前前台窗口"的
  $script:start = New-Object System.Windows.Forms.Timer
  $script:start.Interval = 700
  $script:start.Add_Tick({
    $script:start.Stop()
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:helper
    $psi.Arguments = "--key right_alt"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $script:helperProcess = [System.Diagnostics.Process]::Start($psi)
    $script:helperProcess.StandardInput.WriteLine('{"cmd":"paste","id":1,"text":"' + $script:text + '"}')
    $script:helperProcess.StandardInput.Flush()
  })
  $script:start.Start()

  # 给它时间：起进程 + 写剪贴板 + 发按键 + 0.3 秒后还原剪贴板
  $script:done = New-Object System.Windows.Forms.Timer
  $script:done.Interval = 2600
  $script:done.Add_Tick({
    $script:done.Stop()
    if ($script:helperProcess) {
      try {
        while (-not $script:helperProcess.StandardOutput.EndOfStream) {
          $line = $script:helperProcess.StandardOutput.ReadLine()
          if ($line) { [void]$script:events.Add($line) }
        }
        $script:helperProcess.StandardInput.Close()
        if (-not $script:helperProcess.HasExited) { $script:helperProcess.Kill() }
      } catch { }
    }
    $script:result = $box.Text
    $form.Close()
  })
  $script:done.Start()
})

[System.Windows.Forms.Application]::Run($form)

Write-Output "小帮手说的："
foreach ($line in $script:events) { Write-Output "  $line" }
Write-Output ""
Write-Output "输入框里是：$([char]34)$($script:result)$([char]34)"
Write-Output "期望：      $([char]34)$($script:text)$([char]34)"

if ($script:result -eq $script:text) {
  Write-Output ""
  Write-Output "OK 粘贴成功：文字到了光标那里"
  exit 0
} elseif ([string]::IsNullOrEmpty($script:result)) {
  Write-Output ""
  Write-Output "FAIL 一个字都没进去"
  exit 1
} else {
  Write-Output ""
  Write-Output "FAIL 内容不对"
  exit 2
}