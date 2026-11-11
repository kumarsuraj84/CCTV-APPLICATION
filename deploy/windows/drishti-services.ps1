<#
.SYNOPSIS
  CityKart Drishti: install, uninstall, start, stop, restart, show, audit or repair the four Windows services (P5.4).

.DESCRIPTION
  DrishtiGo2rtc (go2rtc on 127.0.0.1:1984), DrishtiWorker (monitoring), DrishtiGateway (video, 127.0.0.1:3412) and DrishtiWeb (the
  Next.js standalone server, 127.0.0.1:3212), each:
    - run by the Drishti service host (service-host\DrishtiServiceHost.cs, compiled here with the .NET Framework's own csc.exe: no
      download, no global install) registered with New-Service / sc.exe;
    - under its own virtual service account "NT SERVICE\<name>" (no password, nothing to create; or a named account from the
      configuration), with read access to the release and its own env file only, and write access to its own log folder only;
    - started automatically (delayed auto-start), restarted on failure (the host restarts the program; the Service Control Manager
      restarts the host: 5 s, 10 s, 60 s), its output in <LogDir>\<name>\<name>.log rolled by size.
  Review C-2: before anything is written, Install creates and LOCKS the installation's folders (InstallRoot, bin, services, scripts,
  app, ConfigDir, DataDir, LogDir and each log folder, BackupDir, the key folder, go2rtc's folder): inherited entries removed, SYSTEM
  and Administrators only, then exactly the service accounts' reads and their own log folder's modify. The scripts are copied to
  <InstallRoot>\scripts (the copy the scheduled backup runs). Fix round 2 (review N-1): each lock takes ownership for the
  Administrators and rebuilds the access list from nothing (no explicit entry of anybody else survives, nothing below keeps its own
  entries); a folder that existed already with another owner is named in a warning; a junction inside one is refused. -Action Audit
  (run it elevated) lists every foreign owner, every entry that lets anybody else write, and on the secret paths every entry that lets
  anybody else read; -Action RepairAcl applies the locks again; -Action Status shows the services, the health and the audit's verdict.
  Why not NSSM: it is a separate download and global install, and it keeps the environment (the secrets) in the registry; the host
  reads the service's ACL-protected env file instead (docs/drishti/runbooks/windows-services.md).
  -WhatIf / -DryRun: says what would be done, changes nothing (no administrator rights needed).

.EXAMPLE
  .\drishti-services.ps1 -Action Install -ConfigPath C:\Drishti\config\drishti.config.psd1 -WhatIf
  .\drishti-services.ps1 -Action Start
  .\drishti-services.ps1 -Action Status
  .\drishti-services.ps1 -Action Audit
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Restart', 'Status', 'Audit', 'RepairAcl')][string]$Action,
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [ValidateSet('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb', 'DrishtiProxy')][string[]]$Service,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)

$config = Read-DrishtiConfig -Path $ConfigPath
$allDefs = Get-DrishtiServiceDefinitions -Config $config
$defs = $allDefs
if ($Service) { $defs = @($allDefs | Where-Object { $Service -contains $_.Name }) }
if ($defs.Count -eq 0) { throw 'No service selected (see Services in the configuration).' }

# Review M-3: stopping go2rtc alone fails while the gateway (which depends on it) runs: the gateway is stopped first, and started again.
if (($Action -eq 'Stop' -or $Action -eq 'Restart') -and ($defs.Name -contains 'DrishtiGo2rtc') -and -not ($defs.Name -contains 'DrishtiGateway')) {
  $gw = @($allDefs | Where-Object { $_.Name -eq 'DrishtiGateway' })
  if ($gw.Count -gt 0) {
    Write-DrishtiStep -Message 'DrishtiGateway depends on DrishtiGo2rtc: it is stopped (and started again) with it'
    $defs = @($defs) + $gw
  }
}
$byName = @{}
foreach ($d in $defs) { $byName[$d.Name] = $d }
$inStartOrder = @($script:DrishtiStartOrder | Where-Object { $byName.ContainsKey($_) } | ForEach-Object { $byName[$_] })
$inStopOrder = @($script:DrishtiStopOrder | Where-Object { $byName.ContainsKey($_) } | ForEach-Object { $byName[$_] })

if (-not $dry -and @('Status', 'Audit') -notcontains $Action -and -not (Test-DrishtiAdministrator)) { throw 'Run this from an elevated PowerShell (Administrator), or add -WhatIf to see what it would do.' }

$bin = Join-Path $config.InstallRoot 'bin'
$hostExe = Join-Path $bin 'DrishtiServiceHost.exe'
$servicesDir = Join-Path $config.InstallRoot 'services'
$scriptsCopy = Join-Path $config.InstallRoot 'scripts'
$hostSource = Join-Path $PSScriptRoot 'service-host\DrishtiServiceHost.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Set-DrishtiFolderLocks {
  # Every folder created and locked BEFORE anything is written into it (review C-2, I-3).
  foreach ($p in (Get-DrishtiAclPlan -Config $config -Definitions $allDefs)) {
    Set-DrishtiAcl -Path $p.Path -ReadAccounts $p.Read -ModifyAccounts $p.Modify -ListAccounts $p.List -AllowedLinks $p.AllowedLinks -InstallRoot $config.InstallRoot -DryRun:$dry
  }
}

function Set-DrishtiFileLocks {
  foreach ($d in $allDefs) {
    $account = Get-DrishtiServiceAccount -Config $config -Name $d.Name
    foreach ($f in @($d.EnvFile, (Join-Path $servicesDir "$($d.Name).conf"))) {
      if ($dry -or (Test-Path -LiteralPath $f)) { Set-DrishtiAcl -Path $f -ReadAccounts @($account) -IsFile -DryRun:$dry }
    }
    if ($d.Name -eq 'DrishtiGo2rtc') {
      $yaml = Join-Path $config.ConfigDir 'go2rtc.yaml'
      if ($dry -or (Test-Path -LiteralPath $yaml)) { Set-DrishtiAcl -Path $yaml -ReadAccounts @($account) -IsFile -DryRun:$dry }
    }
    if ($d.Name -eq 'DrishtiProxy') {
      $caddyfile = Join-Path $config.ConfigDir 'Caddyfile'
      if ($dry -or (Test-Path -LiteralPath $caddyfile)) { Set-DrishtiAcl -Path $caddyfile -ReadAccounts @($account) -IsFile -DryRun:$dry }
    }
  }
  if ($dry -or (Test-Path -LiteralPath $ConfigPath)) { Set-DrishtiAcl -Path $ConfigPath -IsFile -DryRun:$dry }
}

function Copy-DrishtiScripts {
  # The scheduled backup and the operator run THIS admin-only copy, never a release or a checkout that others may change (review C-2).
  if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ieq [IO.Path]::GetFullPath($scriptsCopy).TrimEnd('\')) { return }
  Invoke-DrishtiCommand -FilePath $script:RobocopyExe -ArgumentList @($PSScriptRoot, $scriptsCopy, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -DryRun:$dry -Display "robocopy $PSScriptRoot -> $scriptsCopy (the admin-only copy of the scripts)" -AllowExitCodes @(0, 1, 2, 3)
}

function Install-DrishtiHost {
  $stale = $dry -or -not (Test-Path -LiteralPath $hostExe) -or ((Get-Item -LiteralPath $hostSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $hostExe).LastWriteTimeUtc)
  if (-not $stale) { Write-DrishtiStep -Message "service host is up to date: $hostExe"; return }
  if (-not $dry -and -not (Test-Path -LiteralPath $csc)) { throw "The .NET Framework 4 C# compiler is missing: $csc" }
  Invoke-DrishtiCommand -FilePath $csc -ArgumentList @('/nologo', '/target:exe', '/optimize+', "/out:$hostExe", '/reference:System.ServiceProcess.dll', $hostSource) -DryRun:$dry
}

function Install-DrishtiService {
  param($d)
  $account = Get-DrishtiServiceAccount -Config $config -Name $d.Name
  $conf = Join-Path $servicesDir "$($d.Name).conf"
  $logs = Join-Path $config.LogDir $d.Name
  if (Get-Service -Name $d.Name -ErrorAction SilentlyContinue) { Write-DrishtiStep -Kind warn -Message "$($d.Name) is installed already: uninstall it first to change it (-Action RepairAcl renews its access rules)"; return }
  if (-not $dry -and $d.Name -ne 'DrishtiProxy' -and -not (Test-Path -LiteralPath $d.EnvFile)) { throw "$($d.EnvFile) is missing: make it with node scripts/gen-secrets.mjs --production --out-dir $($config.ConfigDir)" }
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would write $conf (no secret: it names $($d.EnvFile))" }
  else { Set-Content -LiteralPath $conf -Value (ConvertTo-DrishtiHostConf -Definition $d -Config $config) -Encoding UTF8 -NoNewline }
  if ($d.Name -eq 'DrishtiProxy') {
    # Caddy keeps its storage (the certificates it manages, its locks) under DataDir\caddy, never under the user profile.
    $caddyfile = Join-Path $config.ConfigDir 'Caddyfile'
    if (-not $dry -and -not (Test-Path -LiteralPath $caddyfile)) { throw "$caddyfile is missing: copy deploy\windows\Caddyfile.example there and fill the host name and the certificate paths (C:\Drishti\config\certs)." }
    $data = Join-Path $config.DataDir 'caddy'
    $proxyEnv = "XDG_DATA_HOME=$(Join-Path $data 'data')`r`nXDG_CONFIG_HOME=$(Join-Path $data 'config')`r`n"
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would write $($d.EnvFile) (no secret: Caddy's storage under $data) if missing" }
    elseif (-not (Test-Path -LiteralPath $d.EnvFile)) { Set-Content -LiteralPath $d.EnvFile -Value $proxyEnv -Encoding ASCII -NoNewline }
  }
  if ($d.Name -eq 'DrishtiGo2rtc') {
    $yaml = Join-Path $config.ConfigDir 'go2rtc.yaml'
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would copy go2rtc.windows.yaml to $yaml (if missing)" }
    elseif (-not (Test-Path -LiteralPath $yaml)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'go2rtc.windows.yaml') -Destination $yaml }
  }
  # New-Service takes the command line as one string (PowerShell 5.1 would mangle the inner quotes on the way to sc.exe create).
  $binPath = "`"$hostExe`" `"$conf`""
  $depends = @($d.DependsOn | Where-Object { $byName.ContainsKey($_) })
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would run: New-Service -Name $($d.Name) -BinaryPathName '$binPath' -DisplayName '$($d.Display)' -StartupType Automatic$(if ($depends.Count) { " -DependsOn $($depends -join ',')" })" }
  elseif ($PSCmdlet.ShouldProcess($d.Name, 'create the service')) {
    $ns = @{ Name = $d.Name; BinaryPathName = $binPath; DisplayName = $d.Display; StartupType = 'Automatic'; Description = "CityKart Drishti: $($d.Display). Log: $logs" }
    if ($depends.Count) { $ns['DependsOn'] = $depends }
    New-Service @ns | Out-Null
    Write-DrishtiStep -Kind ok -Message "created $($d.Name)"
  }
  # Delayed automatic start (after the network and Docker), under the service's own account (a virtual account has no password).
  Invoke-DrishtiCommand -FilePath $script:ScExe -ArgumentList @('config', $d.Name, 'start=', 'delayed-auto', 'obj=', $account) -DryRun:$dry
  # A virtual account needs the service's own SID; then the restart rules of the Service Control Manager for the host itself.
  Invoke-DrishtiCommand -FilePath $script:ScExe -ArgumentList @('sidtype', $d.Name, 'unrestricted') -DryRun:$dry
  Invoke-DrishtiCommand -FilePath $script:ScExe -ArgumentList @('failure', $d.Name, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/60000') -DryRun:$dry
  Invoke-DrishtiCommand -FilePath $script:ScExe -ArgumentList @('failureflag', $d.Name, '1') -DryRun:$dry
}

<#
  Review C-2 and N-1: every owner that is not SYSTEM, the Administrators or TrustedInstaller; every entry that lets anybody but them and
  the path's own service account write; and on the secret paths (the configuration folder and file, the env files, go2rtc.yaml, the
  data, backup and key folders) every entry that lets anybody else even read. The person running this is never trusted here (review
  M-new-2): run it elevated; a path whose rules cannot be read is reported as such.
#>
function Get-DrishtiAuditProblems {
  $problems = @()
  foreach ($p in (Get-DrishtiAclPlan -Config $config -Definitions $allDefs)) {
    $problems += @(Test-DrishtiPathAcl -Path $p.Path -AllowedAccounts $p.Modify -ReadAccounts (@($p.Read) + @($p.List)) -Secret:$p.Secret)
  }
  $problems += @(Test-DrishtiPathAcl -Path $hostExe)
  $problems += @(Test-DrishtiPathAcl -Path $ConfigPath -Secret)
  $go = @($allDefs | Where-Object { $_.Name -eq 'DrishtiGo2rtc' })
  if ($go.Count -gt 0) { $problems += @(Test-DrishtiPathAcl -Path (Join-Path $config.ConfigDir 'go2rtc.yaml') -ReadAccounts @(Get-DrishtiServiceAccount -Config $config -Name 'DrishtiGo2rtc') -Secret) }
  foreach ($d in $allDefs) {
    $account = Get-DrishtiServiceAccount -Config $config -Name $d.Name
    $problems += @(Test-DrishtiPathAcl -Path $d.EnvFile -ReadAccounts @($account) -Secret)
    $problems += @(Test-DrishtiPathAcl -Path (Join-Path $servicesDir "$($d.Name).conf"))
  }
  # Review 2 N-3: no link anywhere in the installation but the checked appcurrent junction (never followed).
  foreach ($p in @($config.InstallRoot, $config.LogDir, $config.DataDir, $config.BackupDir) | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $allowed = @()
    try { if (Get-DrishtiCurrentRelease -InstallRoot $config.InstallRoot) { $allowed = @([IO.Path]::GetFullPath((Join-Path $config.InstallRoot 'appcurrent'))) } } catch { $problems += $_.Exception.Message }
    try { foreach ($l in @(Get-DrishtiReparsePoints -Path $p)) { if ($allowed -notcontains $l.TrimEnd('')) { $problems += "$($l): a junction or link the installation did not make" } } }
    catch { $problems += "$($p): its contents cannot be read from here (run elevated)" }
  }
  return $problems
}

function Stop-DrishtiServices {
  foreach ($d in $inStopOrder) {
    $s = Get-Service -Name $d.Name -ErrorAction SilentlyContinue
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would stop $($d.Name) (waits up to $($d.StopTimeoutSec + 15) s)"; continue }
    if (-not $s) { Write-DrishtiStep -Kind warn -Message "$($d.Name) is not installed"; continue }
    if ($s.Status -ne 'Stopped' -and $PSCmdlet.ShouldProcess($d.Name, 'stop')) {
      Stop-Service -Name $d.Name
      $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($d.StopTimeoutSec + 15))
      Write-DrishtiStep -Kind ok -Message "$($d.Name) stopped"
    }
  }
}

function Start-DrishtiServices {
  foreach ($d in $inStartOrder) {
    if ($dry) { Write-DrishtiStep -Kind plan -Message "would start $($d.Name)"; continue }
    $s = Get-Service -Name $d.Name -ErrorAction SilentlyContinue
    if (-not $s) { throw "$($d.Name) is not installed" }
    if ($s.Status -ne 'Running' -and $PSCmdlet.ShouldProcess($d.Name, 'start')) {
      Start-Service -Name $d.Name
      $s.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
      Write-DrishtiStep -Kind ok -Message "$($d.Name) running"
    }
  }
}

switch ($Action) {
  'Install' {
    Assert-DrishtiConfigConsistent -Config $config # review M-13
    Write-DrishtiStep -Message "install $($inStartOrder.Name -join ', ')$(if ($dry) { ' (dry run: nothing is changed)' })"
    Set-DrishtiFolderLocks
    Copy-DrishtiScripts
    Install-DrishtiHost
    foreach ($d in $inStartOrder) { Install-DrishtiService -d $d }
    Set-DrishtiFileLocks
    Write-DrishtiStep -Kind ok -Message 'installed; check with -Action Audit, then start them with -Action Start (go2rtc, worker, gateway, web app)'
  }
  'RepairAcl' {
    Set-DrishtiFolderLocks
    Set-DrishtiFileLocks
    Write-DrishtiStep -Kind ok -Message 'access rules applied again; -Action Audit checks them'
  }
  'Audit' {
    $problems = @(Get-DrishtiAuditProblems)
    if ($problems.Count -eq 0) { Write-DrishtiStep -Kind ok -Message 'access rules: ok (owners SYSTEM or the Administrators; only they and each service on its own log folder may write; secrets readable only by their own service)' }
    else {
      foreach ($p in $problems) { Write-DrishtiStep -Kind fail -Message $p }
      Write-DrishtiStep -Kind fail -Message "$($problems.Count) problem(s): run -Action RepairAcl as an administrator (and run -Action Audit itself elevated)"
      exit 1
    }
  }
  'Uninstall' {
    Stop-DrishtiServices
    foreach ($d in $inStopOrder) {
      if ($dry -or (Get-Service -Name $d.Name -ErrorAction SilentlyContinue)) {
        if ($PSCmdlet.ShouldProcess($d.Name, 'delete the service (logs, config and releases are kept)')) { Invoke-DrishtiCommand -FilePath $script:ScExe -ArgumentList @('delete', $d.Name) -DryRun:$dry }
        elseif ($dry) { Write-DrishtiStep -Kind plan -Message "would run: sc.exe delete $($d.Name)" }
      }
    }
  }
  'Start' { Start-DrishtiServices }
  'Stop' { Stop-DrishtiServices }
  'Restart' { Stop-DrishtiServices; Start-DrishtiServices }
  'Status' {
    foreach ($d in $inStartOrder) {
      $s = Get-Service -Name $d.Name -ErrorAction SilentlyContinue
      $state = if ($s) { [string]$s.Status } else { 'not installed' }
      $log = Join-Path (Join-Path $config.LogDir $d.Name) "$($d.Name).log"
      Write-Output ('{0,-16} {1,-14} log: {2}' -f $d.Name, $state, $log)
    }
    if ($config.ContainsKey('HealthUrl')) {
      try { Write-Output "health: $((Invoke-RestMethod -Uri $config.HealthUrl -TimeoutSec 5 -UseBasicParsing).status)" } catch { Write-Output 'health: not answering' }
    }
    # Review 2 m4: without elevation the locked folders cannot even be read: say so instead of counting false problems.
    if (-not (Test-DrishtiAdministrator)) { Write-Output 'access rules: not checked (run elevated to check them, or -Action Audit from an elevated PowerShell)' }
    else {
      $problems = @(Get-DrishtiAuditProblems)
      Write-Output $(if ($problems.Count -eq 0) { 'access rules: ok' } else { "access rules: $($problems.Count) problem(s), see -Action Audit" })
    }
  }
}
