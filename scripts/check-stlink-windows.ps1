# Windows CI verification only: no elevation, PnPUtil or driver installation.
$ErrorActionPreference = 'Stop'
$resources = Join-Path $PSScriptRoot '..\src-tauri\resources\stlink'
foreach ($name in @('install-windows.ps1', 'elevate-windows.ps1')) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $resources $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
}
$archive = Join-Path $resources 'stsw-link009.zip'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne 'DF015C7760F974E9DA0F4C5A098D62C72157EA45CD0E80694EB47AB7EF28352B') {
    throw 'Bundled ST driver archive SHA-256 mismatch.'
}
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('wl1-stlink-check-' + [guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $temp
    $catalog = Join-Path $temp 'stlinkdbgwinusb_x64.cat'
    $signature = Get-AuthenticodeSignature -LiteralPath $catalog
    if ($signature.Status -ne 'Valid') { throw "ST driver signature verification failed: $($signature.StatusMessage)" }
    if (!(Test-Path -LiteralPath (Join-Path $temp 'stlink_dbg_winusb.inf'))) { throw 'Debug INF missing.' }
    Write-Output "ST-Link scripts parsed; original archive and signature verified. Signer: $($signature.SignerCertificate.Subject)"
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
