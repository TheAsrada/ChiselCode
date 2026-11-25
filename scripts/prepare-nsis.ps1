$ErrorActionPreference = 'Stop'

if (Get-Command makensis.exe -CommandType Application -ErrorAction SilentlyContinue) {
    return
}

$installDir = Join-Path ${env:ProgramFiles(x86)} 'NSIS'
$compiler = Join-Path $installDir 'makensis.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $stage = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ([guid]::NewGuid()))
    try {
        # The versioned package contains the upstream installer without feed lookups.
        $archive = Join-Path $stage.FullName 'nsis.zip'
        Invoke-WebRequest -Uri 'https://packages.chocolatey.org/nsis.install.3.13.0.nupkg' `
            -OutFile $archive -MaximumRetryCount 2 -RetryIntervalSec 3 -TimeoutSec 30
        Expand-Archive -LiteralPath $archive -DestinationPath $stage.FullName
        $installer = Join-Path $stage.FullName 'tools/nsis-3.13-setup.exe'
        $expectedHash = 'DB9A1038BBC0E53FEF24F423FD609979BD578E942F1BE1198DB186D1C42652A3'
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedHash) {
            throw 'NSIS installer SHA-256 mismatch'
        }
        $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) {
            throw "NSIS installer exited with code $($process.ExitCode)"
        }
    } finally {
        Remove-Item -LiteralPath $stage.FullName -Recurse -Force
    }
}

& $compiler /VERSION
if ($LASTEXITCODE -ne 0) {
    throw 'NSIS compiler failed to start'
}
Add-Content -LiteralPath $env:GITHUB_PATH -Value $installDir
