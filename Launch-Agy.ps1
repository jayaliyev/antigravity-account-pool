param(
    [Parameter(Mandatory)][ValidateSet('Login','Project')][string]$Mode,
    [string]$ProjectPath,
    [int]$Port = 18454,
    [switch]$ContinueConversation
)

$ErrorActionPreference = 'Stop'
$settingsPath = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\settings.json'
$agyPath = (Get-Command agy -ErrorAction Stop).Source
$original = [IO.File]::ReadAllBytes($settingsPath)
$settings = [Text.Encoding]::UTF8.GetString($original) | ConvertFrom-Json
$backupPath = $null
$priorUrl = [Environment]::GetEnvironmentVariable('CLOUD_CODE_URL', 'Process')

try {
    if ($settings.modelProvider -eq 'gemini') {
        $backupPath = Join-Path $PSScriptRoot ('data\settings-backup-' + [guid]::NewGuid().ToString('N') + '.dpapi')
        $entropy = [Text.Encoding]::UTF8.GetBytes('agy-account-pool-settings-v1')
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $original, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($backupPath, $encrypted)
        [void]$settings.PSObject.Properties.Remove('modelProvider')
        [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
        $restoreScript = Join-Path $PSScriptRoot 'Restore-AgySettings.ps1'
        $pwshPath = Join-Path $PSHOME 'pwsh.exe'
        $restoreArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            ('"' + $restoreScript + '"'), '-SettingsPath', ('"' + $settingsPath + '"'),
            '-BackupPath', ('"' + $backupPath + '"'), '-DelaySeconds', '30')
        Start-Process -FilePath $pwshPath -ArgumentList $restoreArgs -WindowStyle Hidden | Out-Null
    }

    if ($Mode -eq 'Project') {
        if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
            throw "Project directory does not exist: $ProjectPath"
        }
        [Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', "http://127.0.0.1:$Port", 'Process')
        Push-Location $ProjectPath
        try {
            if ($ContinueConversation) { & $agyPath -c --dangerously-skip-permissions }
            else { & $agyPath --dangerously-skip-permissions }
        } finally { Pop-Location }
    } else {
        $loginPath = Join-Path $PSScriptRoot 'data\login-project'
        New-Item -ItemType Directory -Path $loginPath -Force | Out-Null
        Push-Location $loginPath
        try { & $agyPath }
        finally { Pop-Location }
    }
} finally {
    [Environment]::SetEnvironmentVariable('CLOUD_CODE_URL', $priorUrl, 'Process')
    if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
        [IO.File]::WriteAllBytes($settingsPath, $original)
        Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    }
}
