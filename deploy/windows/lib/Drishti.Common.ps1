# CityKart Drishti: shared helpers of the Windows deployment scripts (P5.4). Dot-sourced by drishti-services.ps1, update.ps1,
# backup.ps1 and restore.ps1. Windows PowerShell 5.1 compatible. Nothing here prints a secret: database connection strings come from
# an environment variable that is NAMED in the configuration (never stored in it), and no env-file value is ever echoed.

Set-StrictMode -Version 2.0

$script:DrishtiServiceNames = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')
# Stop the services people use first (no new video while the rest goes down), then the worker; go2rtc last. Start in reverse.
$script:DrishtiStopOrder = @('DrishtiWeb', 'DrishtiGateway', 'DrishtiWorker', 'DrishtiGo2rtc')
$script:DrishtiStartOrder = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')
# The tables whose row counts a backup records and a restore must reproduce (same snapshot as the dump).
$script:DrishtiCountTables = @(
  'public.organizations', 'public.profiles', 'public.regions', 'public.clusters', 'public.locations', 'public.assets', 'public.recorders',
  'public.cameras', 'public.camera_channel_mappings', 'public.access_grants', 'public.camera_groups', 'public.camera_group_items',
  'public.admin_audit_log', 'public.auth_events', 'public.vault_reads', 'auth.users', 'vault.secrets', 'supabase_migrations.schema_migrations'
)
$script:DrishtiVaultCanary = 'drishti-vault-canary-v1'

<#
  One line of progress for the operator. Written to the host (the console, or the standard output of `powershell -File`), never to the
  pipeline, so it can never become part of what a function returns.
#>
function Write-DrishtiStep {
  param([Parameter(Mandatory)][string]$Message, [string]$Kind = 'step')
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $prefix = switch ($Kind) { 'plan' { 'PLAN' } 'warn' { 'WARN' } 'fail' { 'FAIL' } 'ok' { ' OK ' } default { 'STEP' } }
  Write-Host "[$stamp] $prefix $Message"
}

function Read-DrishtiConfig {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "The configuration file $Path does not exist (copy deploy\windows\drishti.config.example.psd1)." }
  $c = Import-PowerShellDataFile -LiteralPath $Path
  foreach ($k in @('InstallRoot', 'ConfigDir', 'DataDir', 'LogDir', 'BackupDir', 'NodeExe', 'Database', 'Services')) {
    if (-not $c.ContainsKey($k)) { throw "The configuration has no '$k' (see deploy\windows\drishti.config.example.psd1)." }
  }
  if (@('Container', 'Direct') -notcontains $c.Database.Mode) { throw "Database.Mode must be 'Container' or 'Direct'." }
  return $c
}

function Get-DrishtiReleaseDir { param([Parameter(Mandatory)]$Config) Join-Path $Config.InstallRoot 'app\current' }

<#
  The four services: what each one runs, from where, with which env file and account. The host (DrishtiServiceHost.exe) reads one
  .conf file per service (key=value lines) written by drishti-services.ps1 -Action Install.
#>
function Get-DrishtiServiceDefinitions {
  param([Parameter(Mandatory)]$Config)
  $rel = Get-DrishtiReleaseDir -Config $Config
  $node = $Config.NodeExe
  $tsx = Join-Path $rel 'node_modules\tsx\dist\cli.mjs'
  $defs = @(
    [pscustomobject]@{ Name = 'DrishtiWeb'; Display = 'CityKart Drishti web app'; Exe = $node; Args = @((Join-Path $rel '.next\standalone\server.js'));
      WorkDir = (Join-Path $rel '.next\standalone'); EnvFile = (Join-Path $Config.ConfigDir 'web.env'); StopTimeoutSec = 30; DependsOn = @() },
    [pscustomobject]@{ Name = 'DrishtiWorker'; Display = 'CityKart Drishti monitoring worker'; Exe = $node; Args = @($tsx, '--tsconfig', (Join-Path $rel 'tsconfig.json'), (Join-Path $rel 'services\worker\index.ts'));
      WorkDir = $rel; EnvFile = (Join-Path $Config.ConfigDir 'worker.env'); StopTimeoutSec = 25; DependsOn = @() },
    [pscustomobject]@{ Name = 'DrishtiGateway'; Display = 'CityKart Drishti video gateway'; Exe = $node; Args = @($tsx, '--tsconfig', (Join-Path $rel 'tsconfig.json'), (Join-Path $rel 'services\gateway\index.ts'));
      WorkDir = $rel; EnvFile = (Join-Path $Config.ConfigDir 'gateway.env'); StopTimeoutSec = 15; DependsOn = @('DrishtiGo2rtc') },
    [pscustomobject]@{ Name = 'DrishtiGo2rtc'; Display = 'CityKart Drishti go2rtc (loopback video server)'; Exe = $Config.Go2rtcExe; Args = @('-config', (Join-Path $Config.ConfigDir 'go2rtc.yaml'));
      WorkDir = (Split-Path -Parent $Config.Go2rtcExe); EnvFile = (Join-Path $Config.ConfigDir 'go2rtc.env'); StopTimeoutSec = 10; DependsOn = @() }
  )
  $wanted = @($Config.Services)
  return @($defs | Where-Object { $wanted -contains $_.Name })
}

function Get-DrishtiServiceAccount {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Name)
  if ($Config.ContainsKey('Accounts') -and $Config.Accounts.ContainsKey($Name) -and $Config.Accounts[$Name]) { return [string]$Config.Accounts[$Name] }
  return "NT SERVICE\$Name" # a virtual service account: no password, no account to create, least privilege
}

<# The .conf file of the service host (no secret in it: the env file is named, not copied). #>
function ConvertTo-DrishtiHostConf {
  param([Parameter(Mandatory)]$Definition, [Parameter(Mandatory)]$Config)
  $lines = @("name=$($Definition.Name)", "exe=$($Definition.Exe)")
  foreach ($a in $Definition.Args) { $lines += "arg=$a" }
  $max = 10485760
  $keep = 10
  if ($Config.ContainsKey('LogMaxBytes')) { $max = [int64]$Config.LogMaxBytes }
  if ($Config.ContainsKey('LogKeep')) { $keep = [int]$Config.LogKeep }
  $lines += @(
    "workdir=$($Definition.WorkDir)", "envfile=$($Definition.EnvFile)", "logdir=$(Join-Path $Config.LogDir $Definition.Name)",
    "logmaxbytes=$max", "logkeep=$keep", "stoptimeoutsec=$($Definition.StopTimeoutSec)", 'restartdelaysec=5', 'restartmaxdelaysec=60'
  )
  return ($lines -join "`r`n") + "`r`n"
}

<# Runs an external program, or in a dry run only says what it would run. Throws on a non-zero exit code. #>
function Invoke-DrishtiCommand {
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @(), [switch]$DryRun, [string]$Display, [int[]]$AllowExitCodes = @(0))
  $shown = if ($Display) { $Display } else { "$FilePath $($ArgumentList -join ' ')" }
  if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would run: $shown"; return }
  Write-DrishtiStep -Message "run: $shown"
  & $FilePath @ArgumentList | Out-Host
  $code = $LASTEXITCODE
  if ($AllowExitCodes -notcontains $code) { throw "Failed ($code): $shown" }
  $global:LASTEXITCODE = 0
}

function Test-DrishtiDbName {
  param([Parameter(Mandatory)][string]$Name)
  if ($Name -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw "'$Name' is not a plain database name (lower-case letters, digits, underscore)." }
}

<#
  An interactive psql session (for one consistent snapshot: the dump and the row counts of the backup come from the same moment).
  Container mode: psql inside the database container; Direct mode: psql.exe with the connection string from the NAMED environment
  variable (Database.UrlEnv). Returns an object with Query(sql) -> lines and Close().
#>
<#
  How to run a PostgreSQL client tool (psql, pg_dump, pg_restore) against the configured database server.
  Container mode: `docker exec [-i] <container> <tool> -U <user> ...` (the local Supabase stack, or a self-hosted Supabase in Docker).
  Direct mode: <PgBin>\<tool>.exe with PGHOST, PGPORT, PGUSER and PGPASSWORD set in the child's environment only (the password from the
  environment variable NAMED by Database.PasswordEnv), so no password appears on a command line or in a log.
#>
function New-DrishtiPgStartInfo {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][ValidateSet('psql', 'pg_dump', 'pg_restore')][string]$Tool, [string]$Arguments = '', [switch]$Interactive)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $db = $Config.Database
  if ($db.Mode -eq 'Container') {
    $psi.FileName = 'docker'
    $i = if ($Interactive) { '-i ' } else { '' }
    $psi.Arguments = "exec $i$($db.Container) $Tool -U $($db.User) $Arguments"
  } else {
    $pw = [Environment]::GetEnvironmentVariable([string]$db.PasswordEnv)
    if (-not $pw) { throw "Environment variable $($db.PasswordEnv) (Database.PasswordEnv) is not set." }
    $psi.FileName = Join-Path $db.PgBin "$Tool.exe"
    $psi.Arguments = $Arguments
    $psi.EnvironmentVariables['PGHOST'] = [string]$db.Host
    $psi.EnvironmentVariables['PGPORT'] = [string]$db.Port
    $psi.EnvironmentVariables['PGUSER'] = [string]$db.User
    $psi.EnvironmentVariables['PGPASSWORD'] = $pw
  }
  $psi.UseShellExecute = $false
  return $psi
}

<# Runs a client tool to its end; throws with its error output (never the environment) when it fails. #>
function Invoke-DrishtiPgTool {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Tool, [string]$Arguments = '', [switch]$DryRun)
  if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would run: $Tool $Arguments"; return }
  $psi = New-DrishtiPgStartInfo -Config $Config -Tool $Tool -Arguments $Arguments
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "$Tool failed ($($p.ExitCode)): $($err.Result.Trim())" }
  return $out.Result
}

function Open-DrishtiPsql {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Database)
  Test-DrishtiDbName -Name $Database
  $psi = New-DrishtiPgStartInfo -Config $Config -Tool psql -Arguments "-d $Database -At -q -v ON_ERROR_STOP=1" -Interactive
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $session = [pscustomobject]@{ Process = $proc }
  $session | Add-Member -MemberType ScriptMethod -Name Query -Value {
    param([string]$Sql)
    $this.Process.StandardInput.WriteLine($Sql)
    $this.Process.StandardInput.WriteLine('\echo __DRISHTI_END__')
    $this.Process.StandardInput.Flush()
    $out = New-Object System.Collections.Generic.List[string]
    while ($true) {
      $line = $this.Process.StandardOutput.ReadLine()
      if ($null -eq $line) { throw "psql ended: $($this.Process.StandardError.ReadToEnd())" }
      if ($line -eq '__DRISHTI_END__') { break }
      $out.Add($line)
    }
    return ,$out.ToArray()
  }
  $session | Add-Member -MemberType ScriptMethod -Name Close -Value {
    try { $this.Process.StandardInput.WriteLine('\q'); $this.Process.StandardInput.Close() } catch { }
    if (-not $this.Process.WaitForExit(15000)) { $this.Process.Kill() }
  }
  return $session
}

<# One query, one session. #>
function Invoke-DrishtiSql {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Database, [Parameter(Mandatory)][string]$Sql)
  $s = Open-DrishtiPsql -Config $Config -Database $Database
  try { return ,$s.Query($Sql) } finally { $s.Close() }
}

function Get-DrishtiCountSql {
  $parts = foreach ($t in $script:DrishtiCountTables) { "SELECT '$t', count(*) FROM $t" }
  return (($parts -join ' UNION ALL ') + ';')
}

function ConvertFrom-DrishtiCounts {
  param([string[]]$Lines)
  $h = [ordered]@{}
  foreach ($l in $Lines) {
    $p = $l.Split('|')
    if ($p.Count -eq 2) { $h[$p[0]] = [int64]$p[1] }
  }
  return $h
}

function Get-DrishtiFileSha256 {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<# The SHA-256 of the Vault root key the database server uses now (never the key itself), or $null when it cannot be reached from here. #>
function Get-DrishtiVaultKeyHash {
  param([Parameter(Mandatory)]$Config)
  $vk = if ($Config.ContainsKey('VaultKey')) { $Config.VaultKey } else { $null }
  if (-not $vk -or $vk.Mode -eq 'None') { return $null }
  if ($vk.Mode -eq 'ContainerFile') {
    $h = & docker exec $Config.Database.Container sh -c "sha256sum '$($vk.Path)' | cut -d ' ' -f 1"
    if ($LASTEXITCODE -ne 0) { throw 'The Vault root key could not be read in the database container.' }
    return ([string]$h).Trim().ToLowerInvariant()
  }
  return Get-DrishtiFileSha256 -Path $vk.Path
}

<# The highest migration number of a release (its supabase\migrations folder), or $null. #>
function Get-DrishtiExpectedMigration {
  param([Parameter(Mandatory)][string]$SourcePath)
  $dir = Join-Path $SourcePath 'supabase\migrations'
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $m = Get-ChildItem -LiteralPath $dir -Filter '*.sql' | Where-Object { $_.Name -match '^\d{14}_' } | ForEach-Object { $_.Name.Substring(0, 14) } | Sort-Object | Select-Object -Last 1
  return $m
}

# ── Access control (review C-2, I-6, I-7, M-11) ───────────────────────────────
# Well-known SIDs, never the localised names ("Administrators" is "Administratoren" on a German Windows).
$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'
$script:SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:SidCreatorOwner = 'S-1-3-0'

function Test-DrishtiAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
  The person running the script, but only when they are NOT elevated (a test run under the system temp folder): an elevated
  administrator is covered by the Administrators entry, and production never gives a person's own account any right.
#>
function Get-DrishtiOperatorGrant {
  if (Test-DrishtiAdministrator) { return @() }
  return @('*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
}

<#
  Locks a file or folder: inherited entries removed; SYSTEM and Administrators full; the non-elevated operator (tests only, see above);
  plus the given accounts (read, read and execute for folders, or modify). Creates a missing folder first, BEFORE anything is written
  into it (review C-2, I-3), so nothing ever exists there with the drive's inherited ACL.
#>
function Set-DrishtiAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$ReadAccounts = @(), [string[]]$ModifyAccounts = @(), [switch]$IsFile, [switch]$DryRun)
  $leaf = $IsFile -or (Test-Path -LiteralPath $Path -PathType Leaf)
  if (-not $leaf -and -not (Test-Path -LiteralPath $Path)) {
    if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would create $Path" } else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
  }
  $inh = if ($leaf) { '' } else { '(OI)(CI)' }
  $icaclsArgs = @($Path, '/inheritance:r', '/grant:r', "*$($script:SidSystem):$($inh)F", '/grant:r', "*$($script:SidAdmins):$($inh)F")
  foreach ($o in (Get-DrishtiOperatorGrant)) { $icaclsArgs += @('/grant:r', "$($o):$($inh)F") }
  foreach ($a in $ReadAccounts) { $icaclsArgs += @('/grant:r', $(if ($leaf) { "${a}:R" } else { "${a}:(OI)(CI)RX" })) }
  foreach ($a in $ModifyAccounts) { $icaclsArgs += @('/grant:r', $(if ($leaf) { "${a}:M" } else { "${a}:(OI)(CI)M" })) }
  Invoke-DrishtiCommand -FilePath 'icacls.exe' -ArgumentList $icaclsArgs -DryRun:$DryRun
}

<#
  Review C-2: what the installation's folders must look like. One entry per path: Lock = inheritance removed, SYSTEM and Administrators
  only (then the listed accounts); Grant = an extra entry added to an already locked (inherited) path. Every folder is created before
  anything is granted on it. Pure: no side effect (tests/unit/windows-scripts.test.ts reads it through -Action Install -WhatIf).
#>
function Get-DrishtiAclPlan {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Definitions)
  $plan = New-Object System.Collections.Generic.List[object]
  $add = { param($Path, $Kind, $Mode, $Read, $Modify) $plan.Add([pscustomobject]@{ Path = $Path; Kind = $Kind; Mode = $Mode; Read = @($Read); Modify = @($Modify) }) }
  $accounts = @{}
  foreach ($d in $Definitions) { $accounts[$d.Name] = Get-DrishtiServiceAccount -Config $Config -Name $d.Name }
  $node = @($Definitions | Where-Object { $_.Name -ne 'DrishtiGo2rtc' } | ForEach-Object { $accounts[$_.Name] })
  $all = @($Definitions | ForEach-Object { $accounts[$_.Name] })
  $root = $Config.InstallRoot
  & $add $root 'Folder' 'Lock' @() @()
  & $add (Join-Path $root 'bin') 'Folder' 'Lock' $all @()
  & $add (Join-Path $root 'services') 'Folder' 'Lock' @() @()
  & $add (Join-Path $root 'scripts') 'Folder' 'Lock' @() @()
  & $add (Join-Path $root 'app') 'Folder' 'Lock' $node @()
  & $add $Config.ConfigDir 'Folder' 'Lock' @() @()
  & $add $Config.DataDir 'Folder' 'Lock' @() @()
  & $add $Config.LogDir 'Folder' 'Lock' @() @()
  foreach ($d in $Definitions) { & $add (Join-Path $Config.LogDir $d.Name) 'Folder' 'Lock' @() @($accounts[$d.Name]) }
  & $add $Config.BackupDir 'Folder' 'Lock' @() @()
  if ($Config.ContainsKey('VaultKey') -and $Config.VaultKey -and $Config.VaultKey.KeyBackupDir) { & $add $Config.VaultKey.KeyBackupDir 'Folder' 'Lock' @() @() }
  $go = @($Definitions | Where-Object { $_.Name -eq 'DrishtiGo2rtc' })
  if ($go.Count -gt 0 -and $Config.Go2rtcExe) { & $add (Split-Path -Parent $Config.Go2rtcExe) 'Folder' 'Lock' @($accounts['DrishtiGo2rtc']) @() }
  return $plan.ToArray()
}

<#
  Review C-2: which entries of an ACL give write access (write, append, create, delete, change permissions, take ownership; on their
  own or inside Modify / FullControl) to anybody but SYSTEM, the Administrators, TrustedInstaller, CREATOR OWNER and the accounts the
  path is meant for. Input: objects with Sid, Rights ([Security.AccessControl.FileSystemRights] or its name) and Type (Allow/Deny).
  Pure (tested with synthetic entries).
#>
function Find-DrishtiAclProblems {
  param([object[]]$Rules = @(), [string[]]$AllowedSids = @())
  # Plus GENERIC_ALL (0x10000000) and GENERIC_WRITE (0x40000000): inherit-only entries such as C:\'s "Authenticated Users: M" carry them.
  $mask = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership') -bor 0x10000000 -bor 0x40000000
  $trusted = @($script:SidSystem, $script:SidAdmins, $script:SidTrustedInstaller, $script:SidCreatorOwner) + $AllowedSids
  $out = @()
  foreach ($r in $Rules) {
    if ([string]$r.Type -ne 'Allow') { continue }
    $rights = if ($r.Rights -is [int] -or $r.Rights -is [long]) { [int]$r.Rights } else { [int]([Security.AccessControl.FileSystemRights]$r.Rights) }
    if (($rights -band $mask) -eq 0) { continue }
    if ($trusted -contains [string]$r.Sid) { continue }
    $out += "$($r.Sid) may write (rights 0x$('{0:X8}' -f $rights))"
  }
  return $out
}

<# The write problems of one existing path (Get-Acl). Accounts: names or SIDs the path is meant for (for example its log folder's). #>
function Test-DrishtiPathAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedAccounts = @())
  if (-not (Test-Path -LiteralPath $Path)) { return "$Path is missing" }
  $sids = @()
  foreach ($a in $AllowedAccounts) {
    try { $sids += if ($a.StartsWith('*')) { $a.Substring(1) } else { (New-Object Security.Principal.NTAccount($a)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { }
  }
  foreach ($o in (Get-DrishtiOperatorGrant)) { $sids += $o.Substring(1) }
  $rules = @((Get-Acl -LiteralPath $Path).Access | ForEach-Object {
    $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
    [pscustomobject]@{ Sid = $sid; Rights = $_.FileSystemRights; Type = [string]$_.AccessControlType }
  })
  return @(Find-DrishtiAclProblems -Rules $rules -AllowedSids $sids | ForEach-Object { "${Path}: $_" })
}

<#
  Review C-2: refuse to run on a configuration or scripts folder that others may change (a SYSTEM task or an administrator would run
  what they put there). The scripts folder is checked when it is the installed copy (under InstallRoot); a checkout elsewhere is the
  operator's own working copy and only warned about.
#>
function Assert-DrishtiSafeToRun {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][string]$ScriptRoot)
  $problems = @(Test-DrishtiPathAcl -Path $ConfigPath)
  $installed = $ScriptRoot.StartsWith([IO.Path]::GetFullPath($Config.InstallRoot), [StringComparison]::OrdinalIgnoreCase)
  $scriptProblems = @(Test-DrishtiPathAcl -Path $ScriptRoot)
  if ($installed) { $problems += $scriptProblems }
  elseif ($scriptProblems.Count -gt 0) { Write-DrishtiStep -Kind warn -Message "these scripts run from $ScriptRoot, which others may change; production runs them from $(Join-Path $Config.InstallRoot 'scripts')" }
  if ($problems.Count -gt 0) { throw "Refused: others may change what this script runs or reads ($($problems -join '; ')). Run drishti-services.ps1 -Action RepairAcl as an administrator." }
}

<# Review I-6: true when the path or anything below it is a junction or symbolic link (never followed: GetFileSystemEntries per level). #>
function Test-DrishtiHasReparsePoint {
  param([Parameter(Mandatory)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $true }
  if (-not $item.PSIsContainer) { return $false }
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($item.FullName)
  while ($stack.Count -gt 0) {
    foreach ($e in [IO.Directory]::GetFileSystemEntries($stack.Pop())) {
      $a = [IO.File]::GetAttributes($e)
      if ($a -band [IO.FileAttributes]::ReparsePoint) { return $true }
      if ($a -band [IO.FileAttributes]::Directory) { $stack.Push($e) }
    }
  }
  return $false
}

<#
  Review M-1: one update or live restore at a time. A lock file opened without sharing in InstallRoot, held until Close(); a second run
  is refused with a plain line.
#>
function Enter-DrishtiLock {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$What)
  $path = Join-Path $Config.InstallRoot 'drishti.lock'
  if (-not (Test-Path -LiteralPath $Config.InstallRoot)) { New-Item -ItemType Directory -Force -Path $Config.InstallRoot | Out-Null }
  try {
    $fs = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw "Another update or restore is running ($path is held). Wait for it to finish; nothing was changed."
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes("$What by $([Security.Principal.WindowsIdentity]::GetCurrent().Name), process $PID, $((Get-Date).ToString('o'))")
  $fs.SetLength(0); $fs.Write($bytes, 0, $bytes.Length); $fs.Flush()
  return $fs
}

<# Polls the public health and the version until the build answers "ok" (or the time is up). Returns $true / $false. #>
function Wait-DrishtiHealthy {
  param([Parameter(Mandatory)]$Config, [string]$BuildId, [int]$TimeoutSec = 180, [switch]$DryRun)
  $health = if ($Config.ContainsKey('HealthUrl')) { $Config.HealthUrl } else { 'http://127.0.0.1:3212/api/health' }
  $version = if ($Config.ContainsKey('VersionUrl')) { $Config.VersionUrl } else { 'http://127.0.0.1:3212/api/version' }
  if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would wait up to $TimeoutSec s for $version = $BuildId and $health = ok"; return $true }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $v = Invoke-RestMethod -Uri $version -TimeoutSec 5 -UseBasicParsing
      $h = Invoke-RestMethod -Uri $health -TimeoutSec 5 -UseBasicParsing
      if ((-not $BuildId -or $v.build -eq $BuildId) -and $h.status -eq 'ok') { Write-DrishtiStep -Kind ok -Message "healthy: build $($v.build)"; return $true }
    } catch { }
    Start-Sleep -Seconds 5
  }
  Write-DrishtiStep -Kind fail -Message "not healthy within $TimeoutSec s (see the Health page and the service logs under $($Config.LogDir))"
  return $false
}
