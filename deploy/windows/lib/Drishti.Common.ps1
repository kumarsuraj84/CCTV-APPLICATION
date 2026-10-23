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
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @(), [switch]$DryRun, [string]$Display)
  $shown = if ($Display) { $Display } else { "$FilePath $($ArgumentList -join ' ')" }
  if ($DryRun) { Write-DrishtiStep -Kind plan -Message "would run: $shown"; return }
  Write-DrishtiStep -Message "run: $shown"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Failed ($LASTEXITCODE): $shown" }
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

<#
  Restricts a file or folder to the Administrators, SYSTEM, the person running the script (so a non-elevated operator never locks
  themselves out of what they just made) and the given accounts (read, or modify for log folders).
#>
function Set-DrishtiAcl {
  param([Parameter(Mandatory)][string]$Path, [string[]]$ReadAccounts = @(), [string[]]$ModifyAccounts = @(), [switch]$IsFile, [switch]$DryRun)
  $leaf = $IsFile -or (Test-Path -LiteralPath $Path -PathType Leaf)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $icaclsArgs = if ($leaf) { @($Path, '/inheritance:r', '/grant:r', 'Administrators:F', '/grant:r', 'SYSTEM:F', '/grant:r', "${me}:F") } else { @($Path, '/inheritance:r', '/grant:r', 'Administrators:(OI)(CI)F', '/grant:r', 'SYSTEM:(OI)(CI)F', '/grant:r', "${me}:(OI)(CI)F") }
  foreach ($a in $ReadAccounts) { $icaclsArgs += @('/grant:r', $(if ($leaf) { "${a}:R" } else { "${a}:(OI)(CI)RX" })) }
  foreach ($a in $ModifyAccounts) { $icaclsArgs += @('/grant:r', $(if ($leaf) { "${a}:M" } else { "${a}:(OI)(CI)M" })) }
  Invoke-DrishtiCommand -FilePath 'icacls.exe' -ArgumentList $icaclsArgs -DryRun:$DryRun
}

function Test-DrishtiAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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
