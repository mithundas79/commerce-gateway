$ErrorActionPreference = 'Stop'

# Run this script in a separate Windows PowerShell process. The wrapper's exit
# terminates this process after this fake Node command validates the handoff.
function global:node {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Values)
    $scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'release\windows-lab.mjs'
    if ($Values.Count -ne 1 -or $Values[0] -cne $scriptPath) { throw 'Unexpected Node entry point' }
    $actual = ConvertFrom-Json -InputObject $env:CG_LAB_OPTIONS_JSON
    $expected = @(
        '--settings', 'C:\private settings\shopify.env',
        '--origin', 'https://gateway.example.com',
        '--shop', 'disposable.myshopify.com',
        '--bash', 'C:\Program Files\Git\bin\bash.exe',
        '--mutate', '--ack', 'disposable.myshopify.com',
        '--product', 'gid://shopify/Product/123',
        '--title', 'Exact disposable "quoted" product title',
        '--resume'
    )
    if ($actual.Count -ne $expected.Count) { throw 'Unexpected wrapper argument count' }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($actual[$index] -cne $expected[$index]) { throw "Wrapper argument mismatch at position $index" }
    }
    Write-Output 'WINDOWS_LAB_WRAPPER_ARGUMENTS_PASSED'
    $global:LASTEXITCODE = 0
}

& (Join-Path (Split-Path $PSScriptRoot -Parent) 'release\windows-lab.ps1') `
    -ShopifyEnvPath 'C:\private settings\shopify.env' `
    -PublicOrigin 'https://gateway.example.com' `
    -Shop 'disposable.myshopify.com' `
    -GitBashPath 'C:\Program Files\Git\bin\bash.exe' `
    -AllowMutation -DisposableStoreAck 'disposable.myshopify.com' `
    -ProductGid 'gid://shopify/Product/123' `
    -OriginalTitle 'Exact disposable "quoted" product title' -Resume
