param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AntigravityAccountPool'),
    [string]$DesktopRoot = ([Environment]::GetFolderPath('Desktop')),
    [Parameter(Mandatory)][string]$PowerShell7Path,
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$ManagerConfig = (Join-Path $env:LOCALAPPDATA 'agy\bin\agychange.config.json')
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($InstallRoot.TrimEnd('\') -ieq $PSScriptRoot.TrimEnd('\')) { throw 'Choose an installation folder separate from the development checkout.' }
if (Test-Path -LiteralPath (Join-Path $InstallRoot 'installed.json')) { throw 'A completed installation already exists. Do not overwrite a running installation.' }
foreach ($runtime in @($PowerShell7Path, $NodePath)) {
    if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { throw "Runtime not found: $runtime" }
    if ($runtime -match 'codex-runtimes') { throw 'Use your installed PowerShell and Node runtimes for the permanent installation.' }
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'public') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'data') -Force | Out-Null
$files = @('server.mjs', 'oauth-client.mjs', 'quota-policy.mjs', 'quota-policy.test.mjs', 'package.json', 'README.md',
    'AgyCredential.ps1', 'CredentialBridge.ps1', 'Launch-Agy.ps1', 'Open-AgyWindow.ps1',
    'Restore-AgySettings.ps1', 'Runtime-AgyPool.ps1', 'Start-AgyPool.ps1', 'Open-AgyPool.ps1',
    'Complete-Install.ps1', 'Tray-AgyPool.ps1')
foreach ($name in $files) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $InstallRoot $name) -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'public\index.html') -Destination (Join-Path $InstallRoot 'public\index.html') -Force
@{ pwsh = $PowerShell7Path; node = $NodePath } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $InstallRoot 'runtime.json') -Encoding UTF8
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'install-pending.json'))) {
    $sourceData = Join-Path $PSScriptRoot 'data\accounts.json'
    $installMode = if (Test-Path -LiteralPath $sourceData -PathType Leaf) { 'migrate' } else { 'fresh' }
    @{ sourceRoot = $PSScriptRoot; dataCopied = $false; mode = $installMode } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $InstallRoot 'install-pending.json') -Encoding UTF8
}
$shortcutPath = Join-Path $DesktopRoot 'Antigravity Account Pool.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallRoot 'Open-AgyPool.ps1') + '"'
$shortcut.WorkingDirectory = $InstallRoot
$shortcut.Description = 'Open Antigravity Account Pool and its Windows tray icon'
$agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
$customIcon = Join-Path $PSScriptRoot 'assets\account-pool-v1.ico'
if (Test-Path -LiteralPath $customIcon) {
    $installedIcon = Join-Path $InstallRoot 'account-pool-v1.ico'
    Copy-Item -LiteralPath $customIcon -Destination $installedIcon -Force
    $shortcut.IconLocation = $installedIcon + ',0'
} elseif (Test-Path -LiteralPath $agy) { $shortcut.IconLocation = $agy + ',0' }
$shortcut.Save()
if (Test-Path -LiteralPath $ManagerConfig) {
    $config = Get-Content -LiteralPath $ManagerConfig -Raw | ConvertFrom-Json
    $config.poolRoot = $InstallRoot
    $config | ConvertTo-Json | Set-Content -LiteralPath $ManagerConfig -Encoding UTF8
}
Write-Output "Installed app files in $InstallRoot"
Write-Output 'Double-click the Desktop shortcut to complete installation and open the dashboard. Finish active CLI tasks first if migrating an existing pool.'
