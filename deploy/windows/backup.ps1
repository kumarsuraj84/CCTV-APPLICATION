<#
.SYNOPSIS
  CityKart Drishti: back up the database, record what is in it, keep the Vault root key apart, apply the retention policy (P5.4).

.DESCRIPTION
  One folder per backup under BackupDir: <yyyyMMdd-HHmmss>-<tag>\
    db.dump        pg_dump custom format (-Fc) of the whole database (public, auth, vault, storage, supabase_migrations ...).
    manifest.json  when, what, the migration level, the row counts of the key tables, the dump's SHA-256 and size, and the SHA-256 of the
                   Vault root key it needs; no secret, no value of a row.
  The row counts are taken in the SAME snapshot as the dump (pg_export_snapshot, then pg_dump --snapshot), so a restore must reproduce
  them exactly even while the services are running.

  The Vault root key (supabase_vault / pgsodium root key) is NOT in the dump: every NVR password in vault.secrets is encrypted with keys
  derived from it, and a dump restored on a server with another root key cannot decrypt them. -IncludeVaultKey copies it into
  VaultKey.KeyBackupDir (a different place from the dumps, Administrators only); without it the manifest still records its SHA-256, so
  restore.ps1 can tell whether the server it restores on has the right key. docs/drishti/runbooks/backup-restore.md.

  -DryRun / -WhatIf: says what would be done, writes and deletes nothing.

.EXAMPLE
  .\backup.ps1 -ConfigPath C:\Drishti\config\drishti.config.psd1 -Tag nightly -ApplyRetention
  .\backup.ps1 -Tag before-change -IncludeVaultKey
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [ValidatePattern('^[a-z0-9-]{1,40}$')][string]$Tag = 'manual',
  [string]$OutDir,
  [string]$Database,
  [switch]$IncludeVaultKey,
  [switch]$IncludeConfig,
  [switch]$ApplyRetention,
  [string]$ResultPath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)

$config = Read-DrishtiConfig -Path $ConfigPath
$db = $config.Database
$dbName = if ($Database) { $Database } elseif ($db.ContainsKey('Name')) { [string]$db.Name } else { 'postgres' }
Test-DrishtiDbName -Name $dbName
$root = if ($OutDir) { $OutDir } else { $config.BackupDir }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$folder = Join-Path $root "$stamp-$Tag"
$dump = Join-Path $folder 'db.dump'

Write-DrishtiStep -Message "backup of database '$dbName' to $folder$(if ($dry) { ' (dry run: nothing is written)' })"
if ($dry) {
  Write-DrishtiStep -Kind plan -Message "would open one REPEATABLE READ snapshot, count $($script:DrishtiCountTables.Count) tables in it and pg_dump -Fc --snapshot=<it>"
  Write-DrishtiStep -Kind plan -Message "would write $dump and $(Join-Path $folder 'manifest.json') (SHA-256 of the dump and of the Vault root key)"
  if ($IncludeVaultKey) { Write-DrishtiStep -Kind plan -Message "would copy the Vault root key ($($config.VaultKey.Mode)) to $($config.VaultKey.KeyBackupDir)\vault-root-$stamp.key (Administrators only)" }
  if ($IncludeConfig) { Write-DrishtiStep -Kind plan -Message "would copy the configuration ($($config.ConfigDir): env files, go2rtc.yaml, drishti.config.psd1) to $($config.VaultKey.KeyBackupDir)\config-$stamp (Administrators only; it holds the services' secrets)" }
} else {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  Set-DrishtiAcl -Path $folder
  $session = Open-DrishtiPsql -Config $config -Database $dbName
  try {
    $snapshot = ($session.Query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();'))[0]
    if ($snapshot -notmatch '^[0-9A-F-]+$') { throw 'The database did not give a snapshot.' }
    $counts = ConvertFrom-DrishtiCounts -Lines $session.Query((Get-DrishtiCountSql))
    $migration = ($session.Query("SELECT coalesce(max(version), '') FROM supabase_migrations.schema_migrations;"))[0]
    $version = ($session.Query('SHOW server_version;'))[0]
    if ($db.Mode -eq 'Container') {
      $inside = "/tmp/drishti-backup-$stamp.dump"
      Invoke-DrishtiPgTool -Config $config -Tool pg_dump -Arguments "-d $dbName -Fc --snapshot=$snapshot -f $inside" | Out-Null
      try {
        & docker cp "$($db.Container):$inside" $dump
        if ($LASTEXITCODE -ne 0) { throw 'docker cp of the dump failed.' }
      } finally { & docker exec $db.Container rm -f $inside | Out-Null }
    } else {
      Invoke-DrishtiPgTool -Config $config -Tool pg_dump -Arguments "-d $dbName -Fc --snapshot=$snapshot -f `"$dump`"" | Out-Null
    }
    $session.Query('COMMIT;') | Out-Null
  } finally { $session.Close() }

  $keyHash = Get-DrishtiVaultKeyHash -Config $config
  $keyCopy = $null
  if ($IncludeVaultKey) {
    $vk = $config.VaultKey
    if (-not $vk -or $vk.Mode -eq 'None') { throw 'VaultKey.Mode is None: the root key cannot be copied from here (hosted project: the platform keeps it).' }
    New-Item -ItemType Directory -Force -Path $vk.KeyBackupDir | Out-Null
    $keyCopy = Join-Path $vk.KeyBackupDir "vault-root-$stamp.key"
    if ($vk.Mode -eq 'ContainerFile') {
      & docker cp "$($db.Container):$($vk.Path)" $keyCopy
      if ($LASTEXITCODE -ne 0) { throw 'docker cp of the Vault root key failed.' }
    } else { Copy-Item -LiteralPath $vk.Path -Destination $keyCopy }
    Set-DrishtiAcl -Path $keyCopy -IsFile
    if ((Get-DrishtiFileSha256 -Path $keyCopy) -ne $keyHash) { throw 'The copy of the Vault root key does not match the key in use.' }
  }
  # The configuration (the services' env files hold their secrets): kept with the key copies, never with the dumps.
  $configCopy = $null
  if ($IncludeConfig) {
    if (-not $config.VaultKey -or -not $config.VaultKey.KeyBackupDir) { throw 'VaultKey.KeyBackupDir is needed for the configuration copy (it holds secrets: never the dump folder).' }
    $configCopy = Join-Path $config.VaultKey.KeyBackupDir "config-$stamp"
    New-Item -ItemType Directory -Force -Path $configCopy | Out-Null
    Set-DrishtiAcl -Path $configCopy
    Copy-Item -Path (Join-Path $config.ConfigDir '*') -Destination $configCopy -Recurse
  }
  $manifest = [ordered]@{
    kind = 'drishti-backup'; version = 1; createdAt = (Get-Date).ToUniversalTime().ToString('o'); tag = $Tag; database = $dbName; serverVersion = $version
    migration = $migration; counts = $counts; dump = [ordered]@{ file = 'db.dump'; bytes = (Get-Item -LiteralPath $dump).Length; sha256 = (Get-DrishtiFileSha256 -Path $dump) }
    vaultKey = [ordered]@{ sha256 = $keyHash; copied = [bool]$keyCopy; copiedTo = $keyCopy; mode = $(if ($config.VaultKey) { $config.VaultKey.Mode } else { 'None' }) }
    config = [ordered]@{ copied = [bool]$configCopy; copiedTo = $configCopy }
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $folder 'manifest.json') -Encoding UTF8
  Write-DrishtiStep -Kind ok -Message "backup written: $folder ($([math]::Round($manifest.dump.bytes / 1MB, 1)) MB, migration $migration, $($counts['public.cameras']) cameras, $($counts['vault.secrets']) Vault secrets)"
  if ($ResultPath) { @{ folder = $folder; manifest = $manifest } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
}

if ($ApplyRetention) {
  # Keep: every backup younger than Retention.Days, and always the newest Retention.KeepAtLeast whatever their age. Only folders this
  # script made (name <yyyyMMdd-HHmmss>-<tag> with a manifest.json of kind drishti-backup) are ever considered.
  $days = 30; $keep = 7
  if ($config.ContainsKey('Retention')) { $days = [int]$config.Retention.Days; $keep = [int]$config.Retention.KeepAtLeast }
  $all = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}-\d{6}-[a-z0-9-]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json')) } | Sort-Object Name -Descending)
  $cutoff = (Get-Date).AddDays(-$days)
  $i = 0
  foreach ($b in $all) {
    $i++
    $made = [datetime]::ParseExact($b.Name.Substring(0, 15), 'yyyyMMdd-HHmmss', $null)
    if ($i -le $keep -or $made -ge $cutoff) { continue }
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would remove the old backup $($b.FullName) (older than $days days, beyond the newest $keep)"; continue }
    if ($PSCmdlet.ShouldProcess($b.FullName, 'remove old backup')) { Remove-Item -LiteralPath $b.FullName -Recurse -Force; Write-DrishtiStep -Message "removed the old backup $($b.Name)" }
  }
}
