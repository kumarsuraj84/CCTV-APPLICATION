<#
.SYNOPSIS
  CityKart Drishti: restore a backup made by backup.ps1 into a database, then prove it (P5.4).

.DESCRIPTION
  1. Checks the backup: manifest.json present, the dump's SHA-256 as recorded.
  2. Restores db.dump with pg_restore --exit-on-error into a NEW database (created from template0, from a maintenance connection to
     template1), then proves it there:
       - the row counts of the key tables equal the manifest's (taken in the dump's own snapshot);
       - the migration level equals the backup's, and is compared with the release's (-ExpectedMigration or -SourcePath);
       - the Vault: every secret decrypts, and the canary secret decrypts to its known text, so the root key of THIS server is the
         one the secrets were written with; the SHA-256 of the server's root key is compared with the manifest's.
  3. -CreateDatabase: that new database is the result (a rehearsal; -DropAfterVerify drops it afterwards).
     -AllowLiveDatabase (the real restore, review I-1): every Drishti service must be stopped; the live database is backed up first
     (-PreRestoreBackup, which update.ps1 always asks for); the restored copy is proven BEFORE anything live changes; then the two are
     swapped by renaming (the live one becomes <name>_before_restore_<time> and is kept, the copy takes the live name, with the live
     database's owner, privileges and per-database settings). An in-place `pg_restore --clean` is not used: on a Supabase database it
     fails (partitioned realtime tables), so the copy-and-swap is the only path, and a failure at any step leaves the live database as
     it was. Tested on disposable databases only (tests/integration/backup-restore.test.ts); never against the owner's live database.
  -ResultPath writes the proof as JSON (counts, levels, verdicts; no secret, no row value). -DryRun / -WhatIf: plan only.
  Exit code 0 when every check passed, 1 otherwise (and for the live path: the live database unchanged unless the swap was reported).

.EXAMPLE
  .\restore.ps1 -BackupPath D:\DrishtiBackups\20261023-020000-nightly -TargetDatabase drishti_restore_test -CreateDatabase -DropAfterVerify
  .\restore.ps1 -BackupPath D:\DrishtiBackups\20261023-020000-nightly -TargetDatabase postgres -AllowLiveDatabase -PreRestoreBackup
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$TargetDatabase,
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [switch]$CreateDatabase,
  [switch]$AllowLiveDatabase,
  [switch]$PreRestoreBackup,
  [switch]$DropAfterVerify,
  [switch]$SkipServiceCheck,
  [switch]$UnderUpdateLock,
  [string]$ExpectedMigration,
  [string]$SourcePath,
  [string]$ResultPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)
$started = Get-Date
$script:restoreFailed = $false

$config = Read-DrishtiConfig -Path $ConfigPath
$db = $config.Database
Test-DrishtiDbName -Name $TargetDatabase
$live = if ($db.ContainsKey('Name')) { [string]$db.Name } else { 'postgres' }
# Creating, dropping and renaming databases run from a connection to template1: never from a database that is being created or renamed.
$maint = 'template1'
$isLive = $TargetDatabase -eq $live
if ($isLive -and -not $AllowLiveDatabase) { throw "'$TargetDatabase' is the live database: add -AllowLiveDatabase (after stopping every Drishti service) or restore into a new database with -CreateDatabase." }
if (-not $isLive -and -not $CreateDatabase) { throw 'Restoring into a database other than the live one needs -CreateDatabase (a new, empty database made by this run).' }
if ($isLive -and $CreateDatabase) { throw '-CreateDatabase cannot be used with the live database.' }
if ($isLive -and $DropAfterVerify) { throw '-DropAfterVerify never applies to the live database.' }

$manifestPath = Join-Path $BackupPath 'manifest.json'
$dump = Join-Path $BackupPath 'db.dump'
if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $dump)) { throw "$BackupPath is not a Drishti backup (manifest.json and db.dump are needed)." }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.kind -ne 'drishti-backup') { throw 'manifest.json is not a Drishti backup manifest.' }
$sha = Get-DrishtiFileSha256 -Path $dump
if ($sha -ne $manifest.dump.sha256) { throw 'The dump does not match its manifest (SHA-256 differs): the file is damaged or was changed.' }
Write-DrishtiStep -Kind ok -Message "backup $((Split-Path -Leaf $BackupPath)): dump intact ($([math]::Round($manifest.dump.bytes / 1MB, 1)) MB, migration $($manifest.migration))"
if (-not $ExpectedMigration -and $SourcePath) { $ExpectedMigration = Get-DrishtiExpectedMigration -SourcePath $SourcePath }
$suffix = (Get-Date).ToString('yyyyMMddHHmmss')
$work = if ($isLive) { "$($TargetDatabase.Substring(0, [Math]::Min(30, $TargetDatabase.Length)))_restored_$suffix" } else { $TargetDatabase }
$kept = "$($TargetDatabase.Substring(0, [Math]::Min(30, $TargetDatabase.Length)))_before_restore_$suffix"

if ($dry) {
  if ($CreateDatabase) { Write-DrishtiStep -Kind plan -Message "would create the database $TargetDatabase (from template0) and pg_restore --exit-on-error the dump into it" }
  else {
    if ($PreRestoreBackup) { Write-DrishtiStep -Kind plan -Message "would back up the live database first (backup.ps1 -Database $TargetDatabase -Tag before-restore)" }
    Write-DrishtiStep -Kind plan -Message "would restore into a new database $work and prove it there, then swap: $TargetDatabase -> $kept (kept), $work -> $TargetDatabase (services stopped)"
  }
  Write-DrishtiStep -Kind plan -Message 'would compare the row counts, the migration level and the Vault (every secret, the canary, the root key hash)'
  if ($DropAfterVerify) { Write-DrishtiStep -Kind plan -Message "would drop $TargetDatabase afterwards" }
  return
}

Assert-DrishtiSafeToRun -Config $config -ConfigPath $ConfigPath -ScriptRoot $PSScriptRoot
$lock = $null
if ($isLive -and -not $UnderUpdateLock) { $lock = Enter-DrishtiLock -Config $config -What "restore of $TargetDatabase" }
if ($isLive -and -not $SkipServiceCheck) {
  $running = @(Get-Service -Name 'Drishti*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Stopped' })
  if ($running.Count -gt 0) { throw "Stop the Drishti services first ($($running.Name -join ', ')): drishti-services.ps1 -Action Stop. Nothing was changed." }
}

$created = $false
$swapped = $false
try {
  if ($isLive -and $PreRestoreBackup) {
    Write-DrishtiStep -Message "backing up the live database $TargetDatabase before the restore"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup.ps1') -ConfigPath $ConfigPath -Database $TargetDatabase -Tag 'before-restore'
    if ($LASTEXITCODE -ne 0) { throw 'The backup before the restore failed: nothing was restored, the live database is unchanged.' }
  }
  $exists = Invoke-DrishtiSql -Config $config -Database $maint -Sql "SELECT count(*) FROM pg_database WHERE datname = '$work';"
  if ([int]$exists[0] -ne 0) { throw "The database $work exists already: choose a new name (nothing was changed)." }
  if ($PSCmdlet.ShouldProcess($work, 'create database')) {
    Invoke-DrishtiSql -Config $config -Database $maint -Sql "CREATE DATABASE $work TEMPLATE template0;" | Out-Null
    $created = $true
    Write-DrishtiStep -Message "created the database $work"
  }
  if ($db.Mode -eq 'Container') {
    $inside = "/tmp/drishti-restore-$suffix.dump"
    & docker cp $dump "$($db.Container):$inside"
    if ($LASTEXITCODE -ne 0) { throw 'docker cp of the dump into the database container failed.' }
    try { Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "-d $work --exit-on-error $inside" | Out-Null }
    finally { & docker exec $db.Container rm -f $inside | Out-Null }
  } else {
    Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "-d $work --exit-on-error `"$dump`"" | Out-Null
  }
  Write-DrishtiStep -Kind ok -Message "restored into $work"

  # ── The proof (in the restored copy, before anything live changes) ──
  $s = Open-DrishtiPsql -Config $config -Database $work
  try {
    $restored = ConvertFrom-DrishtiCounts -Lines $s.Query((Get-DrishtiCountSql))
    $level = ($s.Query("SELECT coalesce(max(version), '') FROM supabase_migrations.schema_migrations;"))[0]
    $vaultRow = ($s.Query('SELECT count(*), count(*) FILTER (WHERE decrypted_secret IS NOT NULL) FROM vault.decrypted_secrets;'))[0].Split('|')
    $canary = ($s.Query("SELECT coalesce(bool_or(decrypted_secret = '$($script:DrishtiVaultCanary)'), false) FROM vault.decrypted_secrets WHERE name = 'drishti_vault_canary';"))[0]
  } finally { $s.Close() }

  $countRows = [ordered]@{}
  $allEqual = $true
  foreach ($p in $manifest.counts.PSObject.Properties) {
    $got = if ($restored.Contains($p.Name)) { $restored[$p.Name] } else { $null }
    $eq = ($null -ne $got) -and ([int64]$p.Value -eq [int64]$got)
    if (-not $eq) { $allEqual = $false }
    $countRows[$p.Name] = [ordered]@{ backup = [int64]$p.Value; restored = $got; equal = $eq }
  }
  $serverKey = $null
  try { $serverKey = Get-DrishtiVaultKeyHash -Config $config } catch { $serverKey = $null }
  $keyMatches = if ($manifest.vaultKey.sha256 -and $serverKey) { $manifest.vaultKey.sha256 -eq $serverKey } else { $null }
  $ok = $allEqual -and ($level -eq $manifest.migration) -and ([int64]$vaultRow[0] -eq [int64]$vaultRow[1]) -and ($canary -eq 't') -and ($keyMatches -ne $false)

  # ── The live path: swap only a proven copy ──
  if ($isLive -and $ok -and $PSCmdlet.ShouldProcess($TargetDatabase, "replace with the restored copy (the current one is kept as $kept)")) {
    $owner = (Invoke-DrishtiSql -Config $config -Database $maint -Sql "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$TargetDatabase';")[0]
    $grants = Invoke-DrishtiSql -Config $config -Database $maint -Sql @"
SELECT pg_catalog.format('GRANT %s ON DATABASE %I TO %s;', pg_catalog.string_agg(DISTINCT a.privilege_type, ', '), '$work', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END)
FROM pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
WHERE d.datname = '$TargetDatabase' AND a.grantee <> d.datdba GROUP BY a.grantee;
SELECT CASE WHEN s.setrole = 0 THEN pg_catalog.format('ALTER DATABASE %I SET %s TO %L;', '$work', pg_catalog.split_part(c, '=', 1), pg_catalog.substr(c, pg_catalog.strpos(c, '=') + 1))
            ELSE pg_catalog.format('ALTER ROLE %I IN DATABASE %I SET %s TO %L;', pg_catalog.pg_get_userbyid(s.setrole), '$work', pg_catalog.split_part(c, '=', 1), pg_catalog.substr(c, pg_catalog.strpos(c, '=') + 1)) END
FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) c
WHERE d.datname = '$TargetDatabase';
"@
    $sql = @("ALTER DATABASE $work OWNER TO `"$owner`";") + @($grants | Where-Object { $_ })
    Invoke-DrishtiSql -Config $config -Database $maint -Sql ($sql -join "`n") | Out-Null
    Invoke-DrishtiSql -Config $config -Database $maint -Sql @"
ALTER DATABASE $TargetDatabase ALLOW_CONNECTIONS false;
SELECT count(pg_catalog.pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$TargetDatabase' AND pid <> pg_backend_pid();
ALTER DATABASE $TargetDatabase RENAME TO $kept;
ALTER DATABASE $work RENAME TO $TargetDatabase;
ALTER DATABASE $kept ALLOW_CONNECTIONS true;
"@ | Out-Null
    $swapped = $true
    Write-DrishtiStep -Kind ok -Message "the restored copy is now $TargetDatabase; the database as it was is kept as $kept (drop it once everything works)"
  }

  $result = [ordered]@{
    backup = (Split-Path -Leaf $BackupPath); target = $TargetDatabase; live = $isLive; swapped = $swapped; keptAs = $(if ($swapped) { $kept } else { $null })
    preRestoreBackup = [bool]($isLive -and $PreRestoreBackup); dumpSha256Ok = $true
    counts = $countRows; allCountsEqual = $allEqual
    migration = [ordered]@{ backup = $manifest.migration; restored = $level; expected = $ExpectedMigration; equalToBackup = ($level -eq $manifest.migration); pending = [bool]($ExpectedMigration -and $level -lt $ExpectedMigration) }
    vault = [ordered]@{ secrets = [int64]$vaultRow[0]; decryptable = [int64]$vaultRow[1]; allDecrypt = ([int64]$vaultRow[0] -eq [int64]$vaultRow[1]); canaryOk = ($canary -eq 't') }
    vaultKeyMatchesBackup = $keyMatches
    durationSec = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  }
  $result['passed'] = $ok -and (-not $isLive -or $swapped)
  if ($ResultPath) { $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
  $diff = @($countRows.Keys | Where-Object { -not $countRows[$_].equal })
  Write-DrishtiStep -Kind $(if ($allEqual) { 'ok' } else { 'fail' }) -Message "row counts: $(if ($allEqual) { "all $($countRows.Count) tables equal" } else { "differ: $($diff -join ', ')" })"
  Write-DrishtiStep -Kind $(if ($result.migration.equalToBackup) { 'ok' } else { 'fail' }) -Message "migration level: $level (backup $($manifest.migration)$(if ($ExpectedMigration) { ", this release needs $ExpectedMigration" }))"
  if ($result.migration.pending) { Write-DrishtiStep -Kind warn -Message 'migrations of this release are not applied yet: run npx supabase migration up for this database next' }
  Write-DrishtiStep -Kind $(if ($result.vault.allDecrypt -and $result.vault.canaryOk) { 'ok' } else { 'fail' }) -Message "Vault: $($result.vault.decryptable) of $($result.vault.secrets) secrets decrypt; canary $(if ($result.vault.canaryOk) { 'ok' } else { 'NOT ok: the root key of this server is not the backup''s' })"
  Write-DrishtiStep -Kind $(if ($keyMatches -ne $false) { 'ok' } else { 'fail' }) -Message "Vault root key of this server: $(if ($null -eq $keyMatches) { 'not compared (not reachable from here)' } elseif ($keyMatches) { 'the one recorded in the backup' } else { 'NOT the one recorded in the backup' })"
  if (-not $result['passed']) {
    $script:restoreFailed = $true
    if ($isLive) { Write-DrishtiStep -Kind fail -Message "the restored copy did not pass its checks: the live database $TargetDatabase was NOT changed" }
  }
} catch {
  $script:restoreFailed = $true
  Write-DrishtiStep -Kind fail -Message "restore failed: $($_.Exception.Message)"
  if ($isLive) { Write-DrishtiStep -Kind fail -Message $(if ($swapped) { "the restored copy was already in place as $TargetDatabase (the old one kept as $kept)" } else { "the live database $TargetDatabase was NOT changed" }) }
} finally {
  if ($created -and -not $swapped -and ($DropAfterVerify -or $isLive)) {
    # A rehearsal's database when asked; on the live path the unused copy (the live database itself is never dropped here).
    Invoke-DrishtiSql -Config $config -Database $maint -Sql "DROP DATABASE IF EXISTS $work WITH (FORCE);" | Out-Null
    Write-DrishtiStep -Message "dropped $work"
  }
  if ($lock) { $lock.Dispose() }
}
if ($script:restoreFailed) { exit 1 }
