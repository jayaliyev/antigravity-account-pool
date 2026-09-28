$ErrorActionPreference = 'Stop'

try {
    $pendingPath = Join-Path $PSScriptRoot 'install-pending.json'
    if (Test-Path -LiteralPath $pendingPath) {
        & (Join-Path $PSScriptRoot 'Complete-Install.ps1')
    }
    & (Join-Path $PSScriptRoot 'Start-AgyPool.ps1')
} catch {
    $message = "Could not open Antigravity Account Pool.`r`n`r`n$($_.Exception.Message)"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            $message, 'Antigravity Account Pool',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
        Write-Error $message
    }
    exit 1
}
