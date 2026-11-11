# CityKart Drishti: shared helpers of the Windows deployment scripts (P5.4). Dot-sourced by drishti-services.ps1, update.ps1,
# backup.ps1 and restore.ps1. Windows PowerShell 5.1 compatible. Nothing here prints a secret: database connection strings come from
# an environment variable that is NAMED in the configuration (never stored in it), and no env-file value is ever echoed.

Set-StrictMode -Version 2.0

$script:DrishtiServiceNames = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb', 'DrishtiProxy')
# Stop the services people use first (no new video while the rest goes down), then the worker; go2rtc last. Start in reverse. The
# TLS proxy (Caddy, final review C-I12) is the door: stopped first, started last.
$script:DrishtiStopOrder = @('DrishtiProxy', 'DrishtiWeb', 'DrishtiGateway', 'DrishtiWorker', 'DrishtiGo2rtc')
$script:DrishtiStartOrder = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb', 'DrishtiProxy')
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
  # Final review C-I12: Caddy, the one listener on the network (runbook-tls.md), as a service too, from CaddyExe. Its Caddyfile and
  # certificates live in the locked ConfigDir (read by its account only), its own data (Caddy's storage) in DataDir\caddy (written by
  # its account only), its output in its log folder like every other service.
  if ($Config.ContainsKey('CaddyExe') -and $Config.CaddyExe) {
    $defs += [pscustomobject]@{ Name = 'DrishtiProxy'; Display = 'CityKart Drishti TLS proxy (Caddy)'; Exe = [string]$Config.CaddyExe
      Args = @('run', '--config', (Join-Path $Config.ConfigDir 'Caddyfile'), '--adapter', 'caddyfile')
      WorkDir = (Join-Path $Config.DataDir 'caddy'); EnvFile = (Join-Path $Config.ConfigDir 'proxy.env'); StopTimeoutSec = 10; DependsOn = @() }
  }
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
    $psi.FileName = Get-DrishtiTool -Config $Config -Name docker
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

<#
  Fix round 2 (re-review N-2): the test fixture switch of a database (migration 0044) and its production mark (0046). Returns
  @{ Exists; On; Production; CanMark }. A database without the table (older than 0044) has no switch: it cannot be on.
#>
function Get-DrishtiFixtureSwitch {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Database)
  $sql = "SELECT CASE WHEN pg_catalog.to_regclass('public.test_fixture_switch') IS NULL THEN 'none' ELSE (SELECT t.honoured::text || ',' || coalesce(pg_catalog.to_jsonb(t) ->> 'production', 'nocolumn') FROM public.test_fixture_switch t WHERE t.id) END;"
  $v = [string](Invoke-DrishtiSql -Config $Config -Database $Database -Sql $sql)[0]
  if ($v -eq 'none' -or -not $v) { return @{ Exists = $false; On = $false; Production = $false; CanMark = $false } }
  $p = $v.Split(',')
  return @{ Exists = $true; On = ($p[0] -eq 'true'); Production = ($p[1] -eq 'true'); CanMark = ($p[1] -ne 'nocolumn') }
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
    $docker = Get-DrishtiTool -Config $Config -Name docker
    $h = & $docker exec $Config.Database.Container sh -c "sha256sum '$($vk.Path)' | cut -d ' ' -f 1"
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

# ── Access control (review C-2, I-6, I-7, M-11; fix round 2: N-1, M-4, M-new-2, M-new-6) ─────────────────────
# Well-known SIDs, never the localised names ("Administrators" is "Administratoren" on a German Windows).
$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'
$script:SidTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:SidCreatorOwner = 'S-1-3-0'
# Review M-new-6: the Windows tools by their full path (a nightly SYSTEM task never takes one from a folder earlier on PATH).
$script:Sys32 = Join-Path $env:SystemRoot 'System32'
$script:IcaclsExe = Join-Path $script:Sys32 'icacls.exe'
$script:TakeownExe = Join-Path $script:Sys32 'takeown.exe'
$script:RobocopyExe = Join-Path $script:Sys32 'robocopy.exe'
$script:CmdExe = Join-Path $script:Sys32 'cmd.exe'
$script:ScExe = Join-Path $script:Sys32 'sc.exe'
$script:PowerShellExe = Join-Path $script:Sys32 'WindowsPowerShell\v1.0\powershell.exe'

<# The programs that are not part of Windows: docker, git, npm and npx, from the configuration (DockerExe, GitExe; npm next to NodeExe). #>
function Get-DrishtiTool {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][ValidateSet('docker', 'git', 'npm', 'npx')][string]$Name)
  switch ($Name) {
    # Review 2 nit: never a docker or git found on PATH (the nightly task runs as SYSTEM): configured by full path, or refused.
    'docker' { if ($Config.ContainsKey('DockerExe') -and $Config.DockerExe) { return [string]$Config.DockerExe } else { throw "DockerExe is not set in the configuration: give the full path of docker.exe (for example C:\Program Files\Docker\Docker\resources\bin\docker.exe)." } }
    'git' { if ($Config.ContainsKey('GitExe') -and $Config.GitExe) { return [string]$Config.GitExe } else { throw "GitExe is not set in the configuration: give the full path of git.exe, or pass -BuildId." } }
    default { return (Join-Path (Split-Path -Parent $Config.NodeExe) "$Name.cmd") }
  }
}

function Test-DrishtiAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
  The person running the script, but only when they are NOT elevated (a test run under the system temp folder): an elevated
  administrator is covered by the Administrators entry, and production never gives a person's own account any right. The Audit never
  trusts it (review M-new-2).
#>
function Get-DrishtiOperatorGrant {
  if (Test-DrishtiAdministrator) { return @() }
  if ($env:DRISHTI_ACL_TEST_NO_OPERATOR -eq '1') { return @() } # tests only: proves what the service accounts alone may do
  return @('*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
}

<#
  The SID of a service's virtual account NT SERVICE<name>, computed as Windows does (S-1-5-80- and the SHA-1 of the upper-case name
  in UTF-16, as five numbers; what `sc.exe showsid` prints). It exists before the service does, so the install can lock the folders
  before it creates the services (fix round 2: the name alone cannot be resolved until the service exists).
#>
function Get-DrishtiServiceSid {
  param([Parameter(Mandatory)][string]$ServiceName)
  $sha = [Security.Cryptography.SHA1]::Create()
  try { $h = $sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($ServiceName.ToUpperInvariant())) } finally { $sha.Dispose() }
  $parts = for ($i = 0; $i -lt 20; $i += 4) { [BitConverter]::ToUInt32($h, $i) }
  return 'S-1-5-80-' + ($parts -join '-')
}

function ConvertTo-DrishtiSid {
  param([Parameter(Mandatory)][string]$Account)
  if ($Account.StartsWith('*')) { return $Account.Substring(1) }
  if ($Account -match '^S-1-[0-9-]+$') { return $Account }
  if ($Account -match '^NT SERVICE\\(.+)$') { return Get-DrishtiServiceSid -ServiceName $Matches[1] }
  return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

# The rights of each kind of entry, for a file and for a folder. List: read the attributes and wait on the folder, nothing below it:
# enough for the free space of its disk (statfs / GetDiskFreeSpace, review M-4), not to see what is in it.
function Get-DrishtiRights {
  param([Parameter(Mandatory)][ValidateSet('Full', 'Read', 'Modify', 'List')][string]$Kind, [switch]$Leaf)
  switch ($Kind) {
    'Full' { return [Security.AccessControl.FileSystemRights]::FullControl }
    'Read' { if ($Leaf) { return [Security.AccessControl.FileSystemRights]'Read, Synchronize' } else { return [Security.AccessControl.FileSystemRights]'ReadAndExecute, Synchronize' } }
    'Modify' { return [Security.AccessControl.FileSystemRights]'Modify, Synchronize' }
    'List' { return [Security.AccessControl.FileSystemRights]'ReadAttributes, Synchronize' }
  }
}

<# How an entry is shown in a plan: icacls' own notation, so a reader can compare it with `icacls <path>`. #>
function Format-DrishtiEntry {
  param([string]$Account, [string]$Kind, [switch]$Leaf)
  $inh = if ($Leaf -or $Kind -eq 'List') { '' } else { '(OI)(CI)' }
  $r = switch ($Kind) { 'Full' { 'F' } 'Read' { if ($Leaf) { 'R' } else { 'RX' } } 'Modify' { 'M' } 'List' { '(RA,S)' } }
  return "${Account}:$inh$r"
}

<#
  Fix round 3 (re-review 2 N-3): the walk below a folder. It never follows a junction, symbolic link or other reparse point, never
  changes a file that has more than one name (a hard link could be another file anywhere on the volume), and gives every other item
  the Administrators as owner (when elevated) and no access entry of its own (it inherits the folder's). It is split in three:
    - Get-DrishtiTreeEntries reads the tree (nothing is changed; .NET directory listing, one level at a time, never through a link);
    - Get-DrishtiTreeProblems and Test-DrishtiNeedsReset decide, on plain data only (unit-tested with made-up entries,
      tests/unit/windows-scripts.test.ts; the real file system is exercised by the lab suite, tests/windows-lab);
    - Reset-DrishtiTreeItems changes only what the decision says.
  Elevated, the restore, take-ownership and backup privileges are switched on first (a small C# helper compiled only then: never in a
  normal prompt, never in the default tests), so an item's own rules cannot keep the Administrators out; no takeown, no /D answer in
  the Windows language (review 2 m2).
#>
$script:DrishtiPrivilegeSource = @'
using System;
using System.Runtime.InteropServices;

public static class DrishtiPrivilege {
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES state, uint length, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

  /** Switches one privilege of this process on; false when the token does not hold it (not elevated). */
  public static bool Enable(string name) {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out token)) return false;
    try {
      LUID luid;
      if (!LookupPrivilegeValue(null, name, out luid)) return false;
      TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
      tp.Count = 1; tp.Luid = luid; tp.Attributes = 0x00000002;
      if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return false;
      return Marshal.GetLastWin32Error() == 0;
    } finally { CloseHandle(token); }
  }
}
'@

function Enable-DrishtiAclPrivileges {
  if (-not ('DrishtiPrivilege' -as [type])) { Add-Type -TypeDefinition $script:DrishtiPrivilegeSource -Language CSharp }
  foreach ($p in @('SeRestorePrivilege', 'SeTakeOwnershipPrivilege', 'SeBackupPrivilege')) {
    if (-not [DrishtiPrivilege]::Enable($p)) { throw "Could not switch on $p for this process (an elevated Administrator holds it)." }
  }
}

<# Whether a file has more than one name (Windows PowerShell's own LinkType says 'HardLink' then). #>
function Test-DrishtiHardLink {
  param([Parameter(Mandatory)][string]$Path)
  try { return ([string](Get-Item -LiteralPath $Path -Force).LinkType -eq 'HardLink') } catch { return $false }
}

<#
  Everything below a folder (not the folder itself), read only, depth first, NEVER through a reparse point: one record per item with
  Path, IsDirectory, IsReparse, IsHardLink, Error. A reparse point is listed and not entered.
#>
function Get-DrishtiTreeEntries {
  param([Parameter(Mandatory)][string]$Path)
  $out = New-Object System.Collections.Generic.List[object]
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push([IO.Path]::GetFullPath($Path))
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    $entries = $null
    try { $entries = [IO.Directory]::GetFileSystemEntries($dir) } catch { $out.Add([pscustomobject]@{ Path = $dir; IsDirectory = $true; IsReparse = $false; IsHardLink = $false; Error = "cannot be read ($($_.Exception.InnerException.Message))" }); continue }
    foreach ($e in $entries) {
      $a = $null
      try { $a = [IO.File]::GetAttributes($e) } catch { $out.Add([pscustomobject]@{ Path = $e; IsDirectory = $false; IsReparse = $false; IsHardLink = $false; Error = 'cannot be read' }); continue }
      $isReparse = [bool]($a -band [IO.FileAttributes]::ReparsePoint)
      $isDir = [bool]($a -band [IO.FileAttributes]::Directory)
      $hard = (-not $isReparse) -and (-not $isDir) -and (Test-DrishtiHardLink -Path $e)
      $out.Add([pscustomobject]@{ Path = $e; IsDirectory = $isDir; IsReparse = $isReparse; IsHardLink = $hard; Error = $null })
      if ($isDir -and -not $isReparse) { $stack.Push($e) }
    }
  }
  return $out.ToArray()
}

<#
  Pure: what refuses a lock in a tree's records (Get-DrishtiTreeEntries). A link other than the checked ones; a file with more than
  one name; an item that could not be read. Plain strings, one per problem.
#>
function Get-DrishtiTreeProblems {
  param([object[]]$Entries = @(), [string[]]$AllowedLinks = @())
  $allowed = @($AllowedLinks | ForEach-Object { ([string]$_).TrimEnd('\').ToLowerInvariant() })
  $out = @()
  foreach ($e in $Entries) {
    if ($e.Error) { $out += "$($e.Path): $($e.Error)"; continue }
    if ($e.IsReparse) {
      if ($allowed -notcontains ([string]$e.Path).TrimEnd('\').ToLowerInvariant()) { $out += "$($e.Path): a junction or link the installation did not make (not followed)" }
      continue
    }
    if ($e.IsHardLink) { $out += "$($e.Path): has more than one name, a hard link (not changed)" }
  }
  return $out
}

<# Pure: an item needs its rules reset when it has an entry of its own, a protected list, or (when an owner is wanted) another owner. #>
function Test-DrishtiNeedsReset {
  param([int]$ExplicitRules, [bool]$Protected, [string]$Owner, [string]$WantedOwner)
  if ($ExplicitRules -gt 0 -or $Protected) { return $true }
  if ($WantedOwner -and $Owner -ne $WantedOwner) { return $true }
  return $false
}

<# Pure: whether the owner of an item that existed already is one the installation trusts (SYSTEM, Administrators, TrustedInstaller; the non-elevated operator in tests). #>
function Test-DrishtiTrustedOwner {
  param([string]$Owner, [string[]]$Operator = @())
  return (@($script:SidSystem, $script:SidAdmins, $script:SidTrustedInstaller) + $Operator) -contains $Owner
}

<# Changes the items of a tree that need it (never a link, never a hard link: those refused before). #>
function Reset-DrishtiTreeItems {
  param([object[]]$Entries = @(), [string]$OwnerSid)
  $owner = if ($OwnerSid) { New-Object Security.Principal.SecurityIdentifier($OwnerSid) } else { $null }
  $problems = @()
  foreach ($e in $Entries) {
    if ($e.IsReparse -or $e.IsHardLink -or $e.Error) { continue }
    try {
      $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
      $cur = if ($e.IsDirectory) { [IO.Directory]::GetAccessControl($e.Path, $sections) } else { [IO.File]::GetAccessControl($e.Path, $sections) }
      $explicit = @($cur.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count
      $curOwner = try { $cur.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { '' }
      if (-not (Test-DrishtiNeedsReset -ExplicitRules $explicit -Protected $cur.AreAccessRulesProtected -Owner $curOwner -WantedOwner $OwnerSid)) { continue }
    } catch { }
    try {
      $s = if ($e.IsDirectory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
      $s.SetAccessRuleProtection($false, $false)
      if ($owner) { $s.SetOwner($owner) }
      if ($e.IsDirectory) { [IO.Directory]::SetAccessControl($e.Path, $s) } else { [IO.File]::SetAccessControl($e.Path, $s) }
    } catch { $problems += "$($e.Path): $($_.Exception.InnerException.Message)" }
  }
  return $problems
}

<#
  Pure: is a link the junction update.ps1 makes? A junction whose target is a folder directly under the releases folder (and that
  target exists and is not itself a link: checked by the caller and passed in).
#>
function Test-DrishtiReleaseLink {
  param([bool]$IsJunction, [string]$Target, [string]$ReleasesDir, [bool]$TargetIsPlainFolder)
  if (-not $IsJunction -or -not $Target -or -not $TargetIsPlainFolder) { return $false }
  $t = $Target
  if ($t.StartsWith('\??\')) { $t = $t.Substring(4) }
  $full = [IO.Path]::GetFullPath($t).TrimEnd('\')
  return ([IO.Path]::GetDirectoryName($full) -ieq ([IO.Path]::GetFullPath($ReleasesDir).TrimEnd('\')))
}

<#
  The only link the installation makes is <InstallRoot>\app\current, a junction to one release under <InstallRoot>\app\releases
  (update.ps1). It is trusted only when it is exactly that. Anything else is refused (review 2 N-3: a user could plant it pointing at
  C:\ before the install). Returns the release folder it points at, or $null when there is no link.
#>
function Get-DrishtiCurrentRelease {
  param([Parameter(Mandatory)][string]$InstallRoot)
  $link = Join-Path $InstallRoot 'app\current'
  $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  $releases = Join-Path $InstallRoot 'app\releases'
  $target = [string](@($item.Target) | Select-Object -First 1)
  if ($target.StartsWith('\??\')) { $target = $target.Substring(4) }
  $plain = $false
  if ($target) {
    try { $plain = [IO.Directory]::Exists($target) -and -not ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) } catch { $plain = $false }
  }
  $isJunction = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [string]$item.LinkType -eq 'Junction'
  if (-not (Test-DrishtiReleaseLink -IsJunction $isJunction -Target $target -ReleasesDir $releases -TargetIsPlainFolder $plain)) {
    throw "Refused: $link is not the junction update.ps1 makes (to a release in $releases); somebody else may have made it. Look at it, remove the link itself (cmd /c rmdir `"$link`", which never touches its target), and run this again."
  }
  return [IO.Path]::GetFullPath($target).TrimEnd('\')
}

<#
  Review N-1 and review 2 N-3: makes a file or folder carry EXACTLY the given entries, whatever was there before, without ever following
  a link:
    - a path that exists is REFUSED when it is itself a link, or when its owner is not SYSTEM, the Administrators or TrustedInstaller
      (a folder somebody else made before the install: look at it first); a missing folder is created first (review C-2, I-3);
    - everything below an existing folder is read first, never through a link: a link other than the checked app\current junction, or
      a file with more than one name, REFUSES the lock before anything is changed;
    - the item itself is locked FIRST, in one call: the Administrators as owner (elevated), no inherited entry, no entry of anybody
      else; SYSTEM and Administrators full, the non-elevated operator (tests only), then the given accounts;
    - only then the items below are reset (owner, no entry of their own: they inherit the new list). The plan then locks the
      sub-folders and files that need their own entries (parents before children).
#>
function Set-DrishtiAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$ReadAccounts = @(), [string[]]$ModifyAccounts = @(), [string[]]$ListAccounts = @(), [string[]]$AllowedLinks = @(), [string]$InstallRoot = '', [switch]$IsFile, [switch]$DryRun)
  $leaf = $IsFile -or (Test-Path -LiteralPath $Path -PathType Leaf)
  $exists = Test-Path -LiteralPath $Path
  $admin = Test-DrishtiAdministrator
  $entries = New-Object System.Collections.Generic.List[object]
  $entries.Add(@(('*' + $script:SidSystem), 'Full'))
  $entries.Add(@(('*' + $script:SidAdmins), 'Full'))
  foreach ($o in (Get-DrishtiOperatorGrant)) { $entries.Add(@($o, 'Full')) }
  foreach ($a in $ReadAccounts) { $entries.Add(@($a, 'Read')) }
  foreach ($a in $ModifyAccounts) { $entries.Add(@($a, 'Modify')) }
  foreach ($a in $ListAccounts) { $entries.Add(@($a, 'List')) }
  $shown = ($entries | ForEach-Object { Format-DrishtiEntry -Account $_[0] -Kind $_[1] -Leaf:$leaf }) -join ' '
  $owner = if ($admin) { 'owner Administrators' } else { 'owner unchanged (not elevated)' }
  if ($DryRun) {
    if (-not $leaf -and -not $exists) { Write-DrishtiStep -Kind plan -Message "would create $Path" }
    $below = if ($leaf) { '' } else { '; then everything below it walked without following any link (a link or hard link refuses)' }
    Write-DrishtiStep -Kind plan -Message "would lock ${Path}: $owner; every other entry removed, nothing inherited; only $shown$below"
    return
  }

  $tree = @()
  if ($exists) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refused: $Path is a junction or link, not a folder or file the installation made. Look at it, remove it, and run this again." }
    $current = $null
    try { $current = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $current = '(unreadable)' }
    if (-not (Test-DrishtiTrustedOwner -Owner $current -Operator @(Get-DrishtiOperatorGrant | ForEach-Object { $_.Substring(1) }))) {
      throw "Refused: $Path existed already and belongs to $current, not to SYSTEM or the Administrators: somebody may have made it before the install. Look at what is in it, remove it (or, once you are sure of it, take it over: takeown /F `"$Path`" /A), and run this again."
    }
    if ($leaf) {
      if (Test-DrishtiHardLink -Path $Path) { throw "Refused: $Path has more than one name (a hard link): it may be another file. Look at it, remove it, and run this again." }
    } else {
      # The one link the installation makes, checked before anything is done (review 2 N-3).
      $links = @()
      if ($InstallRoot) {
        foreach ($l in $AllowedLinks) {
          $full = [IO.Path]::GetFullPath($l).TrimEnd('\')
          if (-not $full.StartsWith([IO.Path]::GetFullPath($Path).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
          if (Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue) { $null = Get-DrishtiCurrentRelease -InstallRoot $InstallRoot; $links += $full }
        }
      }
      if ($admin) { Enable-DrishtiAclPrivileges }
      $tree = @(Get-DrishtiTreeEntries -Path $Path)
      $found = @(Get-DrishtiTreeProblems -Entries $tree -AllowedLinks $links)
      if ($found.Count -gt 0) { throw "Refused below $Path (nothing was changed; nothing was followed): $($found -join '; '). Look at each one, remove it, and run this again." }
    }
  } elseif (-not $leaf) {
    New-Item -ItemType Directory -Path $Path | Out-Null # new and empty: nothing below it to walk
  }
  if ($admin -and $leaf) { Enable-DrishtiAclPrivileges }
  $sec = if ($leaf) { New-Object Security.AccessControl.FileSecurity } else { New-Object Security.AccessControl.DirectorySecurity }
  $sec.SetAccessRuleProtection($true, $false)
  if ($admin) { $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier($script:SidAdmins))) }
  foreach ($e in $entries) {
    $sid = New-Object Security.Principal.SecurityIdentifier((ConvertTo-DrishtiSid -Account $e[0]))
    $inherit = if ($leaf -or $e[1] -eq 'List') { [Security.AccessControl.InheritanceFlags]::None } else { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, (Get-DrishtiRights -Kind $e[1] -Leaf:$leaf), $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
  }
  if ($leaf) { [IO.File]::SetAccessControl($Path, $sec) } else { [IO.Directory]::SetAccessControl($Path, $sec) }
  Write-DrishtiStep -Message "locked ${Path}: $shown"
  if ($tree.Count -gt 0) {
    $ownerSid = if ($admin) { $script:SidAdmins } else { $null }
    $problems = @(Reset-DrishtiTreeItems -Entries $tree -OwnerSid $ownerSid)
    if ($problems.Count -gt 0) { throw "Refused below $Path (the folder itself is locked; nothing was followed): $($problems -join '; '). Look at each one, and run this again." }
  }
}

<#
  Review C-2: what the installation's folders must look like. One entry per path, parents before children (Set-DrishtiAcl resets what
  is below a folder). Read: read and run; Modify: the service's own log folder; List (review M-4): the web app may read the free space
  of the data and backup disks, nothing in them. Secret (review N-1): nobody but the plan's accounts may even read it. Pure: no side
  effect (tests/unit/windows-scripts.test.ts reads it through -Action Install -WhatIf).
#>
function Get-DrishtiAclPlan {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$Definitions)
  $plan = New-Object System.Collections.Generic.List[object]
  $links = @(Join-Path $Config.InstallRoot 'app\current') # the one junction the installation makes itself (update.ps1)
  $add = { param($Path, $Read, $Modify, $List, $Secret) $plan.Add([pscustomobject]@{ Path = $Path; Kind = 'Folder'; Mode = 'Lock'; Read = @($Read); Modify = @($Modify); List = @($List); Secret = [bool]$Secret; AllowedLinks = $links }) }
  $accounts = @{}
  foreach ($d in $Definitions) { $accounts[$d.Name] = Get-DrishtiServiceAccount -Config $Config -Name $d.Name }
  $node = @($Definitions | Where-Object { $_.Name -ne 'DrishtiGo2rtc' } | ForEach-Object { $accounts[$_.Name] })
  $all = @($Definitions | ForEach-Object { $accounts[$_.Name] })
  $web = @($Definitions | Where-Object { $_.Name -eq 'DrishtiWeb' } | ForEach-Object { $accounts[$_.Name] })
  $root = $Config.InstallRoot
  & $add $root @() @() @() $false
  & $add (Join-Path $root 'bin') $all @() @() $false
  & $add (Join-Path $root 'services') @() @() @() $false
  & $add (Join-Path $root 'scripts') @() @() @() $false
  & $add (Join-Path $root 'app') $node @() @() $false
  & $add $Config.ConfigDir @() @() @() $true
  & $add $Config.DataDir @() @() $web $true
  & $add $Config.LogDir @() @() @() $false
  foreach ($d in $Definitions) { & $add (Join-Path $Config.LogDir $d.Name) @() @($accounts[$d.Name]) @() $false }
  & $add $Config.BackupDir @() @() $web $true
  if ($Config.ContainsKey('VaultKey') -and $Config.VaultKey -and $Config.VaultKey.KeyBackupDir) { & $add $Config.VaultKey.KeyBackupDir @() @() @() $true }
  $go = @($Definitions | Where-Object { $_.Name -eq 'DrishtiGo2rtc' })
  if ($go.Count -gt 0 -and $Config.Go2rtcExe) { & $add (Split-Path -Parent $Config.Go2rtcExe) @($accounts['DrishtiGo2rtc']) @() @() $false }
  $proxy = @($Definitions | Where-Object { $_.Name -eq 'DrishtiProxy' })
  if ($proxy.Count -gt 0) {
    & $add (Split-Path -Parent $Config.CaddyExe) @($accounts['DrishtiProxy']) @() @() $false
    & $add (Join-Path $Config.ConfigDir 'certs') @($accounts['DrishtiProxy']) @() @() $true
    & $add (Join-Path $Config.DataDir 'caddy') @() @($accounts['DrishtiProxy']) @() $true
  }
  # A path below another one is locked after it (its reset would undo the child's own entries otherwise).
  $i = 0
  $ordered = @($plan.ToArray() | ForEach-Object { [pscustomobject]@{ Depth = ([IO.Path]::GetFullPath($_.Path).TrimEnd('\') -split '\\').Count; Index = $i++; Entry = $_ } } | Sort-Object Depth, Index | ForEach-Object { $_.Entry })
  return $ordered
}

<#
  Review C-2 and N-1: what is wrong with one ACL. Input: the owner SID and objects with Sid, Rights ([FileSystemRights], its name or a
  number) and Type (Allow/Deny). Problems:
    - an owner other than SYSTEM, the Administrators or TrustedInstaller (the owner may always change the rules);
    - an entry that gives write access (write, append, create, delete, change permissions, take ownership; on their own or inside
      Modify / FullControl / GENERIC_*) to anybody but SYSTEM, the Administrators, TrustedInstaller, CREATOR OWNER and -AllowedSids;
    - with -Secret: ANY allow entry (read included) for anybody else but -ReaderSids.
  Pure (tested with synthetic entries).
#>
function Find-DrishtiAclProblems {
  param([object[]]$Rules = @(), [string[]]$AllowedSids = @(), [string]$Owner = '', [switch]$Secret, [string[]]$ReaderSids = @(), [string[]]$TrustedOwners = @())
  # Plus GENERIC_ALL (0x10000000) and GENERIC_WRITE (0x40000000): inherit-only entries such as C:\'s "Authenticated Users: M" carry them.
  $mask = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership') -bor 0x10000000 -bor 0x40000000
  $base = @($script:SidSystem, $script:SidAdmins, $script:SidTrustedInstaller)
  $trusted = $base + @($script:SidCreatorOwner) + $AllowedSids
  $out = @()
  if ($Owner -and (($base + $TrustedOwners) -notcontains $Owner)) { $out += "the owner is $Owner, not SYSTEM, the Administrators or TrustedInstaller (an owner may always change the rules)" }
  foreach ($r in $Rules) {
    if ([string]$r.Type -ne 'Allow') { continue }
    $rights = if ($r.Rights -is [int] -or $r.Rights -is [long]) { [int]$r.Rights } else { [int]([Security.AccessControl.FileSystemRights]$r.Rights) }
    $sid = [string]$r.Sid
    if (($rights -band $mask) -ne 0 -and $trusted -notcontains $sid) { $out += "$sid may write (rights 0x$('{0:X8}' -f $rights))"; continue }
    if ($Secret -and ($trusted + $ReaderSids) -notcontains $sid) { $out += "$sid may read a secret (rights 0x$('{0:X8}' -f $rights))" }
  }
  return $out
}

<#
  The problems of one existing path. Write: accounts (names or *SIDs) that may write it (its log folder's service). Read: accounts that
  may read it when it is -Secret. -TrustOperator: the person running this when not elevated counts as trusted (tests, and the refusal
  of update/restore/backup on a test computer); the Audit never passes it (review M-new-2). An unreadable ACL is a problem of its own.
#>
function Test-DrishtiPathAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$AllowedAccounts = @(), [string[]]$ReadAccounts = @(), [switch]$Secret, [switch]$TrustOperator)
  if (-not (Test-Path -LiteralPath $Path)) { return "$Path is missing" }
  $toSids = { param($list) $s = @(); foreach ($a in $list) { try { $s += ConvertTo-DrishtiSid -Account $a } catch { } }; $s }
  $write = @(& $toSids $AllowedAccounts)
  $read = @(& $toSids $ReadAccounts)
  $owners = @()
  if ($TrustOperator) { foreach ($o in (Get-DrishtiOperatorGrant)) { $write += $o.Substring(1); $owners += $o.Substring(1) } }
  try { $acl = Get-Acl -LiteralPath $Path } catch { return "${Path}: its access rules cannot be read from here (run elevated)" }
  $owner = try { $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { '(unknown)' }
  $rules = @($acl.Access | ForEach-Object {
    $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
    [pscustomobject]@{ Sid = $sid; Rights = $_.FileSystemRights; Type = [string]$_.AccessControlType }
  })
  return @(Find-DrishtiAclProblems -Rules $rules -AllowedSids $write -Owner $owner -Secret:$Secret -ReaderSids $read -TrustedOwners $owners | ForEach-Object { "${Path}: $_" })
}

<#
  Review C-2: refuse to run on a configuration or scripts folder that others may change (a SYSTEM task or an administrator would run
  what they put there). The scripts folder is checked when it is the installed copy (under InstallRoot); a checkout elsewhere is the
  operator's own working copy and only warned about.
#>
function Assert-DrishtiSafeToRun {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$ConfigPath, [Parameter(Mandatory)][string]$ScriptRoot)
  $problems = @(Test-DrishtiPathAcl -Path $ConfigPath -TrustOperator)
  $installed = $ScriptRoot.StartsWith([IO.Path]::GetFullPath($Config.InstallRoot), [StringComparison]::OrdinalIgnoreCase)
  $scriptProblems = @(Test-DrishtiPathAcl -Path $ScriptRoot -TrustOperator)
  if ($installed) { $problems += $scriptProblems }
  elseif ($scriptProblems.Count -gt 0) { Write-DrishtiStep -Kind warn -Message "these scripts run from $ScriptRoot, which others may change; production runs them from $(Join-Path $Config.InstallRoot 'scripts')" }
  if ($problems.Count -gt 0) { throw "Refused: others may change what this script runs or reads ($($problems -join '; ')). Run drishti-services.ps1 -Action RepairAcl as an administrator." }
}

<#
  Review M-13: the database mode and the migration mode must fit together.
    Container + DbUrl  a self-hosted Supabase in Docker on this server (production): migrations through its database address.
    Direct    + DbUrl  PostgreSQL elsewhere, client tools installed here (production).
    Container + Local  the Supabase CLI's own local stack: a TEST server only, so it needs TestServer = $true.
    Direct    + Local  refused: the CLI's local stack is always a container.
  DbUrl needs Host, Port, Name, PasswordEnv and a user (MigrateUser or User).
#>
function Assert-DrishtiConfigConsistent {
  param([Parameter(Mandatory)]$Config, [switch]$ForUpdate)
  $db = $Config.Database
  $mode = if ($Config.ContainsKey('MigrationMode')) { [string]$Config.MigrationMode } else { '' }
  if (@('Local', 'DbUrl') -notcontains $mode) { throw "MigrationMode must be 'DbUrl' (production) or 'Local' (the Supabase CLI's stack on a test server); it is '$mode'." }
  if ($mode -eq 'Local') {
    if ($db.Mode -ne 'Container') { throw "MigrationMode 'Local' is the Supabase CLI's own stack, which runs in Docker: Database.Mode must be 'Container' (or use MigrationMode 'DbUrl')." }
    if (-not ($Config.ContainsKey('TestServer') -and $Config.TestServer -eq $true)) {
      throw "MigrationMode 'Local' (the Supabase CLI's local stack, seeded for tests) is for a test server only: set TestServer = `$true there, or use MigrationMode 'DbUrl' on a production server."
    }
    if ($mode -eq 'Local' -and $ForUpdate) {
      # Review 2 m1: the CLI's local stack is seeded (its test fixture switch is on): update.ps1 would refuse it every time, and switching
      # the switch off to get past that would mark a TEST database as a production one for good.
      throw "update.ps1 is for production databases (MigrationMode 'DbUrl'). On a test server with the Supabase CLI's local stack (seeded for tests: its test fixture switch is on), update by hand instead: npx supabase migration up --local, then point app\current at the new release (docs/drishti/runbooks/update-rollback.md section 5). Do NOT switch the test fixture switch off to get past this: the update would then mark the test database as a production one for good."
    }
  } else {
    foreach ($k in @('Host', 'Port', 'Name', 'PasswordEnv')) { if (-not ($db.ContainsKey($k) -and $db[$k])) { throw "MigrationMode 'DbUrl' needs Database.$k." } }
    if (-not (($db.ContainsKey('MigrateUser') -and $db.MigrateUser) -or ($db.ContainsKey('User') -and $db.User))) { throw "MigrationMode 'DbUrl' needs Database.MigrateUser (or Database.User)." }
  }
}

<#
  Review I-6 (pure, unit-tested with made-up folders): which folders of the backup folder the retention removes. Only folders this
  script made are candidates: a plain folder (not a link) named <yyyyMMdd-HHmmss>-<tag> whose manifest.json says kind drishti-backup.
  Kept: everything younger than Days, and the newest Keep whatever their age. A candidate that holds a link anywhere is kept and named
  ('keep-link'); a folder that is itself a link is named and skipped ('skip-link'); anything else is 'ignore'.
  Folders: records Name, IsReparse, ManifestKind, HasReparseBelow. Returns records Name, Action (remove, keep, keep-link, skip-link,
  ignore).
#>
function Get-DrishtiRetentionPlan {
  param([object[]]$Folders = @(), [int]$Days = 30, [int]$Keep = 7, [datetime]$Now = (Get-Date))
  $pattern = '^\d{8}-\d{6}-[a-z0-9-]+$'
  $out = @()
  $candidates = @()
  foreach ($f in $Folders) {
    if ($f.IsReparse) { if ($f.Name -match $pattern) { $out += [pscustomobject]@{ Name = $f.Name; Action = 'skip-link' } }; continue }
    if ($f.Name -notmatch $pattern -or $f.ManifestKind -ne 'drishti-backup') { $out += [pscustomobject]@{ Name = $f.Name; Action = 'ignore' }; continue }
    $candidates += $f
  }
  $cutoff = $Now.AddDays(-$Days)
  $i = 0
  foreach ($c in ($candidates | Sort-Object -Property Name -Descending)) {
    $i++
    $made = [datetime]::ParseExact($c.Name.Substring(0, 15), 'yyyyMMdd-HHmmss', $null)
    $action = if ($i -le $Keep -or $made -ge $cutoff) { 'keep' } elseif ($c.HasReparseBelow) { 'keep-link' } else { 'remove' }
    $out += [pscustomobject]@{ Name = $c.Name; Action = $action }
  }
  return $out
}

<#
  Final review C-I5 (pure, unit-tested): is the new release broken (roll back), or does the server need a look (keep the release)?
  Release problems: the version endpoint did not answer with the new build; a started service is not running; the gateway does not
  answer; the database is below the level the release needs. Otherwise a public health other than 'ok' is a problem of the server.
#>
function Get-DrishtiReleaseVerdictFrom {
  param([bool]$VersionAnswered, [string[]]$NotRunning = @(), [bool]$GatewayChecked, [bool]$GatewayAnswered, [string]$DbLevel, [string]$Expected, [string]$PublicStatus, [string]$VersionUrl = '/api/version', [string]$BuildId = '', [string]$LogDir = '')
  $reasons = @()
  if (-not $VersionAnswered) { $reasons += "$VersionUrl did not answer with build $BuildId" }
  foreach ($n in $NotRunning) { $reasons += "$n is not running (its start-up self-check may have refused: see its log in $LogDir)" }
  if ($GatewayChecked -and -not $GatewayAnswered) { $reasons += 'the gateway does not answer its /g/health' }
  if (-not $DbLevel) { $reasons += 'the database level could not be read' }
  elseif ($Expected -and $DbLevel -lt $Expected) { $reasons += "the database is at $DbLevel, the release needs $Expected" }
  if ($reasons.Count -gt 0) { return @{ Verdict = 'release'; Reasons = $reasons } }
  if ($PublicStatus -eq 'ok') { return @{ Verdict = 'ok'; Reasons = @() } }
  $said = if ($PublicStatus) { $PublicStatus } else { 'nothing' }
  return @{ Verdict = 'environment'; Reasons = @("the public health says $said") }
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

<# The junctions and links at or below a path (never followed; GetFileSystemEntries per level), full paths. #>
function Get-DrishtiReparsePoints {
  param([Parameter(Mandatory)][string]$Path)
  $out = New-Object System.Collections.Generic.List[string]
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $out.Add($item.FullName); return $out.ToArray() }
  if (-not $item.PSIsContainer) { return $out.ToArray() }
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($item.FullName)
  while ($stack.Count -gt 0) {
    foreach ($e in [IO.Directory]::GetFileSystemEntries($stack.Pop())) {
      $a = [IO.File]::GetAttributes($e)
      if ($a -band [IO.FileAttributes]::ReparsePoint) { $out.Add($e) }
      elseif ($a -band [IO.FileAttributes]::Directory) { $stack.Push($e) }
    }
  }
  return $out.ToArray()
}

<#
  Review M-1: one update or live restore at a time. A lock file opened without sharing in InstallRoot, held until Close(); a second run
  is refused with a plain line.
#>
function Enter-DrishtiLock {
  param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$What)
  $path = Join-Path $Config.InstallRoot 'drishti.lock'
  # Fix round 2 (re-review M-1 nit): never made here unlocked; the install makes and locks it.
  if (-not (Test-Path -LiteralPath $Config.InstallRoot)) { throw "$($Config.InstallRoot) does not exist: run drishti-services.ps1 -Action Install first." }
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
