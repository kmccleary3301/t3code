$ErrorActionPreference = "Stop"

function Fail([string] $Message) {
  throw "release lifecycle: $Message"
}

$repository = $env:T3_LIFECYCLE_REPOSITORY
$currentTag = $env:T3_LIFECYCLE_RELEASE_TAG
$previousTag = $env:T3_LIFECYCLE_PREVIOUS_TAG
$nativeRoot = $env:T3_LIFECYCLE_NATIVE_ROOT
$reportPath = $env:T3_LIFECYCLE_REPORT
if ([string]::IsNullOrWhiteSpace($repository)) { Fail "T3_LIFECYCLE_REPOSITORY is required" }
if ([string]::IsNullOrWhiteSpace($currentTag)) { Fail "T3_LIFECYCLE_RELEASE_TAG is required" }
if ([string]::IsNullOrWhiteSpace($previousTag)) { Fail "T3_LIFECYCLE_PREVIOUS_TAG is required" }
if ([string]::IsNullOrWhiteSpace($nativeRoot)) { Fail "T3_LIFECYCLE_NATIVE_ROOT is required" }
if ([string]::IsNullOrWhiteSpace($reportPath)) { Fail "T3_LIFECYCLE_REPORT is required" }

function Get-Version([string] $Tag) {
  if ($Tag -notmatch '^fork-v([0-9]+\.[0-9]+\.[0-9]+)$') { Fail "tag must be fork-vX.Y.Z: $Tag" }
  return $Matches[1]
}

$currentVersion = Get-Version $currentTag
$previousVersion = Get-Version $previousTag
$root = Join-Path $env:RUNNER_TEMP "t3-pi-omp-release-lifecycle-windows"
if (Test-Path $root) { Remove-Item -Recurse -Force $root }
New-Item -ItemType Directory -Force -Path $root | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportPath) | Out-Null

function Get-Sha256([string] $Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-Checksum([string] $SumsPath, [string] $Name) {
  foreach ($line in Get-Content -LiteralPath $SumsPath) {
    $parts = $line -split '\s+'
    if ($parts.Count -lt 2) { continue }
    $candidate = [System.IO.Path]::GetFileName($parts[1].TrimStart('*').Replace('/', '\'))
    if ($candidate -eq $Name) { return $parts[0].ToLowerInvariant() }
  }
  Fail "SHA256SUMS has no entry for $Name"
}

function Verify-File([string] $Path, [string] $SumsPath, [string] $Name) {
  $expected = Get-Checksum $SumsPath $Name
  $actual = Get-Sha256 $Path
  if ($expected -ne $actual) { Fail "checksum mismatch for $Name" }
  return $actual
}

function Download-Release([string] $Tag, [string] $Version) {
  $destination = Join-Path $root "releases\$Tag"
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $base = "https://github.com/$repository/releases/download/$Tag"
  $installPath = Join-Path $destination "install.sh"
  $manifestPath = Join-Path $destination "RELEASE-MANIFEST.json"
  $sumsPath = Join-Path $destination "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/install.sh" -OutFile $installPath
  Invoke-WebRequest -UseBasicParsing -Uri "$base/RELEASE-MANIFEST.json" -OutFile $manifestPath
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sumsPath
  $installerSha = Verify-File $installPath $sumsPath "install.sh"
  $manifestSha = Verify-File $manifestPath $sumsPath "RELEASE-MANIFEST.json"
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.profile -ne "pi-omp") { Fail "unexpected manifest profile $($manifest.profile)" }
  if ($manifest.clientVersion -ne $Version) { Fail "unexpected manifest version $($manifest.clientVersion)" }
  $cli = @($manifest.artifacts | Where-Object { $_.kind -eq "cli" }) | Select-Object -First 1
  $desktop = @($manifest.artifacts | Where-Object { $_.kind -eq "desktop" -and $_.path -match 'x64\.exe$' }) | Select-Object -First 1
  if ($null -eq $cli) { Fail "manifest has no CLI artifact" }
  if ($null -eq $desktop) { Fail "manifest has no Windows x64 desktop artifact" }
  $cliPath = Join-Path $destination $cli.path
  $desktopPath = Join-Path $destination $desktop.path
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$($cli.path)" -OutFile $cliPath
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$($desktop.path)" -OutFile $desktopPath
  $cliSha = Verify-File $cliPath $sumsPath ([System.IO.Path]::GetFileName($cli.path))
  $desktopSha = Verify-File $desktopPath $sumsPath ([System.IO.Path]::GetFileName($desktop.path))
  return [pscustomobject]@{
    tag = $Tag
    version = $Version
    directory = $destination
    manifest = $manifestPath
    installer = $installPath
    installerSha256 = $installerSha
    manifestSha256 = $manifestSha
    cliPath = $cliPath
    cliName = [System.IO.Path]::GetFileName($cli.path)
    cliSha256 = $cliSha
    desktopPath = $desktopPath
    desktopName = [System.IO.Path]::GetFileName($desktop.path)
    desktopSha256 = $desktopSha
  }
}

function Invoke-Checked([string] $FilePath, [string[]] $Arguments) {
  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "$FilePath $($Arguments -join ' ') failed: $($output -join "`n")" }
  return ($output -join "`n")
}


function Resolve-Cli([string] $Prefix) {
  $candidates = @(
    (Join-Path $Prefix "t3-pi-omp.cmd"),
    (Join-Path $Prefix "node_modules\.bin\t3-pi-omp.cmd")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  Fail "installed CLI was not found under $Prefix"
}

function Assert-Cli([string] $Cli, [string] $Version) {
  $versionOutput = Invoke-Checked $Cli @("--version")
  if ($versionOutput -notlike "*$Version*") { Fail "expected CLI version $Version, got $versionOutput" }
  $helpOutput = Invoke-Checked $Cli @("--help")
  if ($helpOutput -notlike "*Run the T3 Code server*") { Fail "help output did not describe the server command" }
}

function Get-TreeDigest([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'absent' }
  $lines = Get-ChildItem -Force -Recurse -LiteralPath $Path |
    Sort-Object FullName |
    ForEach-Object {
      $relative = [System.IO.Path]::GetRelativePath($Path, $_.FullName)
      if ($_.PSIsContainer) {
        "D`t$relative"
      } else {
        "F`t$relative`t$($_.Length)`t$(Get-Sha256 $_.FullName)"
      }
    }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
  return [System.Convert]::ToHexString($hash).ToLowerInvariant()
}

function Install-CliArchiveChecked(
  [string] $Archive,
  [string] $SumsPath,
  [string] $ExpectedName,
  [string] $Prefix
) {
  Verify-File $Archive $SumsPath $ExpectedName | Out-Null
  Invoke-Checked 'npm.cmd' @(
    'install', '--global', '--prefix', $Prefix, '--ignore-scripts',
    '--no-audit', '--no-fund', $Archive
  ) | Out-Null
}

function Assert-CliPrefixUnchanged(
  [string] $Prefix,
  [string] $ExpectedDigest,
  [string] $ExpectedVersion
) {
  $actualDigest = Get-TreeDigest $Prefix
  if ($actualDigest -ne $ExpectedDigest) {
    Fail "failed install changed the CLI prefix: expected $ExpectedDigest, got $actualDigest"
  }
  Assert-Cli (Resolve-Cli $Prefix) $ExpectedVersion
}

function Install-Nsis([string] $Installer, [string] $Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$Destination") -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "NSIS installer failed with $($process.ExitCode)" }
  $application = Get-ChildItem -LiteralPath $Destination -Filter '*.exe' -Recurse -File |
    Where-Object { $_.Name -notmatch 'unins|Uninstall|Setup' } |
    Select-Object -First 1
  if ($null -eq $application) { Fail "NSIS installer produced no application executable" }
  return [pscustomobject]@{ path = $application.FullName; version = $application.VersionInfo.ProductVersion }
}
function Stop-ServerTree([System.Diagnostics.Process] $Process) {
  if ($null -eq $Process) { return }
  if (-not $Process.HasExited) {
    try { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null } catch { }
    try { $Process.WaitForExit(10000) } catch { }
  }
}


$serverProcess = $null
$nativeRootCreated = $false
try {
  if (Test-Path -LiteralPath $nativeRoot) {
    Fail 'T3_LIFECYCLE_NATIVE_ROOT must identify a non-existing disposable directory'
  }
  New-Item -ItemType Directory -Force -Path $nativeRoot | Out-Null
  $nativeRootCreated = $true
  $previous = Download-Release $previousTag $previousVersion
  $current = Download-Release $currentTag $currentVersion

  $piState = Join-Path $nativeRoot '.pi\agent\config.json'
  $ompState = Join-Path $nativeRoot '.omp\agent\agent.db'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $piState), (Split-Path -Parent $ompState) | Out-Null
  Set-Content -NoNewline -LiteralPath $piState -Value 'lifecycle-preservation-pi'
  Set-Content -NoNewline -LiteralPath $ompState -Value 'lifecycle-preservation-omp'
  $piBefore = Get-Sha256 $piState
  $ompBefore = Get-Sha256 $ompState


  $officialVersion = '0.0.33'
  $officialArtifact = "T3-Code-$officialVersion-x64.exe"
  $officialExpectedSha = 'c472d849aaebec7d9ea625973c0f8106c4d31cc5b7affe7be605673666da5453'
  $officialInstaller = Join-Path $root $officialArtifact
  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://github.com/pingdotgg/t3code/releases/download/v$officialVersion/$officialArtifact" `
    -OutFile $officialInstaller
  if ((Get-Sha256 $officialInstaller) -ne $officialExpectedSha) {
    Fail 'official T3 installer checksum mismatch'
  }
  $officialPrefix = Join-Path $root 'official-t3'
  $officialInstallation = Install-Nsis $officialInstaller $officialPrefix
  if ($officialInstallation.version -notlike "*$officialVersion*") {
    Fail "official T3 install did not expose $officialVersion (got $($officialInstallation.version))"
  }
  $officialBefore = Get-TreeDigest $officialPrefix

  $preexistingBin = Join-Path $root 'preexisting-command'
  New-Item -ItemType Directory -Force -Path $preexistingBin | Out-Null
  $preexistingCli = Join-Path $preexistingBin 't3.cmd'
  Set-Content -LiteralPath $preexistingCli -Value "@echo off`r`necho preexisting-t3-command"
  $preexistingBefore = Get-Sha256 $preexistingCli

  $cliPrefix = Join-Path $root 'cli'
  New-Item -ItemType Directory -Force -Path $cliPrefix | Out-Null
  Install-CliArchiveChecked $previous.cliPath (Join-Path $previous.directory 'SHA256SUMS') $previous.cliName $cliPrefix
  $cli = Resolve-Cli $cliPrefix
  Assert-Cli $cli $previousVersion
  $previousPrefixDigest = Get-TreeDigest $cliPrefix

  $tamperedCli = Join-Path $root 'tampered-cli.tgz'
  Copy-Item -LiteralPath $current.cliPath -Destination $tamperedCli
  Add-Content -NoNewline -LiteralPath $tamperedCli -Value 'tampered'
  $tamperedRejected = $false
  try {
    Install-CliArchiveChecked $tamperedCli (Join-Path $current.directory 'SHA256SUMS') $current.cliName $cliPrefix
  } catch {
    $tamperedRejected = $true
  }
  if (-not $tamperedRejected) { Fail 'tampered CLI install unexpectedly succeeded' }
  Assert-CliPrefixUnchanged $cliPrefix $previousPrefixDigest $previousVersion

  $partialCli = Join-Path $root 'partial-cli.tgz'
  $currentCliBytes = [System.IO.File]::ReadAllBytes($current.cliPath)
  [System.IO.File]::WriteAllBytes(
    $partialCli,
    $currentCliBytes[0..([Math]::Min(1023, $currentCliBytes.Length - 1))]
  )
  $partialRejected = $false
  try {
    Install-CliArchiveChecked $partialCli (Join-Path $current.directory 'SHA256SUMS') $current.cliName $cliPrefix
  } catch {
    $partialRejected = $true
  }
  if (-not $partialRejected) { Fail 'partial CLI install unexpectedly succeeded' }
  Assert-CliPrefixUnchanged $cliPrefix $previousPrefixDigest $previousVersion

  $missingRejected = $false
  try {
    Install-CliArchiveChecked (Join-Path $root 'missing-cli.tgz') `
      (Join-Path $current.directory 'SHA256SUMS') $current.cliName $cliPrefix
  } catch {
    $missingRejected = $true
  }
  if (-not $missingRejected) { Fail 'missing CLI install unexpectedly succeeded' }
  Assert-CliPrefixUnchanged $cliPrefix $previousPrefixDigest $previousVersion

  Install-CliArchiveChecked $current.cliPath (Join-Path $current.directory 'SHA256SUMS') $current.cliName $cliPrefix
  $cli = Resolve-Cli $cliPrefix
  Assert-Cli $cli $currentVersion

  $missingNodePath = Join-Path $root 'missing-node-path'
  New-Item -ItemType Directory -Force -Path $missingNodePath | Out-Null
  $savedPath = $env:PATH
  $missingNodeExit = 0
  try {
    $env:PATH = $missingNodePath
    & $cli --version *> $null
    $missingNodeExit = $LASTEXITCODE
  } finally {
    $env:PATH = $savedPath
  }
  if ($missingNodeExit -eq 0) { Fail 'CLI unexpectedly launched without Node on PATH' }

  $port = Get-Random -Minimum 38773 -Maximum 39773
  $serverBase = Join-Path $root 'server-home'
  $serverStdout = Join-Path $root 'server.stdout.log'
  $serverStderr = Join-Path $root 'server.stderr.log'
  $serverProcess = Start-Process -FilePath $cli -ArgumentList @('serve', '--port', $port, '--base-dir', $serverBase, '--no-browser') -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr -PassThru
  $descriptorPath = Join-Path $root 'environment.json'
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/.well-known/t3/environment"
      if ($response.StatusCode -eq 200) {
        Set-Content -NoNewline -LiteralPath $descriptorPath -Value $response.Content
        $descriptor = $response.Content | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($descriptor.environmentId)) { Fail 'environment descriptor has no environmentId' }
        $ready = $true
        break
      }
    } catch { }
    if ($serverProcess.HasExited) {
      Get-Content -LiteralPath $serverStdout, $serverStderr -ErrorAction SilentlyContinue | Write-Error
      Fail 'server exited before readiness'
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { Get-Content -LiteralPath $serverStdout, $serverStderr -ErrorAction SilentlyContinue | Write-Error; Fail 'server readiness timed out' }
  Stop-ServerTree $serverProcess
  $serverProcess = $null
  if (-not [string]::IsNullOrWhiteSpace($env:T3_LIFECYCLE_INSTALLED_NATIVE_REPORT)) {
    if ([string]::IsNullOrWhiteSpace($env:T3_LIFECYCLE_INSTALLED_NATIVE_TEST_REPORT)) {
      Fail 'T3_LIFECYCLE_INSTALLED_NATIVE_TEST_REPORT is required'
    }
    $env:T3_INSTALLED_CLI = $cli
    $env:T3_INSTALLED_NATIVE_REPORT = $env:T3_LIFECYCLE_INSTALLED_NATIVE_REPORT
    & 'vp' test run apps/server/integration/installedArtifactNative.integration.test.ts `
      --reporter=json `
      "--outputFile=$env:T3_LIFECYCLE_INSTALLED_NATIVE_TEST_REPORT"
    if ($LASTEXITCODE -ne 0) { Fail 'installed artifact native smoke failed' }
  }

  $desktopRoot = Join-Path $root 'desktop'
  $previousDesktop = Install-Nsis $previous.desktopPath $desktopRoot
  $currentDesktop = Install-Nsis $current.desktopPath $desktopRoot
  if ($currentDesktop.version -notlike "*$currentVersion*") { Fail "desktop update did not expose $currentVersion (got $($currentDesktop.version))" }
  $rolledBackDesktop = Install-Nsis $previous.desktopPath $desktopRoot
  if ($rolledBackDesktop.version -notlike "*$previousVersion*") { Fail "desktop rollback did not expose $previousVersion (got $($rolledBackDesktop.version))" }
  $uninstaller = Get-ChildItem -LiteralPath $desktopRoot -Filter '*uninstall*.exe' -Recurse -File | Select-Object -First 1
  if ($null -eq $uninstaller) { Fail 'desktop uninstaller was not installed' }
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S') -Wait -PassThru
  if ($uninstallProcess.ExitCode -ne 0) { Fail "desktop uninstaller failed with $($uninstallProcess.ExitCode)" }
  Start-Sleep -Seconds 2
  $remainingApp = Get-ChildItem -LiteralPath $desktopRoot -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch 'unins|Uninstall|Setup' } | Select-Object -First 1
  if ($null -ne $remainingApp) { Fail "desktop uninstall left $($remainingApp.FullName)" }

  $cliUninstall = Invoke-Checked 'npm.cmd' @('uninstall', '--global', '--prefix', $cliPrefix, 't3-pi-omp')
  if ((Test-Path (Join-Path $cliPrefix 't3-pi-omp.cmd')) -or (Test-Path (Join-Path $cliPrefix 'node_modules\.bin\t3-pi-omp.cmd'))) {
    Fail 'CLI uninstall left an executable'
  }

  if ((Get-Sha256 $piState) -ne $piBefore) { Fail 'Pi native state changed' }
  if ((Get-Sha256 $ompState) -ne $ompBefore) { Fail 'OMP native state changed' }
  if ((Get-TreeDigest $officialPrefix) -ne $officialBefore) { Fail 'side-by-side official T3 installation changed' }
  if ((Get-Sha256 $preexistingCli) -ne $preexistingBefore) { Fail 'pre-existing t3 command changed' }

  $report = [ordered]@{
    schemaVersion = 1
    profile = 'pi-omp'
    platform = 'windows'
    architecture = $env:PROCESSOR_ARCHITECTURE
    currentTag = $currentTag
    previousTag = $previousTag
    checks = @(
      'fresh-cli-install', 'private-version-upgrade', 'version-help', 'server-health',
      'tampered-checksum-no-mutation', 'partial-download-no-mutation',
      'missing-asset-no-mutation', 'missing-node-runtime',
      'side-by-side-official-t3-installation', 'preexisting-t3-command-preservation',
      'fresh-desktop-install', 'desktop-upgrade',
      'desktop-rollback', 'desktop-uninstall', 'cli-uninstall',
      'native-config-preservation'
    )
    releases = @($previous, $current) | ForEach-Object {
      [ordered]@{ tag = $_.tag; installerSha256 = $_.installerSha256; manifestSha256 = $_.manifestSha256; cliSha256 = $_.cliSha256; desktopSha256 = $_.desktopSha256 }
    }
    officialT3 = [ordered]@{
      version = $officialVersion
      artifact = $officialArtifact
      sha256 = $officialExpectedSha
      installationDigest = $officialBefore
    }
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath
  Write-Output "Windows release lifecycle passed for $currentTag/$previousTag"
} finally {
  if ($null -ne $serverProcess) { Stop-ServerTree $serverProcess }
  if ($nativeRootCreated -and (Test-Path -LiteralPath $nativeRoot)) {
    Remove-Item -Recurse -Force -LiteralPath $nativeRoot
  }
  if (Test-Path $root) {
    for ($attempt = 0; $attempt -lt 20 -and (Test-Path $root); $attempt++) {
      try {
        Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction Stop
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
    if (Test-Path $root) { Remove-Item -Recurse -Force -LiteralPath $root -ErrorAction Stop }
  }
}
