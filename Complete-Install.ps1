$ErrorActionPreference = 'Stop'
$pendingPath = Join-Path $PSScriptRoot 'install-pending.json'
$migrationLock = New-Object Threading.Mutex($false, 'Local\AntigravityAccountPool.Install.v2')
$locked = $false
try {
    try { $locked = $migrationLock.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'The installation is already being completed. Try again shortly.' }
    if (-not (Test-Path -LiteralPath $pendingPath)) { return }
    $pending = Get-Content -LiteralPath $pendingPath -Raw | ConvertFrom-Json
    # Pending files created before fresh installation support are migration requests.
    $mode = if ($pending.PSObject.Properties['mode']) { [string]$pending.mode } else { 'migrate' }
    if ($mode -notin @('fresh', 'migrate')) { throw "Unknown installation mode: $mode" }
    $baseUrl = 'http://127.0.0.1:18454/'
    if (-not $pending.dataCopied) {
        $running = $false
        try { $null = Invoke-RestMethod ($baseUrl + 'api/status') -TimeoutSec 3; $running = $true } catch { }
        if ($mode -eq 'fresh' -and $running) {
            throw 'Another account pool is running. Stop it after your CLI tasks finish, then reopen the Desktop shortcut.'
        }
        if ($mode -eq 'migrate' -and $running) {
            $page = (Invoke-WebRequest $baseUrl -UseBasicParsing -TimeoutSec 5).Content
            $match = [regex]::Match($page, "const key = '([0-9a-f]{64})'")
            if (-not $match.Success) { throw 'The existing pool could not be identified. Finish your CLI tasks and stop it from its dashboard, then reopen the shortcut.' }
            $null = Invoke-RestMethod ($baseUrl + 'api/stop') -Method Post -ContentType 'application/json' -Headers @{ 'x-agy-pool-key' = $match.Groups[1].Value } -Body '{}' -TimeoutSec 10
            $deadline = (Get-Date).AddSeconds(45)
            do {
                Start-Sleep -Milliseconds 300
                $tcp = New-Object Net.Sockets.TcpClient
                try { $tcp.Connect('127.0.0.1', 18454); $listening = $true } catch { $listening = $false } finally { $tcp.Dispose() }
            } while ($listening -and (Get-Date) -lt $deadline)
            if ($listening) { throw 'The old pool is still finishing requests. Wait until your tasks are idle, then reopen the Desktop shortcut.' }
        }
        if ($mode -eq 'migrate') {
            $oldData = Join-Path ([string]$pending.sourceRoot) 'data\accounts.json'
            if (-not (Test-Path -LiteralPath $oldData -PathType Leaf)) { throw 'Saved account metadata was not found in the original installation.' }
            $metadata = Get-Content -LiteralPath $oldData -Raw | ConvertFrom-Json
            if (-not $metadata.accounts -or @($metadata.accounts).Count -eq 0) { throw 'Original account list is empty; migration was stopped.' }
            $dataDir = Join-Path $PSScriptRoot 'data'
            New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
            Copy-Item -LiteralPath $oldData -Destination (Join-Path $dataDir 'accounts.json') -Force
        }
        $pending.dataCopied = $true
        $pending | ConvertTo-Json | Set-Content -LiteralPath $pendingPath -Encoding UTF8
    }
    # Runs in the interactive Windows user's context, retaining access to existing credentials.
    & (Join-Path $PSScriptRoot 'Start-AgyPool.ps1') -NoBrowser -NoTray -CompletingInstall
    $state = Invoke-RestMethod ($baseUrl + 'api/status') -TimeoutSec 5
    if ($null -eq $state.accounts) { throw 'The installed pool did not return an account list.' }
    if ($mode -eq 'migrate' -and @($state.accounts).Count -eq 0) { throw 'The installed pool did not return its saved accounts.' }
    @{ installedAt = (Get-Date).ToString('o'); installRoot = $PSScriptRoot; version = '0.2.0' } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed.json') -Encoding UTF8
    Remove-Item -LiteralPath $pendingPath -Force
} finally {
    if ($locked) { $migrationLock.ReleaseMutex() }
    $migrationLock.Dispose()
}
