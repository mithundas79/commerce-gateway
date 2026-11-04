[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ShopifyEnvPath,
    [Parameter(Mandatory)][string]$PublicOrigin,
    [Parameter(Mandatory)][string]$Shop,
    [switch]$AllowMutation,
    [string]$DisposableStoreAck,
    [string]$ProductGid,
    [string]$OriginalTitle,
    [switch]$Resume,
    [switch]$NewRun,
    [string]$GitBashPath = "$env:ProgramFiles\Git\bin\bash.exe"
)
$ErrorActionPreference = 'Stop'
$arguments = @(
    '--settings', $ShopifyEnvPath, '--origin', $PublicOrigin, '--shop', $Shop,
    '--bash', $GitBashPath
)
if ($AllowMutation) {
    $arguments += @('--mutate', '--ack', $DisposableStoreAck, '--product', $ProductGid, '--title', $OriginalTitle)
}
if ($Resume) { $arguments += '--resume' }
if ($NewRun) { $arguments += '--new-run' }
# Windows PowerShell 5.1 native argument quoting can remove literal title quotes.
# JSON in the child environment preserves every character without shell parsing.
$previousArguments = $env:CG_LAB_OPTIONS_JSON
try {
    $env:CG_LAB_OPTIONS_JSON = ConvertTo-Json -InputObject $arguments -Compress
    & node (Join-Path $PSScriptRoot 'windows-lab.mjs')
    $result = $LASTEXITCODE
} finally {
    $env:CG_LAB_OPTIONS_JSON = $previousArguments
}
exit $result
