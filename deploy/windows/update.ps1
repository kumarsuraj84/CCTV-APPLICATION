<#
.SYNOPSIS
  CityKart Drishti: one-command update of a Windows installation, with a roll back on failure (P5.4).

.DESCRIPTION
  1. Preflight   administrator, one update at a time (a lock file), the configuration and scripts not changeable by others,
                 Node.js, the new source (a checkout or an unpacked release), free disk space.
  2. Build       copy the source to <InstallRoot>\app\releases\<build id>, npm ci, build with CK_BUILD_ID = <build id> (the open pages see
                 the new id at /api/version and show "A new version is available: refresh"), copy public\ and .next\static\ next to
                 the standalone server, write release.json (build id, migration level it needs).
  3. Back up     backup.ps1 -Tag pre-update-<build id> (database dump + manifest; the Vault root key is checked by hash).
  4. Stop        DrishtiWeb, DrishtiGateway, DrishtiWorker (in this order; go2rtc keeps running unless -RestartGo2rtc).
  5. Migrate     npx supabase migration up (forward migrations of the new release only; the password only in the child's environment).
  6. Switch      <InstallRoot>\app\current -> the new release (a directory junction; the old target is remembered).
  7. Start       DrishtiWorker, DrishtiGateway, DrishtiWeb.
  8. Check       /api/version = the new build id and /api/health = ok, within HealthTimeoutSec.
  9. Scripts     the new release's deploy\windows is copied to <InstallRoot>\scripts (the admin-only copy the nightly backup runs).
  On a failure in steps 4-8 (review I-1): EVERY Drishti service is stopped (go2rtc too); when the database level changed and
  -RollbackDatabase is Restore (the default), restore.ps1 backs the live database up again, restores the step 3 backup into a new
  database, proves it, and only then swaps it in (the old one is kept); then current is switched back and the old release started
  and checked. If the restore fails, NOTHING is started: the system is left STOPPED with a plain message (never the old release on
  the new schema). -RollbackDatabase None leaves the database as it is and says loudly that the old release runs on the new level.
  Steps 1-3 failing change nothing that runs. Services are called in this process (review C-1), with their names as an array.
  -DryRun / -WhatIf: the whole plan, nothing changed (the service script's own plan included). -SimulateFailure
  Migrate|Start|Health|Restore (with -DryRun): the roll back's plan.

.EXAMPLE
  .\update.ps1 -SourcePath C:\Drishti\incoming\drishti-1.0.1 -DryRun
  .\update.ps1 -SourcePath C:\Drishti\incoming\drishti-1.0.1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')][string]$BuildId,
  [ValidateSet('Restore', 'None')][string]$RollbackDatabase = 'Restore',
  [switch]$RestartGo2rtc,
  [switch]$SkipBuild,
  [ValidateSet('', 'Migrate', 'Start', 'Health', 'Restore')][string]$SimulateFailure = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)
if ($SimulateFailure -and -not $dry) { throw '-SimulateFailure is for a dry run only.' }

$config = Read-DrishtiConfig -Path $ConfigPath
$services = Join-Path $PSScriptRoot 'drishti-services.ps1'
$backup = Join-Path $PSScriptRoot 'backup.ps1'
$restore = Join-Path $PSScriptRoot 'restore.ps1'
$appRoot = Join-Path $config.InstallRoot 'app'
$releases = Join-Path $appRoot 'releases'
$current = Join-Path $appRoot 'current'
$timeout = if ($config.ContainsKey('HealthTimeoutSec')) { [int]$config.HealthTimeoutSec } else { 180 }
$appServices = @('DrishtiWeb', 'DrishtiGateway', 'DrishtiWorker')
if ($RestartGo2rtc) { $appServices += 'DrishtiGo2rtc' }
$appServices = @($appServices | Where-Object { @($config.Services) -contains $_ })
$everyService = @($config.Services)
$dbName = if ($config.Database.ContainsKey('Name')) { [string]$config.Database.Name } else { 'postgres' }

# ── 1. Preflight ──────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $SourcePath)) { throw "The new source $SourcePath does not exist." }
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
if (-not (Test-Path -LiteralPath (Join-Path $SourcePath 'package.json'))) { throw "$SourcePath is not a Drishti source (no package.json)." }
if (-not $dry -and -not (Test-DrishtiAdministrator)) { throw 'Run this from an elevated PowerShell (Administrator), or add -DryRun to see the plan.' }
$lock = $null
if (-not $dry) {
  Assert-DrishtiSafeToRun -Config $config -ConfigPath $ConfigPath -ScriptRoot $PSScriptRoot
  $lock = Enter-DrishtiLock -Config $config -What 'update' # review M-1: one update or live restore at a time
}
if (-not $BuildId) {
  $sha = ''
  try { $sha = (& git -C $SourcePath rev-parse --short=7 HEAD 2>$null) } catch { $sha = '' }
  if (-not $sha) { $sha = 'nogit' }
  $BuildId = "$((Get-Date).ToString('yyyyMMdd-HHmm'))-$sha"
}
$expected = Get-DrishtiExpectedMigration -SourcePath $SourcePath
$release = Join-Path $releases $BuildId
$previous = $null
if (Test-Path -LiteralPath $current) { $previous = (Get-Item -LiteralPath $current).Target | Select-Object -First 1 }
$drive = (Get-Item -LiteralPath $config.InstallRoot -ErrorAction SilentlyContinue)
Write-DrishtiStep -Message "update to build $BuildId (needs migration $expected) from $SourcePath$(if ($dry) { ' (dry run: nothing is changed)' })"
Write-DrishtiStep -Message "current release: $(if ($previous) { $previous } else { 'none (first installation)' })"
if (-not $dry -and $drive) {
  $free = (Get-PSDrive -Name $drive.PSDrive.Name).Free
  if ($free -lt 5GB) { throw "Less than 5 GB free on $($drive.PSDrive.Name): (a build and a backup need room)." }
}

# Review C-1: in this process, the names as a real array (powershell.exe -File cannot bind several values to one parameter).
function Invoke-DrishtiServices([string]$Action, [string[]]$Names) {
  & $services -Action $Action -ConfigPath $ConfigPath -Service $Names -DryRun:$dry
}

function Set-DrishtiCurrent([string]$Target) {
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would point $current to $Target"; return }
  if (Test-Path -LiteralPath $current) { (Get-Item -LiteralPath $current).Delete() } # removes the junction only, never its target
  New-Item -ItemType Junction -Path $current -Target $Target | Out-Null
  Write-DrishtiStep -Kind ok -Message "current -> $Target"
}

function Get-DrishtiDbLevel {
  if ($dry) { return '(read at run time)' }
  return (Invoke-DrishtiSql -Config $config -Database $dbName -Sql "SELECT coalesce(max(version), '') FROM supabase_migrations.schema_migrations;")[0]
}

<# Review I-2: the connection string carries no password; PGPASSWORD is set for the child only, and removed again. #>
function Get-DrishtiMigrationCommand {
  $mode = if ($config.ContainsKey('MigrationMode')) { $config.MigrationMode } else { 'Local' }
  if ($mode -eq 'Local') { return @{ Args = @('supabase', 'migration', 'up', '--local', '--workdir', $release); Password = $null; Shown = "npx supabase migration up --local --workdir $release" } }
  $db = $config.Database
  $user = if ($db.ContainsKey('MigrateUser') -and $db.MigrateUser) { [string]$db.MigrateUser } else { [string]$db.User }
  $url = "postgresql://$([uri]::EscapeDataString($user))@$($db.Host):$($db.Port)/$($db.Name)"
  return @{ Args = @('supabase', 'migration', 'up', '--workdir', $release, '--db-url', $url); Password = [string]$db.PasswordEnv; Shown = "npx supabase migration up --workdir $release --db-url $url (password from `$env:$($db.PasswordEnv), passed as PGPASSWORD to the child only)" }
}

function Invoke-DrishtiMigrations {
  $m = Get-DrishtiMigrationCommand
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would run: $($m.Shown)"; return }
  $had = Test-Path Env:PGPASSWORD
  if ($m.Password) {
    $pw = [Environment]::GetEnvironmentVariable($m.Password)
    if (-not $pw) { throw "Environment variable $($m.Password) (Database.PasswordEnv) is not set." }
    $env:PGPASSWORD = $pw
  }
  try { Invoke-DrishtiCommand -FilePath 'npx.cmd' -ArgumentList $m.Args -Display $m.Shown }
  finally { if ($m.Password -and -not $had) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } }
}

# ── 2. Build ──────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  if (-not $dry -and (Test-Path -LiteralPath $release)) { throw "$release exists already: choose another -BuildId." }
  # The release inherits the locked app folder's rules (robocopy does not copy security): administrators write, the services read.
  Invoke-DrishtiCommand -FilePath 'robocopy.exe' -ArgumentList @($SourcePath, $release, '/MIR', '/XD', '.git', 'node_modules', '.next', '.superpowers', '/XF', '.env', '.env.local', '.env.*.local', '/NFL', '/NDL', '/NJH', '/NJS') -DryRun:$dry -Display "robocopy $SourcePath -> $release (without .git, node_modules, .next, .env files)" -AllowExitCodes @(0, 1, 2, 3)
  # The public settings are built into the pages (HSTS, the gateway address, the Supabase address): the build reads the NEXT_PUBLIC_*
  # lines of web.env (only those; nothing is printed).
  $webEnv = Join-Path $config.ConfigDir 'web.env'
  $public = @{}
  if (Test-Path -LiteralPath $webEnv) {
    foreach ($l in Get-Content -LiteralPath $webEnv) { if ($l -match '^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=(.*)$') { $public[$Matches[1]] = $Matches[2].Trim().Trim('"') } }
  } elseif (-not $dry) { throw "$webEnv is missing: the build needs its NEXT_PUBLIC_* settings." }
  if ($dry) {
    Write-DrishtiStep -Kind plan -Message "would run: npm ci (in $release)"
    Write-DrishtiStep -Kind plan -Message "would build with CK_BUILD_ID=$BuildId and the $($public.Count) NEXT_PUBLIC_* settings of web.env (npm run build in $release)"
  } else {
    Push-Location -LiteralPath $release
    try {
      Invoke-DrishtiCommand -FilePath 'npm.cmd' -ArgumentList @('ci', '--no-audit', '--no-fund')
      $env:CK_BUILD_ID = $BuildId
      foreach ($k in $public.Keys) { Set-Item -Path "Env:$k" -Value $public[$k] }
      Invoke-DrishtiCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'build')
    } finally {
      Remove-Item Env:CK_BUILD_ID -ErrorAction SilentlyContinue
      foreach ($k in $public.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
      Pop-Location
    }
    $standalone = Join-Path $release '.next\standalone'
    Copy-Item -Recurse -Force -LiteralPath (Join-Path $release 'public') -Destination (Join-Path $standalone 'public')
    Copy-Item -Recurse -Force -LiteralPath (Join-Path $release '.next\static') -Destination (Join-Path $standalone '.next\static')
    $info = [ordered]@{ buildId = $BuildId; migration = $expected; source = $SourcePath; builtAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
    foreach ($p in @($release, $standalone)) { Set-Content -LiteralPath (Join-Path $p 'release.json') -Value $info -Encoding UTF8 }
  }
  if ($dry) { Write-DrishtiStep -Kind plan -Message 'would copy public\ and .next\static\ next to the standalone server and write release.json (build id, migration level)' }
}

# ── 3. Back up ────────────────────────────────────────────────────────────────
$backupResult = Join-Path $env:TEMP "drishti-backup-$BuildId.json"
$tag = 'pre-update-' + ($BuildId.ToLowerInvariant() -replace '[^a-z0-9-]', '-')
if ($tag.Length -gt 40) { $tag = $tag.Substring(0, 40) }
if ($dry) { Write-DrishtiStep -Kind plan -Message "would run: backup.ps1 -Tag $tag (database dump in one snapshot, manifest, Vault root key hash)" }
else {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backup -ConfigPath $ConfigPath -Tag $tag -ResultPath $backupResult
  if ($LASTEXITCODE -ne 0) { throw 'The backup failed: nothing was stopped or changed.' }
}
$backupFolder = if ($dry) { '<the backup just made>' } else { (Get-Content -LiteralPath $backupResult -Raw | ConvertFrom-Json).folder }
$levelBefore = Get-DrishtiDbLevel

function Write-DrishtiStopped([string]$Why) {
  Write-DrishtiStep -Kind fail -Message "THE SYSTEM IS STOPPED: $Why"
  Write-DrishtiStep -Kind fail -Message "Every Drishti service is stopped and stays stopped. The pre-update backup is $backupFolder; the database as it was before any restore attempt is kept (restore.ps1 never drops it)."
  Write-DrishtiStep -Kind fail -Message 'Next: docs/drishti/runbooks/update-rollback.md section 3 (by hand). Do not start the old release on the new database level.'
}

# ── 4-8. Stop, migrate, switch, start, check; roll back on failure ─────────────
$migrated = $false
$switched = $false
$exitCode = 0
try {
  Invoke-DrishtiServices -Action Stop -Names $appServices
  if ($SimulateFailure -eq 'Migrate') { throw 'simulated failure: the migrations' }
  Invoke-DrishtiMigrations
  $migrated = $dry -or ((Get-DrishtiDbLevel) -ne $levelBefore)
  Set-DrishtiCurrent -Target $release
  $switched = $true
  if ($SimulateFailure -eq 'Start' -or $SimulateFailure -eq 'Restore') { throw 'simulated failure: a service did not start' }
  Invoke-DrishtiServices -Action Start -Names $appServices
  if ($SimulateFailure -eq 'Health') { throw 'simulated failure: not healthy in time' }
  if (-not (Wait-DrishtiHealthy -Config $config -BuildId $BuildId -TimeoutSec $timeout -DryRun:$dry)) { throw 'The new release did not become healthy.' }
  Write-DrishtiStep -Kind ok -Message "updated to $BuildId"
  # The admin-only copy of the scripts the nightly backup runs comes from the release that now runs.
  Invoke-DrishtiCommand -FilePath 'robocopy.exe' -ArgumentList @((Join-Path $release 'deploy\windows'), (Join-Path $config.InstallRoot 'scripts'), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -DryRun:$dry -Display "robocopy $release\deploy\windows -> $(Join-Path $config.InstallRoot 'scripts')" -AllowExitCodes @(0, 1, 2, 3)
  # Keep the newest releases (KeepReleases), never the one running or the one before it.
  $keep = if ($config.ContainsKey('KeepReleases')) { [int]$config.KeepReleases } else { 3 }
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would keep the newest $keep releases under $releases and remove older ones" }
  else {
    $old = @(Get-ChildItem -LiteralPath $releases -Directory | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Sort-Object CreationTime -Descending | Select-Object -Skip $keep | Where-Object { $_.FullName -ne $release -and $_.FullName -ne $previous })
    foreach ($o in $old) { if ($PSCmdlet.ShouldProcess($o.FullName, 'remove old release')) { & cmd.exe /d /c "rmdir /s /q `"$($o.FullName)`"" | Out-Host } }
  }
} catch {
  Write-DrishtiStep -Kind fail -Message "update failed: $($_.Exception.Message). Rolling back."
  $exitCode = 1
  try {
    # Review I-1: everything stops, go2rtc included (restore.ps1 refuses while any Drishti service runs).
    Invoke-DrishtiServices -Action Stop -Names $everyService
    # A migration run that failed half way may still have applied its first files: compare the level with the one before.
    if (-not $migrated -and -not $dry) { try { $migrated = (Get-DrishtiDbLevel) -ne $levelBefore } catch { $migrated = $true } }
    $databaseOk = $true
    if ($migrated -and $RollbackDatabase -eq 'Restore') {
      if ($dry) {
        Write-DrishtiStep -Kind plan -Message "would run: restore.ps1 -BackupPath $backupFolder -TargetDatabase $dbName -AllowLiveDatabase -PreRestoreBackup (a backup of the database as it is now first; the restored copy proven, then swapped in; the current one kept)"
        if ($SimulateFailure -eq 'Restore') { throw 'simulated failure: the database restore' }
      } else {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restore -ConfigPath $ConfigPath -BackupPath $backupFolder -TargetDatabase $dbName -AllowLiveDatabase -PreRestoreBackup -UnderUpdateLock -SourcePath $(if ($previous) { $previous } else { $SourcePath })
        if ($LASTEXITCODE -ne 0) { throw "the database restore failed (restore.ps1 exit code $LASTEXITCODE; its lines above say what was and was not changed)" }
      }
    } elseif ($migrated) {
      Write-DrishtiStep -Kind warn -Message 'WARNING: migrations were applied and -RollbackDatabase None: the OLD release is started on the NEW database level (only safe when the new migrations are additive; check the Health page "Database version")'
    }
    if ($databaseOk -and $switched) {
      if ($previous) { Set-DrishtiCurrent -Target $previous } elseif ($dry) { Set-DrishtiCurrent -Target '<the previous release>' } else { throw 'there is no earlier release to go back to (first installation)' }
    }
    if ($previous -or $dry) {
      Invoke-DrishtiServices -Action Start -Names $everyService
      $oldId = if ($dry) { '<the previous build>' } else { (Get-Content -LiteralPath (Join-Path $previous 'release.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json).buildId }
      if (Wait-DrishtiHealthy -Config $config -BuildId $oldId -TimeoutSec $timeout -DryRun:$dry) { Write-DrishtiStep -Kind ok -Message "rolled back to $oldId" }
      else { Write-DrishtiStep -Kind fail -Message "the old release $oldId started but is not healthy: see the Health page and docs/drishti/runbooks/incidents.md" }
    }
  } catch {
    try { Invoke-DrishtiServices -Action Stop -Names $everyService } catch { }
    Write-DrishtiStopped -Why $_.Exception.Message
    $exitCode = 2
  }
  if ($dry -and $SimulateFailure) { Write-DrishtiStep -Kind plan -Message 'end of the simulated roll back'; $exitCode = 0 }
} finally {
  if ($lock) { $lock.Dispose() }
}
exit $exitCode
