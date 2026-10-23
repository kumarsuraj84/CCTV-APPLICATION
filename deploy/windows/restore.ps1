<#
.SYNOPSIS
  CityKart Drishti: restore a backup made by backup.ps1 into a database, then prove it (P5.4).

.DESCRIPTION
  1. Checks the backup: manifest.json present, the dump's SHA-256 as recorded.
  2. Restores db.dump with pg_restore:
       -CreateDatabase   into a NEW database (a disposable copy: the rehearsal, tests/integration/backup-restore.test.ts);
       -AllowLiveDatabase into the configured live database (the real restore: every Drishti service must be stopped first; uses
                         pg_restore --clean --if-exists). The live path is NOT exercised by the tests (it would replace the owner's
                         data); rehearse it on a copy of the server first (runbook backup-restore.md).
  3. Proves the result, in the restored database:
       - the row counts of the key tables equal the manifest's (taken in the dump's own snapshot);
       - the migration level equals the backup's, and is compared with the release's (-ExpectedMigration or -SourcePath);
       - the Vault: every secret decrypts, and the canary secret decrypts to its known text, so the root key of THIS server is the
         one the secrets were written with; the SHA-256 of the server's root key is compared with the manifest's.
  4. -DropAfterVerify drops the database this run created (never the live one).
  -ResultPath writes the proof as JSON (counts, levels, verdicts; no secret, no row value). -DryRun / -WhatIf: plan only.
  Exit code 0 when every check passed, 1 otherwise.

.EXAMPLE
  .\restore.ps1 -BackupPath D:\DrishtiBackups\20261023-020000-nightly -TargetDatabase drishti_restore_test -CreateDatabase -DropAfterVerify
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$TargetDatabase,
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [switch]$CreateDatabase,
  [switch]$AllowLiveDatabase,
  [switch]$DropAfterVerify,
  [switch]$SkipServiceCheck,
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

if ($isLive -and -not $SkipServiceCheck -and -not $dry) {
  $running = @(Get-Service -Name 'Drishti*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'Stopped' })
  if ($running.Count -gt 0) { throw "Stop the Drishti services first ($($running.Name -join ', ')): drishti-services.ps1 -Action Stop." }
}

if ($dry) {
  if ($CreateDatabase) { Write-DrishtiStep -Kind plan -Message "would create the database $TargetDatabase and pg_restore the dump into it" }
  else { Write-DrishtiStep -Kind plan -Message "would pg_restore --clean --if-exists into the LIVE database $TargetDatabase (services stopped)" }
  Write-DrishtiStep -Kind plan -Message 'would compare the row counts, the migration level and the Vault (every secret, the canary, the root key hash)'
  if ($DropAfterVerify) { Write-DrishtiStep -Kind plan -Message "would drop $TargetDatabase afterwards" }
  return
}

$created = $false
$restoreWarnings = 0
try {
  if ($CreateDatabase) {
    $exists = Invoke-DrishtiSql -Config $config -Database $live -Sql "SELECT count(*) FROM pg_database WHERE datname = '$TargetDatabase';"
    if ([int]$exists[0] -ne 0) { throw "The database $TargetDatabase exists already: choose a new name (nothing was changed)." }
    if ($PSCmdlet.ShouldProcess($TargetDatabase, 'create database')) {
      Invoke-DrishtiSql -Config $config -Database $live -Sql "CREATE DATABASE $TargetDatabase;" | Out-Null
      $created = $true
      Write-DrishtiStep -Message "created the database $TargetDatabase"
    }
  }
  $restoreArgs = if ($isLive) { "-d $TargetDatabase --clean --if-exists" } else { "-d $TargetDatabase --exit-on-error" }
  if ($db.Mode -eq 'Container') {
    $inside = "/tmp/drishti-restore-$((Get-Date).ToString('yyyyMMddHHmmss')).dump"
    & docker cp $dump "$($db.Container):$inside"
    if ($LASTEXITCODE -ne 0) { throw 'docker cp of the dump into the database container failed.' }
    try {
      if ($isLive) {
        try { Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "$restoreArgs $inside" | Out-Null } catch { $restoreWarnings++; Write-DrishtiStep -Kind warn -Message "pg_restore reported problems (checked below): $($_.Exception.Message.Split("`n")[0])" }
      } else { Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "$restoreArgs $inside" | Out-Null }
    } finally { & docker exec $db.Container rm -f $inside | Out-Null }
  } else {
    if ($isLive) {
      try { Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "$restoreArgs `"$dump`"" | Out-Null } catch { $restoreWarnings++; Write-DrishtiStep -Kind warn -Message "pg_restore reported problems (checked below): $($_.Exception.Message.Split("`n")[0])" }
    } else { Invoke-DrishtiPgTool -Config $config -Tool pg_restore -Arguments "$restoreArgs `"$dump`"" | Out-Null }
  }
  Write-DrishtiStep -Kind ok -Message "restored into $TargetDatabase"

  # ── The proof ──
  $s = Open-DrishtiPsql -Config $config -Database $TargetDatabase
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
  $result = [ordered]@{
    backup = (Split-Path -Leaf $BackupPath); target = $TargetDatabase; live = $isLive; dumpSha256Ok = $true; restoreWarnings = $restoreWarnings
    counts = $countRows; allCountsEqual = $allEqual
    migration = [ordered]@{ backup = $manifest.migration; restored = $level; expected = $ExpectedMigration; equalToBackup = ($level -eq $manifest.migration); pending = [bool]($ExpectedMigration -and $level -lt $ExpectedMigration) }
    vault = [ordered]@{ secrets = [int64]$vaultRow[0]; decryptable = [int64]$vaultRow[1]; allDecrypt = ([int64]$vaultRow[0] -eq [int64]$vaultRow[1]); canaryOk = ($canary -eq 't') }
    vaultKeyMatchesBackup = $keyMatches
    durationSec = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  }
  $ok = $allEqual -and $result.migration.equalToBackup -and $result.vault.allDecrypt -and $result.vault.canaryOk -and ($keyMatches -ne $false)
  $result['passed'] = $ok
  if ($ResultPath) { $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
  $diff = @($countRows.Keys | Where-Object { -not $countRows[$_].equal })
  Write-DrishtiStep -Kind $(if ($allEqual) { 'ok' } else { 'fail' }) -Message "row counts: $(if ($allEqual) { "all $($countRows.Count) tables equal" } else { "differ: $($diff -join ', ')" })"
  Write-DrishtiStep -Kind $(if ($result.migration.equalToBackup) { 'ok' } else { 'fail' }) -Message "migration level: $level (backup $($manifest.migration)$(if ($ExpectedMigration) { ", this release needs $ExpectedMigration" }))"
  if ($result.migration.pending) { Write-DrishtiStep -Kind warn -Message 'migrations of this release are not applied yet: run npx supabase migration up for this database next' }
  Write-DrishtiStep -Kind $(if ($result.vault.allDecrypt -and $result.vault.canaryOk) { 'ok' } else { 'fail' }) -Message "Vault: $($result.vault.decryptable) of $($result.vault.secrets) secrets decrypt; canary $(if ($result.vault.canaryOk) { 'ok' } else { 'NOT ok: the root key of this server is not the backup''s' })"
  Write-DrishtiStep -Kind $(if ($keyMatches -ne $false) { 'ok' } else { 'fail' }) -Message "Vault root key of this server: $(if ($null -eq $keyMatches) { 'not compared (not reachable from here)' } elseif ($keyMatches) { 'the one recorded in the backup' } else { 'NOT the one recorded in the backup' })"
  if (-not $ok) { $script:restoreFailed = $true }
} finally {
  if ($created -and $DropAfterVerify) {
    if ($PSCmdlet.ShouldProcess($TargetDatabase, 'drop the database made by this run')) {
      Invoke-DrishtiSql -Config $config -Database $live -Sql "DROP DATABASE IF EXISTS $TargetDatabase WITH (FORCE);" | Out-Null
      Write-DrishtiStep -Message "dropped $TargetDatabase"
    }
  }
}
if ($script:restoreFailed) { exit 1 }
