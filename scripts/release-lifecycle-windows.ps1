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

$serverProcess = $null
try {
  $previous = Download-Release $previousTag $previousVersion
  $current = Download-Release $currentTag $currentVersion

  $piState = Join-Path $nativeRoot '.pi\agent\config.json'
  $ompState = Join-Path $nativeRoot '.omp\agent\agent.db'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $piState), (Split-Path -Parent $ompState) | Out-Null
  Set-Content -NoNewline -LiteralPath $piState -Value 'lifecycle-preservation-pi'
  Set-Content -NoNewline -LiteralPath $ompState -Value 'lifecycle-preservation-omp'
  $piBefore = Get-Sha256 $piState
  $ompBefore = Get-Sha256 $ompState

  $cliPrefix = Join-Path $root 'cli'
  New-Item -ItemType Directory -Force -Path $cliPrefix | Out-Null
  Invoke-Checked 'npm.cmd' @('install', '--global', '--prefix', $cliPrefix, '--ignore-scripts', '--no-audit', '--no-fund', $current.cliPath) | Out-Null
  $cli = Resolve-Cli $cliPrefix
  Assert-Cli $cli $currentVersion

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
  if (-not $serverProcess.HasExited) { Stop-Process -Id $serverProcess.Id -Force }
  $serverProcess = $null

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

  $report = [ordered]@{
    schemaVersion = 1
    profile = 'pi-omp'
    platform = 'windows'
    architecture = $env:PROCESSOR_ARCHITECTURE
    currentTag = $currentTag
    previousTag = $previousTag
    checks = @('fresh-cli-install', 'version-help', 'server-health', 'fresh-desktop-install', 'desktop-upgrade', 'desktop-rollback', 'desktop-uninstall', 'cli-uninstall', 'native-config-preservation')
    releases = @($previous, $current) | ForEach-Object {
      [ordered]@{ tag = $_.tag; installerSha256 = $_.installerSha256; manifestSha256 = $_.manifestSha256; cliSha256 = $_.cliSha256; desktopSha256 = $_.desktopSha256 }
    }
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath
  Write-Output "Windows release lifecycle passed for $currentTag/$previousTag"
} finally {
  if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $root) { Remove-Item -Recurse -Force $root }
}
