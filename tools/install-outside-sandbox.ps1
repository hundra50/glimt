# Installs the newest build from dist\ and restarts Glimt.
#
# Run it from Task Scheduler when the shell you build in is sandboxed (for example a packaged/MSIX
# app): processes started from such a sandbox get a private copy of the registry and %APPDATA%,
# so an install or autostart set up from there never reaches the real Windows session.
#   schtasks /Create /TN GlimtInstall /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>\install-outside-sandbox.ps1" /SC ONCE /ST 23:59 /F
#   schtasks /Run /TN GlimtInstall
# From a normal terminal you can simply run the installer in dist\ yourself.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'install.log'
function L($m) { "$(Get-Date -Format s) $m" | Out-File $log -Append -Encoding utf8 }

$setup = Get-ChildItem (Join-Path (Split-Path $PSScriptRoot) 'dist') -Filter 'Glimt Setup *.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { L 'no installer in dist\ - run "npm run dist" first'; exit 1 }

L "installing $($setup.Name)"
Get-Process Glimt -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
$p = Start-Process $setup.FullName -ArgumentList '/S' -PassThru -Wait
L "installer exit $($p.ExitCode)"
Start-Sleep 3
Get-Process Glimt -ErrorAction SilentlyContinue | Stop-Process -Force   # the installer starts it; start it cleanly once
Start-Sleep 2

Start-Process "$env:LOCALAPPDATA\Programs\Glimt\Glimt.exe"
L 'Glimt started'
Start-Sleep 10
$null = schtasks /Query /TN Glimt 2>$null; L "autostart task exists: $($LASTEXITCODE -eq 0)"
L 'done'
