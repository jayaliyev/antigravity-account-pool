function Resolve-AgyRuntime([ValidateSet('pwsh', 'node')][string]$Name) {
    $candidates = @()
    $configPath = Join-Path $PSScriptRoot 'runtime.json'
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.$Name) { $candidates += [string]$config.$Name }
    }
    if ($Name -eq 'pwsh') {
        $candidates += (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')
    } else { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command ($Name + '.exe') -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notmatch 'codex-runtimes') { return $command.Source }
    if ($Name -eq 'pwsh') {
        # Discover a new Store package path after a PowerShell update.
        if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
            foreach ($package in @(Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction SilentlyContinue)) {
                $candidate = Join-Path $package.InstallLocation 'pwsh.exe'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            }
        }
    }
    # Permanent installs record the installed runtimes.
    if ($command) { return $command.Source }
    throw "$Name.exe was not found. Install $(if ($Name -eq 'pwsh') { 'PowerShell 7' } else { 'Node.js' }) and reopen the shortcut."
}
