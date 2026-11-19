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
  [ValidateSet('', 'Migrate', 'Start', 'Health', 'Restore', 'Environment')][string]$SimulateFailure = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)
if ($SimulateFailure -and -not $dry) { throw '-SimulateFailure is for a dry run only.' }

$config = Read-DrishtiConfig -Path $ConfigPath
Assert-DrishtiConfigConsistent -Config $config -ForUpdate # review M-13 (and 2 m1): the modes fit, and never the CLI's seeded test stack
$services = Join-Path $PSScriptRoot 'drishti-services.ps1'
$backup = Join-Path $PSScriptRoot 'backup.ps1'
$restore = Join-Path $PSScriptRoot 'restore.ps1'
$appRoot = Join-Path $config.InstallRoot 'app'
$releases = Join-Path $appRoot 'releases'
$current = Join-Path $appRoot 'current'
$timeout = if ($config.ContainsKey('HealthTimeoutSec')) { [int]$config.HealthTimeoutSec } else { 180 }
$appServices = @('DrishtiWeb', 'DrishtiGateway', 'DrishtiWorker')
# Final review C-I5: a worker kept stopped on purpose (a pilot without monitoring): WorkerExpected = $false in the configuration (and
# DRISHTI_WORKER_EXPECTED=false in web.env for the Health page). The update then neither starts it nor counts it.
$workerExpected = -not ($config.ContainsKey('WorkerExpected') -and $config.WorkerExpected -eq $false)
if (-not $workerExpected) { $appServices = @($appServices | Where-Object { $_ -ne 'DrishtiWorker' }) }
if ($RestartGo2rtc) { $appServices += 'DrishtiGo2rtc' }
$appServices = @($appServices | Where-Object { @($config.Services) -contains $_ })
$everyService = @($config.Services)
# Re-review 3 m-a: a roll back starts every service again, but never a worker kept stopped on purpose.
$restartServices = @($everyService | Where-Object { $workerExpected -or $_ -ne 'DrishtiWorker' })
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
  $git = Get-DrishtiTool -Config $config -Name git # refuses when GitExe is not configured (never git from PATH)
  try { $sha = (& $git -C $SourcePath rev-parse --short=7 HEAD 2>$null) } catch { $sha = '' }
  if (-not $sha) { $sha = 'nogit' }
  $BuildId = "$((Get-Date).ToString('yyyyMMdd-HHmm'))-$sha"
}
$expected = Get-DrishtiExpectedMigration -SourcePath $SourcePath
$release = Join-Path $releases $BuildId
$previous = $null
# Review 2 N-3: the current release is trusted only when app\current is the junction this script makes, to a release folder.
$previous = Get-DrishtiCurrentRelease -InstallRoot $config.InstallRoot
$drive = (Get-Item -LiteralPath $config.InstallRoot -ErrorAction SilentlyContinue)
Write-DrishtiStep -Message "update to build $BuildId (needs migration $expected) from $SourcePath$(if ($dry) { ' (dry run: nothing is changed)' })"
Write-DrishtiStep -Message "current release: $(if ($previous) { $previous } else { 'none (first installation)' })"
# Fix round 2 (re-review N-2): a database seeded for tests (supabase/seed.sql turns the test fixture switch on) is never updated as a
# production one: the test helpers would run on it.
if ($dry) { Write-DrishtiStep -Kind plan -Message 'would check that the test fixture switch of the database is off (a database seeded for tests is refused)' }
else {
  $fx = Get-DrishtiFixtureSwitch -Config $config -Database $dbName
  if ($fx.On) {
    if ($lock) { $lock.Dispose() }
    throw "Refused: the test fixture switch of database $dbName is on: it was seeded for tests (supabase/seed.sql), which a production database must never be. Nothing was changed. As the database owner: UPDATE public.test_fixture_switch SET honoured = false; then find out how the seed was applied (docs/drishti/runbooks/update-rollback.md section 1)."
  }
}
if (-not $dry -and $drive) {
  $free = (Get-PSDrive -Name $drive.PSDrive.Name).Free
  if ($free -lt 5GB) { throw "Less than 5 GB free on $($drive.PSDrive.Name): (a build and a backup need room)." }
}

# Review C-1: in this process, the names as a real array (powershell.exe -File cannot bind several values to one parameter).
function Invoke-DrishtiServices([string]$Action, [string[]]$Names) {
  # An empty list would bind as "no -Service" in the services script, which means every service (re-review nit).
  if (@($Names).Count -eq 0) { Write-DrishtiStep -Message "no service to $($Action.ToLowerInvariant())"; return }
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
  $mode = [string]$config.MigrationMode # checked by Assert-DrishtiConfigConsistent
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
  try { Invoke-DrishtiCommand -FilePath (Get-DrishtiTool -Config $config -Name npx) -ArgumentList $m.Args -Display $m.Shown }
  finally { if ($m.Password -and -not $had) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } }
}

<# Fix round 2 (re-review N-2): from now on the switch cannot be turned on in this database (migration 0046; seed.sql fails there). #>
function Set-DrishtiProductionMark {
  if ($dry) { Write-DrishtiStep -Kind plan -Message 'would mark the database as a production one (test_fixture_switch.production = true: the test fixture switch can never be turned on there)'; return }
  $fx = Get-DrishtiFixtureSwitch -Config $config -Database $dbName
  if (-not $fx.CanMark) { Write-DrishtiStep -Kind warn -Message 'the database has no production mark yet (migration 20261021000046 not applied)'; return }
  if (-not $fx.Production) {
    Invoke-DrishtiSql -Config $config -Database $dbName -Sql 'UPDATE public.test_fixture_switch SET production = true WHERE NOT production;' | Out-Null
    Write-DrishtiStep -Kind ok -Message 'the database is marked as a production one (the test fixture switch stays off for good)'
  }
}

# ── 2. Build ──────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  if (-not $dry -and (Test-Path -LiteralPath $release)) { throw "$release exists already: choose another -BuildId." }
  # The release inherits the locked app folder's rules (robocopy does not copy security): administrators write, the services read.
  Invoke-DrishtiCommand -FilePath $script:RobocopyExe -ArgumentList @($SourcePath, $release, '/MIR', '/XD', '.git', 'node_modules', '.next', '.superpowers', '/XF', '.env', '.env.local', '.env.*.local', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS') -DryRun:$dry -Display "robocopy $SourcePath -> $release (without .git, node_modules, .next, .env files; never through a junction)" -AllowExitCodes @(0, 1, 2, 3)
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
      Invoke-DrishtiCommand -FilePath (Get-DrishtiTool -Config $config -Name npm) -ArgumentList @('ci', '--no-audit', '--no-fund')
      $env:CK_BUILD_ID = $BuildId
      foreach ($k in $public.Keys) { Set-Item -Path "Env:$k" -Value $public[$k] }
      Invoke-DrishtiCommand -FilePath (Get-DrishtiTool -Config $config -Name npm) -ArgumentList @('run', 'build')
    } finally {
      Remove-Item Env:CK_BUILD_ID -ErrorAction SilentlyContinue
      foreach ($k in $public.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
      Pop-Location
    }
    $standalone = Join-Path $release '.next\standalone'
    # Never through a junction (re-review 3 nit): robocopy /XJ, not a recursive Copy-Item.
    foreach ($sub in @('public', '.next\static')) {
      Invoke-DrishtiCommand -FilePath $script:RobocopyExe -ArgumentList @((Join-Path $release $sub), (Join-Path $standalone $sub), '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -Display "robocopy $sub -> the standalone server" -AllowExitCodes @(0, 1, 2, 3)
    }
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
  & $script:PowerShellExe -NoProfile -NonInteractive -File $backup -ConfigPath $ConfigPath -Tag $tag -ResultPath $backupResult
  if ($LASTEXITCODE -ne 0) { throw 'The backup failed: nothing was stopped or changed.' }
}
$backupFolder = if ($dry) { '<the backup just made>' } else { (Get-Content -LiteralPath $backupResult -Raw | ConvertFrom-Json).folder }
$levelBefore = Get-DrishtiDbLevel

function Write-DrishtiStopped([string]$Why) {
  Write-DrishtiStep -Kind fail -Message "THE SYSTEM IS STOPPED: $Why"
  # Re-review M-new-4: the services' real states, not what the stop was meant to do (a stop can time out).
  if ($dry) { Write-DrishtiStep -Kind fail -Message 'every Drishti service: would be stopped (dry run)' }
  else {
    $states = @($everyService | ForEach-Object { $s = Get-Service -Name $_ -ErrorAction SilentlyContinue; "$_ $(if ($s) { $s.Status } else { 'not installed' })" })
    $running = @($everyService | Where-Object { $s = Get-Service -Name $_ -ErrorAction SilentlyContinue; $s -and $s.Status -ne 'Stopped' })
    Write-DrishtiStep -Kind fail -Message "services now: $($states -join ', ')"
    if ($running.Count -gt 0) { Write-DrishtiStep -Kind fail -Message "NOT stopped: $($running -join ', '). Stop them by hand (services.msc, or Stop-Service -Force) before anything else." }
  }
  Write-DrishtiStep -Kind fail -Message "Nothing is started again. The pre-update backup is $backupFolder; the database as it was before any restore attempt is kept (restore.ps1 never drops it)."
  Write-DrishtiStep -Kind fail -Message 'Next: docs/drishti/runbooks/update-rollback.md section 3 (by hand). Do not start the old release on the new database level.'
}

# ── 4-8. Stop, migrate, switch, start, check; roll back on failure ─────────────
$migrated = $false
$switched = $false
$exitCode = 0
$environmentProblem = $false

<#
  Final review C-I5: is the new release itself broken? Release problems (roll back): /api/version does not answer with the new build id
  within HealthTimeoutSec; one of the started services is not running (a start-up self-check refused it: see its log); the gateway does
  not answer its /g/health; the database is not at the level the release needs. Anything else that makes /api/health "degraded" is a
  problem of the server (disk, worker, Vault, clocks, backup) and does not roll back.
#>
function Get-DrishtiReleaseVerdict {
  $versionUrl = if ($config.ContainsKey('VersionUrl')) { $config.VersionUrl } else { 'http://127.0.0.1:3212/api/version' }
  $healthUrl = if ($config.ContainsKey('HealthUrl')) { $config.HealthUrl } else { 'http://127.0.0.1:3212/api/health' }
  $gatewayUrl = if ($config.ContainsKey('GatewayHealthUrl')) { $config.GatewayHealthUrl } else { 'http://127.0.0.1:3412/g/health' }
  if ($dry) {
    Write-DrishtiStep -Kind plan -Message "would check the new release for up to $timeout s: $versionUrl = $BuildId, $($appServices -join ', ') running, $gatewayUrl answering, the database at $expected; a release failure rolls back"
    Write-DrishtiStep -Kind plan -Message "would then read ${healthUrl}: 'degraded' for another reason (disk, worker, Vault, clocks, backup) is reported, the new release kept, nothing rolled back"
    if ($SimulateFailure -eq 'Environment') { return @{ Verdict = 'environment'; Reasons = @('simulated: the disk is nearly full') } }
    return @{ Verdict = 'ok'; Reasons = @() }
  }
  # The facts (read only), then the pure decision (Get-DrishtiReleaseVerdictFrom, unit-tested).
  $deadline = (Get-Date).AddSeconds($timeout)
  $answered = $false
  while ((Get-Date) -lt $deadline -and -not $answered) {
    try { $answered = ((Invoke-RestMethod -Uri $versionUrl -TimeoutSec 5 -UseBasicParsing).build -eq $BuildId) } catch { $answered = $false }
    if (-not $answered) { Start-Sleep -Seconds 5 }
  }
  $notRunning = @($appServices | Where-Object { $s = Get-Service -Name $_ -ErrorAction SilentlyContinue; -not $s -or $s.Status -ne 'Running' })
  $gatewayChecked = $appServices -contains 'DrishtiGateway'
  $gatewayAnswered = $false
  if ($gatewayChecked) { try { Invoke-RestMethod -Uri $gatewayUrl -TimeoutSec 5 -UseBasicParsing | Out-Null; $gatewayAnswered = $true } catch { $gatewayAnswered = $false } }
  # Re-review 3 m-b: the level is read up to three times; a database that still does not answer is a problem of the server.
  $level = $null
  for ($try = 1; $try -le 3 -and -not $level; $try++) {
    try { $level = [string](Get-DrishtiDbLevel) } catch { $level = $null }
    if (-not $level -and $try -lt 3) { Start-Sleep -Seconds 10 }
  }
  $status = $null
  try { $status = (Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing).status } catch { $status = $null }
  return Get-DrishtiReleaseVerdictFrom -VersionAnswered $answered -NotRunning $notRunning -GatewayChecked $gatewayChecked -GatewayAnswered $gatewayAnswered -DbLevel $level -Expected $expected -PublicStatus $status -VersionUrl $versionUrl -BuildId $BuildId -LogDir $config.LogDir
}
try {
  Invoke-DrishtiServices -Action Stop -Names $appServices
  if ($SimulateFailure -eq 'Migrate') { throw 'simulated failure: the migrations' }
  Invoke-DrishtiMigrations
  $migrated = $dry -or ((Get-DrishtiDbLevel) -ne $levelBefore)
  Set-DrishtiProductionMark
  Set-DrishtiCurrent -Target $release
  $switched = $true
  if ($SimulateFailure -eq 'Start' -or $SimulateFailure -eq 'Restore') { throw 'simulated failure: a service did not start' }
  Invoke-DrishtiServices -Action Start -Names $appServices
  if ($SimulateFailure -eq 'Health') { throw 'simulated failure: the new release does not answer' }
  # Final review C-I5: only a failure that shows the NEW RELEASE is broken rolls back (and may restore the database). A degraded Health
  # page for a reason of the server (disk, a worker stopped on purpose or in standby, the Vault canary, the clocks, a missed backup) is
  # reported and the new release is kept: restoring the database would not cure it and would lose the data written since step 3.
  $verdict = Get-DrishtiReleaseVerdict
  if ($verdict.Verdict -eq 'release') { throw "The new release is not working: $($verdict.Reasons -join '; ')" }
  if ($verdict.Verdict -eq 'environment' -and $verdict.ContainsKey('Database') -and $verdict.Database) {
    # Re-review 3 m-b: stop here and report; a restore would need the very database that does not answer.
    $environmentProblem = $true
    Write-DrishtiStep -Kind fail -Message "the update to $BuildId is in place, but the database does not answer, so the release could not be checked ($($verdict.Reasons -join '; ')). The new release stays switched in with its services started. Nothing was rolled back or restored. Bring the database back (docs/drishti/runbooks/incidents.md), then look at /admin/health; if the release then fails, roll back by hand (docs/drishti/runbooks/update-rollback.md section 3)."
  } elseif ($verdict.Verdict -eq 'environment') {
    $environmentProblem = $true
    Write-DrishtiStep -Kind warn -Message "updated to $BuildId, which works; but the Health page reports a problem of the server, not of the release ($($verdict.Reasons -join '; ')). Nothing was rolled back. Look at /admin/health and docs/drishti/runbooks/incidents.md."
  } else { Write-DrishtiStep -Kind ok -Message "updated to $BuildId" }
  # The admin-only copy of the scripts the nightly backup runs comes from the release that now runs.
  Invoke-DrishtiCommand -FilePath $script:RobocopyExe -ArgumentList @((Join-Path $release 'deploy\windows'), (Join-Path $config.InstallRoot 'scripts'), '/MIR', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -DryRun:$dry -Display "robocopy $release\deploy\windows -> $(Join-Path $config.InstallRoot 'scripts')" -AllowExitCodes @(0, 1, 2, 3)
  # Keep the newest releases (KeepReleases), never the one running or the one before it.
  $keep = if ($config.ContainsKey('KeepReleases')) { [int]$config.KeepReleases } else { 3 }
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would keep the newest $keep releases under $releases and remove older ones" }
  else {
    $old = @(Get-ChildItem -LiteralPath $releases -Directory | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Sort-Object CreationTime -Descending | Select-Object -Skip $keep | Where-Object { $_.FullName -ne $release -and $_.FullName -ne $previous })
    foreach ($o in $old) { if ($PSCmdlet.ShouldProcess($o.FullName, 'remove old release')) { & $script:CmdExe /d /c "rmdir /s /q `"$($o.FullName)`"" | Out-Host } }
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
        & $script:PowerShellExe -NoProfile -NonInteractive -File $restore -ConfigPath $ConfigPath -BackupPath $backupFolder -TargetDatabase $dbName -AllowLiveDatabase -PreRestoreBackup -UnderUpdateLock -SourcePath $(if ($previous) { $previous } else { $SourcePath })
        if ($LASTEXITCODE -ne 0) { throw "the database restore failed (restore.ps1 exit code $LASTEXITCODE; its lines above say what was and was not changed)" }
      }
    } elseif ($migrated) {
      Write-DrishtiStep -Kind warn -Message 'WARNING: migrations were applied and -RollbackDatabase None: the OLD release is started on the NEW database level (only safe when the new migrations are additive; check the Health page "Database version")'
    }
    if ($databaseOk -and $switched) {
      if ($previous) { Set-DrishtiCurrent -Target $previous } elseif ($dry) { Set-DrishtiCurrent -Target '<the previous release>' } else { throw 'there is no earlier release to go back to (first installation)' }
    }
    if ($previous -or $dry) {
      Invoke-DrishtiServices -Action Start -Names $restartServices
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
# The update worked; the server needs a look (exit code 3, never a roll back).
if ($environmentProblem -and $exitCode -eq 0 -and -not $dry) { $exitCode = 3 }
exit $exitCode
