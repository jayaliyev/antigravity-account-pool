param(
    [Parameter(Mandatory)][string]$SettingsPath,
    [Parameter(Mandatory)][string]$BackupPath,
    [int]$DelaySeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
if (-not (Test-Path -LiteralPath $BackupPath)) { return }

$entropy = [Text.Encoding]::UTF8.GetBytes('agy-account-pool-settings-v1')
$encrypted = [IO.File]::ReadAllBytes($BackupPath)
$original = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($SettingsPath, $original)
Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue
