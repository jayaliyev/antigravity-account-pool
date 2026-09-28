$ErrorActionPreference = 'Stop'
try {
    $installRoot = Join-Path $env:LOCALAPPDATA 'AntigravityAccountPool'
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'installed.json'))) {
        . (Join-Path $PSScriptRoot 'Runtime-AgyPool.ps1')
        & (Join-Path $PSScriptRoot 'Install-Desktop.ps1') -InstallRoot $installRoot -PowerShell7Path (Resolve-AgyRuntime 'pwsh') -NodePath (Resolve-AgyRuntime 'node')
    }
    & (Join-Path $installRoot 'Open-AgyPool.ps1')
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Antigravity Account Pool installation', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
    exit 1
}
