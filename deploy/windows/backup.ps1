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

  Review C-2 / I-6 / M-8: BackupDir and KeyBackupDir are created locked (SYSTEM and Administrators only) before anything is written;
  the key folder must not be the backup folder or lie inside it (or the other way round); the script refuses to run from a
  configuration or an installed scripts folder that others may change. Retention never follows a junction or symbolic link: it only
  removes folders named like a backup whose manifest says kind drishti-backup and that contain no reparse point, with rmdir (which
  removes a link, never its target), and only when the backup folder itself cannot be changed by others.

  -DryRun / -WhatIf: says what would be done, writes and deletes nothing. -RetentionOnly: no dump, only the retention.

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
  [switch]$RetentionOnly,
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
$keyDir = if ($config.ContainsKey('VaultKey') -and $config.VaultKey -and $config.VaultKey.KeyBackupDir) { [string]$config.VaultKey.KeyBackupDir } else { $null }

# Review M-8: the key copies (and the configuration copy) never live with the dumps.
if ($keyDir) {
  $a = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $b = [IO.Path]::GetFullPath($keyDir).TrimEnd('\') + '\'
  if ($a.StartsWith($b, [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a, [StringComparison]::OrdinalIgnoreCase)) {
    throw "VaultKey.KeyBackupDir ($keyDir) must not be the backup folder ($root), or inside it, or contain it: whoever has both has every NVR password."
  }
}
if (-not $dry) { Assert-DrishtiSafeToRun -Config $config -ConfigPath $ConfigPath -ScriptRoot $PSScriptRoot }
# The web app may read the free space of the backup disk (review M-4), nothing in it.
$webReader = @(Get-DrishtiServiceAccount -Config $config -Name 'DrishtiWeb')
# Created locked, before anything is written (review C-2, I-6).
if (-not (Test-Path -LiteralPath $root)) { Set-DrishtiAcl -Path $root -ListAccounts $webReader -DryRun:$dry }
elseif (-not $dry) {
  # Fix round 2 (re-review M-new-8): the backup itself refuses a folder others may change, as the retention does.
  $rootProblems = @(Test-DrishtiPathAcl -Path $root -ReadAccounts $webReader -Secret -TrustOperator)
  if ($rootProblems.Count -gt 0) { throw "Backup refused: others may change or read the backup folder ($($rootProblems -join '; ')). Run drishti-services.ps1 -Action RepairAcl." }
}

if (-not $RetentionOnly) {
  Write-DrishtiStep -Message "backup of database '$dbName' to $folder$(if ($dry) { ' (dry run: nothing is written)' })"
  if ($dry) {
    Write-DrishtiStep -Kind plan -Message "would open one REPEATABLE READ snapshot, count $($script:DrishtiCountTables.Count) tables in it and pg_dump -Fc --snapshot=<it>"
    Write-DrishtiStep -Kind plan -Message "would write $dump and $(Join-Path $folder 'manifest.json') (SHA-256 of the dump and of the Vault root key)"
    if ($IncludeVaultKey) { Write-DrishtiStep -Kind plan -Message "would copy the Vault root key ($($config.VaultKey.Mode)) to $keyDir\vault-root-$stamp.key (the folder locked first: Administrators only)" }
    if ($IncludeConfig) { Write-DrishtiStep -Kind plan -Message "would copy the configuration ($($config.ConfigDir): env files, go2rtc.yaml, drishti.config.psd1) to $keyDir\config-$stamp (Administrators only; it holds the services' secrets)" }
  } else {
    # The folder name is predictable: one that exists already was not made by this run (re-review M-new-8).
    if (Test-Path -LiteralPath $folder) { throw "$folder exists already: it was not made by this backup. Look at it; nothing was written." }
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
        $docker = Get-DrishtiTool -Config $config -Name docker
        Invoke-DrishtiPgTool -Config $config -Tool pg_dump -Arguments "-d $dbName -Fc --snapshot=$snapshot -f $inside" | Out-Null
        try {
          & $docker cp "$($db.Container):$inside" $dump
          if ($LASTEXITCODE -ne 0) { throw 'docker cp of the dump failed.' }
        } finally { & $docker exec $db.Container rm -f $inside | Out-Null }
      } else {
        Invoke-DrishtiPgTool -Config $config -Tool pg_dump -Arguments "-d $dbName -Fc --snapshot=$snapshot -f `"$dump`"" | Out-Null
      }
      $session.Query('COMMIT;') | Out-Null
    } finally { $session.Close() }

    $keyHash = Get-DrishtiVaultKeyHash -Config $config
    $keyCopy = $null
    if (($IncludeVaultKey -or $IncludeConfig) -and -not $keyDir) { throw 'VaultKey.KeyBackupDir is needed for the key and configuration copies (they hold secrets: never the dump folder).' }
    if (($IncludeVaultKey -or $IncludeConfig) -and -not (Test-Path -LiteralPath $keyDir)) { Set-DrishtiAcl -Path $keyDir }
    if ($IncludeVaultKey) {
      $vk = $config.VaultKey
      if ($vk.Mode -eq 'None') { throw 'VaultKey.Mode is None: the root key cannot be copied from here (hosted project: the platform keeps it).' }
      $keyCopy = Join-Path $keyDir "vault-root-$stamp.key"
      if ($vk.Mode -eq 'ContainerFile') {
        & (Get-DrishtiTool -Config $config -Name docker) cp "$($db.Container):$($vk.Path)" $keyCopy
        if ($LASTEXITCODE -ne 0) { throw 'docker cp of the Vault root key failed.' }
      } else { Copy-Item -LiteralPath $vk.Path -Destination $keyCopy }
      Set-DrishtiAcl -Path $keyCopy -IsFile
      if ((Get-DrishtiFileSha256 -Path $keyCopy) -ne $keyHash) { throw 'The copy of the Vault root key does not match the key in use.' }
    }
    # The configuration (the services' env files hold their secrets): kept with the key copies, never with the dumps.
    $configCopy = $null
    if ($IncludeConfig) {
      $configCopy = Join-Path $keyDir "config-$stamp"
      Set-DrishtiAcl -Path $configCopy
      Copy-Item -Path (Join-Path $config.ConfigDir '*') -Destination $configCopy -Recurse
    }
    $manifest = [ordered]@{
      kind = 'drishti-backup'; version = 1; createdAt = (Get-Date).ToUniversalTime().ToString('o'); tag = $Tag; database = $dbName; serverVersion = $version
      migration = $migration; counts = $counts; dump = [ordered]@{ file = 'db.dump'; bytes = (Get-Item -LiteralPath $dump).Length; sha256 = (Get-DrishtiFileSha256 -Path $dump) }
      vaultKey = [ordered]@{ sha256 = $keyHash; copied = [bool]$keyCopy; copiedTo = $keyCopy; mode = $(if ($config.ContainsKey('VaultKey') -and $config.VaultKey) { $config.VaultKey.Mode } else { 'None' }) }
      config = [ordered]@{ copied = [bool]$configCopy; copiedTo = $configCopy }
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $folder 'manifest.json') -Encoding UTF8
    Write-DrishtiStep -Kind ok -Message "backup written: $folder ($([math]::Round($manifest.dump.bytes / 1MB, 1)) MB, migration $migration, $($counts['public.cameras']) cameras, $($counts['vault.secrets']) Vault secrets)"
    if ($ResultPath) { @{ folder = $folder; manifest = $manifest } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
  }
}

if ($ApplyRetention -or $RetentionOnly) {
  # Keep: every backup younger than Retention.Days, and always the newest Retention.KeepAtLeast whatever their age. Only folders this
  # script made are ever considered: a plain folder (not a junction or link) named <yyyyMMdd-HHmmss>-<tag> whose manifest.json says
  # kind drishti-backup; one that contains a reparse point anywhere is refused, never entered.
  $days = 30; $keep = 7
  if ($config.ContainsKey('Retention')) { $days = [int]$config.Retention.Days; $keep = [int]$config.Retention.KeepAtLeast }
  if (-not (Test-Path -LiteralPath $root)) { return }
  $rootProblems = @(Test-DrishtiPathAcl -Path $root -ReadAccounts $webReader -Secret -TrustOperator)
  if ($rootProblems.Count -gt 0) { throw "Retention refused: others may change or read the backup folder ($($rootProblems -join '; ')). Run drishti-services.ps1 -Action RepairAcl." }
  $candidates = @()
  foreach ($e in [IO.Directory]::GetDirectories($root)) {
    $name = [IO.Path]::GetFileName($e)
    if ($name -notmatch '^\d{8}-\d{6}-[a-z0-9-]+$') { continue }
    if ([IO.File]::GetAttributes($e) -band [IO.FileAttributes]::ReparsePoint) { Write-DrishtiStep -Kind warn -Message "skipped ${name}: a junction or link, not a backup"; continue }
    $m = Join-Path $e 'manifest.json'
    if (-not [IO.File]::Exists($m) -or ([IO.File]::GetAttributes($m) -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $kind = $null
    try { $kind = (Get-Content -LiteralPath $m -Raw | ConvertFrom-Json).kind } catch { $kind = $null }
    if ($kind -ne 'drishti-backup') { continue }
    $candidates += $name
  }
  $cutoff = (Get-Date).AddDays(-$days)
  $i = 0
  foreach ($name in ($candidates | Sort-Object -Descending)) {
    $i++
    $made = [datetime]::ParseExact($name.Substring(0, 15), 'yyyyMMdd-HHmmss', $null)
    if ($i -le $keep -or $made -ge $cutoff) { continue }
    $path = Join-Path $root $name
    if (Test-DrishtiHasReparsePoint -Path $path) { Write-DrishtiStep -Kind warn -Message "kept ${path}: it contains a junction or link (not made by this script; look at it by hand)"; continue }
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would remove the old backup $path (older than $days days, beyond the newest $keep)"; continue }
    if ($PSCmdlet.ShouldProcess($path, 'remove old backup')) {
      & $script:CmdExe /d /c "rmdir /s /q `"$path`"" | Out-Host
      if (Test-Path -LiteralPath $path) { Write-DrishtiStep -Kind warn -Message "could not remove $path" } else { Write-DrishtiStep -Message "removed the old backup $name" }
    }
  }
}
