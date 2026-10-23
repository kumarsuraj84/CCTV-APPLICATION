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
    'docker' { if ($Config.ContainsKey('DockerExe') -and $Config.DockerExe) { return [string]$Config.DockerExe } else { return 'docker' } }
    'git' { if ($Config.ContainsKey('GitExe') -and $Config.GitExe) { return [string]$Config.GitExe } else { return 'git' } }
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
  Review N-1: makes a file or folder carry EXACTLY the given entries, whatever was there before:
    - a missing folder is created first, before anything is written into it (review C-2, I-3);
    - elevated: ownership is taken for the Administrators (takeown /A, with everything below a folder: a folder made by someone else
      before the install no longer lets them change its rules); a path whose owner is not SYSTEM, the Administrators or TrustedInstaller
      is named in a warning first;
    - the access list is built from nothing (protected: no inherited entry; no explicit entry kept): SYSTEM and Administrators full,
      the non-elevated operator (tests only), then the given accounts; written in one call (Set-AccessControl), so there is no moment
      with a partial list;
    - a folder: every file and folder below it loses its own explicit entries and inherits the new list (icacls /reset /T); the
      plan then locks the sub-folders and files that need their own entries (parents before children).
#>
function Set-DrishtiAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$ReadAccounts = @(), [string[]]$ModifyAccounts = @(), [string[]]$ListAccounts = @(), [string[]]$AllowedLinks = @(), [switch]$IsFile, [switch]$DryRun)
  $leaf = $IsFile -or (Test-Path -LiteralPath $Path -PathType Leaf)
  $exists = Test-Path -LiteralPath $Path
  if (-not $leaf -and -not $exists) {
    if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would create $Path" } else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
  }
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
  if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would lock ${Path}: $owner; every other entry removed, nothing inherited; only $shown"; return }

  if ($exists) {
    $current = $null
    try { $current = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $current = '(unreadable)' }
    $trustedOwners = @($script:SidSystem, $script:SidAdmins, $script:SidTrustedInstaller) + @(Get-DrishtiOperatorGrant | ForEach-Object { $_.Substring(1) })
    if ($trustedOwners -notcontains $current) {
      Write-DrishtiStep -Kind warn -Message "$Path existed already and belongs to $current, not to the Administrators: somebody may have made it before the install. Ownership is taken and its rules are rebuilt; check what is in it."
    }
  }
  # Never follow a junction or link out of the folder (one planted in a folder made before the install could point at C:\Windows).
  if (-not $leaf) {
    $allowed = @($AllowedLinks | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
    $foreign = @(Get-DrishtiReparsePoints -Path $Path | Where-Object { $allowed -notcontains $_.TrimEnd('\') })
    if ($foreign.Count -gt 0) { throw "Refused: $Path contains a junction or link the installation did not make ($($foreign -join ', ')). Look at it, remove it, and run this again." }
  }
  $hasChildren = (-not $leaf) -and @([IO.Directory]::GetFileSystemEntries($Path)).Count -gt 0
  if ($admin) {
    $takeArgs = @('/F', $Path, '/A')
    if (-not $leaf) { $takeArgs += @('/R', '/D', 'Y') }
    & $script:TakeownExe @takeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not take ownership of $Path for the Administrators (takeown exit $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
  }
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
  if ($hasChildren) {
    & $script:IcaclsExe (Join-Path $Path '*') '/reset' '/T' '/C' '/Q' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not reset the rules below $Path (icacls exit $LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
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
  param([Parameter(Mandatory)]$Config)
  $db = $Config.Database
  $mode = if ($Config.ContainsKey('MigrationMode')) { [string]$Config.MigrationMode } else { '' }
  if (@('Local', 'DbUrl') -notcontains $mode) { throw "MigrationMode must be 'DbUrl' (production) or 'Local' (the Supabase CLI's stack on a test server); it is '$mode'." }
  if ($mode -eq 'Local') {
    if ($db.Mode -ne 'Container') { throw "MigrationMode 'Local' is the Supabase CLI's own stack, which runs in Docker: Database.Mode must be 'Container' (or use MigrationMode 'DbUrl')." }
    if (-not ($Config.ContainsKey('TestServer') -and $Config.TestServer -eq $true)) {
      throw "MigrationMode 'Local' (the Supabase CLI's local stack, seeded for tests) is for a test server only: set TestServer = `$true there, or use MigrationMode 'DbUrl' on a production server."
    }
  } else {
    foreach ($k in @('Host', 'Port', 'Name', 'PasswordEnv')) { if (-not ($db.ContainsKey($k) -and $db[$k])) { throw "MigrationMode 'DbUrl' needs Database.$k." } }
    if (-not (($db.ContainsKey('MigrateUser') -and $db.MigrateUser) -or ($db.ContainsKey('User') -and $db.User))) { throw "MigrationMode 'DbUrl' needs Database.MigrateUser (or Database.User)." }
  }
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
