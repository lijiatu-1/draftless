<#
.SYNOPSIS
  把打好的 Draftless 装进本机，之后在终端里就能用 draftless 命令。

.DESCRIPTION
  安装流程和原版一致：把程序放进数据目录、给 PATH 里留一条命令、
  建一个开始菜单的快捷方式。区别是 Windows 上不需要 sudo，也不往系统目录里装——所有东西都在
  %USERPROFILE%\.draftless 下，卸载时删掉它就干净了。

  这个脚本不做下载：它装的是 `npm run dist` 打出来的那一份，或者从发布包里解出来的那一份。

.PARAMETER Source
  装哪个目录。默认是从这个脚本往上两级的 dist\Draftless-win32-x64。

.PARAMETER Home
  数据目录。默认 %USERPROFILE%\.draftless；安装脚本只往它的 app\ 里放程序，不碰你的设置和历史。

.PARAMETER NoPath
  不往用户的 PATH 里加一条。加了之后要重开一个终端才认。

.PARAMETER NoShortcut
  不建开始菜单的快捷方式。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build\install.ps1
#>
[CmdletBinding()]
param(
  [string]$Source,
  [string]$InstallHome = (Join-Path $env:USERPROFILE ".draftless"),
  [switch]$NoPath,
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"

function Say([string]$Message) { Write-Host $Message }
function Fail([string]$Message) { Write-Error $Message; exit 1 }

# 默认装 dist 下打好的那一份。
# 但这个脚本还有第二种活法：打包时会被复制进程序目录的根上（发布包解压出来就是这样），
# 那时"脚本自己所在的目录"就是程序目录，直接用它——用户不用记 -Source 该指哪。
if (-not $Source) {
  if (Test-Path (Join-Path $PSScriptRoot "Draftless.exe")) {
    $Source = $PSScriptRoot
  } else {
    $root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
    $Source = Join-Path $root "dist\Draftless-win32-x64"
  }
}
if (-not (Test-Path $Source)) {
  Fail "找不到要装的目录：$Source`n先跑一次 npm run dist 打出程序，或者解开发布包再指过来。"
}
$exe = Join-Path $Source "Draftless.exe"
if (-not (Test-Path $exe)) {
  Fail "$Source 里没有 Draftless.exe，这不像是打好的程序目录。"
}

# 正在跑的先停掉：文件被占着就替不上去
$running = Get-Process -Name "Draftless" -ErrorAction SilentlyContinue
if ($running) {
  Say "Draftless 正在运行，先请它退出…"
  $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Milliseconds 800
  $still = Get-Process -Name "Draftless" -ErrorAction SilentlyContinue
  if ($still) {
    $still | Stop-Process -Force
    Start-Sleep -Milliseconds 400
  }
}

# 装进 app\，先摆到旁边的临时目录再换上去：中途失败时原来那一份还在
$target = Join-Path $InstallHome "app"
$staging = Join-Path $InstallHome "app.new"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Say "正在装到 $staging …"
# -Path 指向源目录、-Destination 是已经存在的目标目录：这时 Copy-Item 把源目录**里面的东西**拷进目标，
# 而不会多套一层。这一句在 Windows PowerShell 5.1 上实测过，别改成只给两个位置参数的那种写法
Copy-Item -Path (Join-Path $Source "*") -Destination $staging -Recurse -Force
if (-not (Test-Path (Join-Path $staging "Draftless.exe"))) {
  Remove-Item -Recurse -Force $staging
  Fail "拷贝之后 $staging 里没有 Draftless.exe，装不上去。"
}
$stamp = [DateTime]::UtcNow.ToString("o")
Set-Content -Path (Join-Path $staging "installed.txt") -Value "installed_at=$stamp`nsource=$Source" -Encoding UTF8
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Move-Item $staging $target
Say "装好了：$target"

# 开始菜单的快捷方式：不建的话 Start 菜单里搜不到它，只能从文件夹双击
if (-not $NoShortcut) {
  try {
    $programs = [Environment]::GetFolderPath("Programs")
    $link = Join-Path $programs "Draftless.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $target "Draftless.exe"
    $shortcut.WorkingDirectory = $target
    $shortcut.Description = "Draftless：按一下热键说话，整理好的文字贴进当前输入框"
    $shortcut.IconLocation = Join-Path $target "resources\app\assets\app.ico"
    $shortcut.Save()
    Say "建好了开始菜单的快捷方式：$link"
  } catch {
    Say "开始菜单的快捷方式没建成（不影响使用）：$($_.Exception.Message)"
  }
}

# 命令行的入口：一个 .cmd，转给 exe 的 --cli。
#
# 为什么不直接把 <家>\app 加进 PATH：那里的 Draftless.exe 和命令同名（Windows 不区分大小写），
# 而 PATHEXT 里 .EXE 排在 .CMD 前面，敲 draftless 会先命中 exe、弹出窗口而不是跑子命令。
# 所以命令单独放一个目录（<家>\bin，和原版的做法一致），PATH 里只加那一个。
$binDir = Join-Path $InstallHome "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cmdPath = Join-Path $binDir "draftless.cmd"
$exePath = Join-Path $target "Draftless.exe"
# 用环境变量而不是命令行开关：Electron 会把不认识的 --xxx 当成自己的开关直接拒掉
# （报 "bad option: --cli"），所以子命令只能靠环境变量告诉它。
# 注释只用 ASCII：.cmd 按控制台的代码页解，中文注释在 cmd 里会被当成命令去执行。
$cmd = @"
@echo off
setlocal
set DRAFTLESS_ARGV_MODE=cli
"$exePath" %*
"@
Set-Content -Path $cmdPath -Value $cmd -Encoding OEM
Say "建好了命令行的入口：$cmdPath"

# PATH：只加 bin 那一个目录
if (-not $NoPath) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @()
  if ($current) { $entries = $current.Split(";") | Where-Object { $_ -ne "" } }
  if ($entries -notcontains $binDir) {
    $updated = (@($entries) + $binDir) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    Say "已经把 $binDir 加进用户的 PATH，重开一个终端就认得 draftless 这个命令了。"
  } else {
    Say "$binDir 已经在 PATH 里了。"
  }
}

Say ""
Say "装上之后："
Say "  1. 从开始菜单或桌面双击 Draftless（也可以直接跑 `"$exePath`"）"
Say "  2. 它待在托盘里；右键托盘图标可以打开主窗口、看历史、改设置"
Say "  3. 第一次用会带你填一把 Gemini 或 OpenAI 的 key"
Say "  4. 终端里敲 draftless 就是命令行（draftless status、draftless history…）"
Say "  5. 数据都在 $InstallHome，卸载时删掉它就干净了（draftless uninstall 也会帮你删）"
