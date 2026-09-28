param([switch]$NoBrowser, [switch]$NoTray, [switch]$CompletingInstall)
$ErrorActionPreference = 'Stop'
if (-not $CompletingInstall -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'install-pending.json'))) {
    & (Join-Path $PSScriptRoot 'Complete-Install.ps1')
}
. (Join-Path $PSScriptRoot 'Runtime-AgyPool.ps1')
$env:AGY_POOL_PWSH = Resolve-AgyRuntime 'pwsh'
$nodePath = Resolve-AgyRuntime 'node'
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$url = 'http://127.0.0.1:18454/'

function Open-Dashboard {
    if (-not $NoTray) {
        $tray = Join-Path $PSScriptRoot 'Tray-AgyPool.ps1'
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-Process -FilePath $windowsPowerShell -ArgumentList ('-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $tray + '"') -WindowStyle Hidden | Out-Null
    }
    if (-not $NoBrowser) {
        try { Start-Process $url -ErrorAction Stop }
        catch { throw "The pool is running, but Windows could not open your default browser. Open $url" }
    }
}

$startLock = New-Object Threading.Mutex($false, 'Local\AntigravityAccountPool.Start.v2')
$locked = $false
try {
try { $locked = $startLock.WaitOne(60000) } catch [Threading.AbandonedMutexException] { $locked = $true }
if (-not $locked) { throw 'Another account pool launch is still starting. Try again shortly.' }
$alreadyRunning = $false
try {
    $ready = Invoke-WebRequest -Uri "$($url)api/status" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    $alreadyRunning = $ready.StatusCode -eq 200
} catch { }
if ($alreadyRunning) {
    Open-Dashboard
    Write-Output "Account pool is already running at $url"
    return
}

$outLog = Join-Path $PSScriptRoot 'data\server.stdout.log'
$errLog = Join-Path $PSScriptRoot 'data\server.stderr.log'
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
$process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    try {
        $ready = Invoke-WebRequest -Uri "$($url)api/status" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        if ($ready.StatusCode -eq 200) {
            Open-Dashboard
            Write-Output "Account pool opened at $url"
            return
        }
    } catch { }
    if ($process.HasExited) {
        Start-Sleep -Milliseconds 500
        try {
            $ready = Invoke-WebRequest -Uri "$($url)api/status" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
            if ($ready.StatusCode -eq 200) {
                Open-Dashboard
                Write-Output "Account pool is running at $url"
                return
            }
        } catch { }
        throw "Account pool stopped during startup. See $errLog"
    }
    Start-Sleep -Milliseconds 300
}
throw "Account pool did not start within 45 seconds. See $errLog"
} finally {
    if ($locked) { $startLock.ReleaseMutex() }
    $startLock.Dispose()
}
