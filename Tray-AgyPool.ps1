$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[Windows.Forms.Application]::EnableVisualStyles()
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\AntigravityAccountPool.Tray.v2', [ref]$created)
if (-not $created) { $mutex.Dispose(); exit 0 }
$script:root = $PSScriptRoot
$script:url = 'http://127.0.0.1:18454/'
$script:statusPath = Join-Path $PSScriptRoot 'data\tray.status.json'
$script:context = New-Object Windows.Forms.ApplicationContext
$script:icon = New-Object Windows.Forms.NotifyIcon
$script:menu = New-Object Windows.Forms.ContextMenuStrip
$script:statusItem = $script:menu.Items.Add('Pool: checking...')
$script:statusItem.Enabled = $false
$openItem = $script:menu.Items.Add('Open dashboard')
$startItem = $script:menu.Items.Add('Start pool')
[void]$script:menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$quitItem = $script:menu.Items.Add('Quit account pool...')
$script:client = New-Object Net.Http.HttpClient
$script:client.Timeout = [TimeSpan]::FromSeconds(3)
$script:task = $null
$script:nextCheck = [DateTime]::MinValue
$script:running = $false
$script:quitting = $false
$script:lastStatus = ''
$script:lastWrite = [DateTime]::MinValue
$script:icon.ContextMenuStrip = $script:menu
$script:icon.Icon = [Drawing.SystemIcons]::Information
$script:icon.Text = 'Antigravity Account Pool - checking'
$script:icon.Visible = $true
function Write-TrayState([string]$State) {
    if ($State -eq $script:lastStatus -and (Get-Date) -lt $script:lastWrite.AddSeconds(15)) { return }
    @{ pid = $PID; status = $State; checkedAt = (Get-Date).ToString('o'); root = $script:root } |
        ConvertTo-Json | Set-Content -LiteralPath $script:statusPath -Encoding UTF8
    $script:lastStatus = $State; $script:lastWrite = Get-Date
}
function Show-TrayError([string]$Message) {
    [void][Windows.Forms.MessageBox]::Show($Message, 'Antigravity Account Pool', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error)
}
$openAction = {
    try { Start-Process $script:url -ErrorAction Stop } catch { Show-TrayError ('Open this address in your browser: ' + $script:url) }
}
$openItem.add_Click($openAction)
$script:icon.add_DoubleClick($openAction)
$startItem.add_Click({
    try { & (Join-Path $script:root 'Start-AgyPool.ps1') -NoBrowser -NoTray; $script:nextCheck = [DateTime]::MinValue }
    catch { Show-TrayError $_.Exception.Message }
})
$quitItem.add_Click({
    $choice = [Windows.Forms.MessageBox]::Show('Quit the pool? Open Antigravity CLI sessions cannot send requests until you start the pool again.', 'Antigravity Account Pool', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
    if ($choice -ne [Windows.Forms.DialogResult]::Yes) { return }
    try {
        $page = $null
        try { $page = (Invoke-WebRequest $script:url -UseBasicParsing -TimeoutSec 3).Content } catch { if ($script:running) { throw } }
        if ($page) {
            $match = [regex]::Match($page, "const key = '([0-9a-f]{64})'")
            if (-not $match.Success) { throw 'Could not identify the pool. Stop it from the dashboard before quitting.' }
            $null = Invoke-RestMethod ($script:url + 'api/stop') -Method Post -ContentType 'application/json' -Headers @{ 'x-agy-pool-key' = $match.Groups[1].Value } -Body '{}' -TimeoutSec 10
        }
        $script:quitting = $true; $script:context.ExitThread()
    } catch { Show-TrayError $_.Exception.Message }
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
    if ($script:quitting) { return }
    try {
        if ($script:task -and $script:task.IsCompleted) {
            $response = $null
            try {
                $response = $script:task.GetAwaiter().GetResult()
                if (-not $response.IsSuccessStatusCode) { throw 'Pool unavailable' }
                $state = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                if ($null -eq $state.accounts) { throw 'Invalid pool response' }
                $script:running = $true
                $script:statusItem.Text = 'Pool running - ' + @($state.accounts).Count + ' accounts'
                $script:icon.Text = 'Antigravity Account Pool - running'
                $script:icon.Icon = [Drawing.SystemIcons]::Information
                Write-TrayState 'running'
            } catch {
                $script:running = $false; $script:statusItem.Text = 'Pool stopped or unavailable'
                $script:icon.Text = 'Antigravity Account Pool - unavailable'
                $script:icon.Icon = [Drawing.SystemIcons]::Warning
                Write-TrayState 'unavailable'
            } finally { if ($response) { $response.Dispose() }; $script:task = $null }
        }
        if (-not $script:task -and (Get-Date) -ge $script:nextCheck) {
            $script:task = $script:client.GetAsync($script:url + 'api/status')
            $script:nextCheck = (Get-Date).AddSeconds(5)
        }
    } catch { Write-TrayState 'unavailable' }
})
try { Write-TrayState 'starting'; $timer.Start(); [Windows.Forms.Application]::Run($script:context) }
finally {
    $timer.Stop(); $timer.Dispose(); $script:icon.Visible = $false; $script:icon.Dispose(); $script:menu.Dispose()
    $script:client.Dispose(); $script:context.Dispose(); Write-TrayState 'closed'; $mutex.ReleaseMutex(); $mutex.Dispose()
}
