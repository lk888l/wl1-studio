# The only elevated child is Windows PowerShell, with the compiled-in setup
# script passed in memory. $elevatedCommand is a UTF-16LE Base64 string.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
try {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $child = Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $elevatedCommand)
    exit $child.ExitCode
} catch {
    $reason = $_.Exception
    while ($null -ne $reason) {
        if ($reason -is [System.ComponentModel.Win32Exception] -and $reason.NativeErrorCode -eq 1223) { exit 125 }
        $reason = $reason.InnerException
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
