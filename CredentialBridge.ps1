param(
    [Parameter(Mandatory)][ValidateSet('read','write','copy','delete','exists')][string]$Action,
    [Parameter(Mandatory)][string]$Target,
    [string]$Source
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AgyCredential.ps1')

function Assert-Target([string]$Value) {
    if ($Value -ne 'gemini:antigravity' -and $Value -notmatch '^agy-pool:([0-9a-f-]{36}|recovery)$') {
        throw 'Unsupported credential target.'
    }
}

Assert-Target $Target
if ($Source) { Assert-Target $Source }

switch ($Action) {
    'read' {
        $item = [AgyCredentialInterop]::Read($Target)
        @{ UserName = $item.UserName; Blob = [Convert]::ToBase64String($item.Blob); Persist = $item.Persist } |
            ConvertTo-Json -Compress
    }
    'write' {
        $inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
        if (-not $inputJson.Blob) { throw 'Missing credential blob.' }
        $item = [AgyCredentialInterop+Snapshot]::new()
        $item.UserName = [string]$inputJson.UserName
        $item.Blob = [Convert]::FromBase64String([string]$inputJson.Blob)
        $item.Persist = [uint32]$inputJson.Persist
        [AgyCredentialInterop]::Write($Target, $item)
        'OK'
    }
    'copy' {
        if (-not $Source) { throw 'Missing source credential.' }
        [AgyCredentialInterop]::Write($Target, [AgyCredentialInterop]::Read($Source))
        'OK'
    }
    'delete' {
        [AgyCredentialInterop]::Delete($Target)
        'OK'
    }
    'exists' {
        try { [void][AgyCredentialInterop]::Read($Target); 'true' }
        catch { 'false' }
    }
}
