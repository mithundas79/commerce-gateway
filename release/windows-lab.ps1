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
    (Join-Path $PSScriptRoot 'windows-lab.mjs'),
    '--settings', $ShopifyEnvPath, '--origin', $PublicOrigin, '--shop', $Shop,
    '--bash', $GitBashPath
)
if ($AllowMutation) {
    $arguments += @('--mutate', '--ack', $DisposableStoreAck, '--product', $ProductGid, '--title', $OriginalTitle)
}
if ($Resume) { $arguments += '--resume' }
if ($NewRun) { $arguments += '--new-run' }
& node @arguments
exit $LASTEXITCODE
