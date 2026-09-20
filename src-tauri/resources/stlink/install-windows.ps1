# Executed from a compiled-in EncodedCommand after UAC consent, never from a
# user-writable .ps1. $archive and $expectedHash are supplied by the Rust backend.
$ErrorActionPreference = 'Stop'
# Do not auto-load user-installed PowerShell modules in the elevated process.
$env:PSModulePath = "$PSHOME\Modules"
$stage = $null
$result = 1
try {
    # Extract and install only from a new admin/SYSTEM-only directory. Hash the
    # copied ZIP before extraction to close the unprivileged temp-file race.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.SetOwner($admins)
    foreach ($sid in @($admins, $system)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    $directory = New-Object System.IO.DirectoryInfo((Join-Path $env:SystemRoot ('Temp\wl1-stlink-' + [guid]::NewGuid().ToString('N'))))
    $directory.Create($acl)
    $stage = $directory.FullName
    $copy = Join-Path $stage 'stsw-link009.zip'
    Copy-Item -LiteralPath $archive -Destination $copy
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'The bundled ST-Link driver archive failed its integrity check.'
    }
    $expanded = Join-Path $stage 'driver'
    Expand-Archive -LiteralPath $copy -DestinationPath $expanded
    $catalog = Join-Path $expanded 'stlinkdbgwinusb_x64.cat'
    if ((Get-AuthenticodeSignature -LiteralPath $catalog).Status -ne 'Valid') {
        throw 'Windows could not validate the original ST-Link driver signature.'
    }
    # No wildcard, driver removal, force-binding, automatic reboot, DPInst,
    # downloaded executable, VCP INF or bridge INF is used here.
    & (Join-Path $env:SystemRoot 'System32\pnputil.exe') /add-driver (Join-Path $expanded 'stlink_dbg_winusb.inf') /install
    $result = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $result = 1
} finally {
    if ($null -ne $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
exit $result
