<#
.SYNOPSIS
  CityKart Drishti: install, uninstall, start, stop, restart or show the four Windows services (P5.4).

.DESCRIPTION
  DrishtiGo2rtc (go2rtc on 127.0.0.1:1984), DrishtiWorker (monitoring), DrishtiGateway (video, 127.0.0.1:3412) and DrishtiWeb (the
  Next.js standalone server, 127.0.0.1:3212), each:
    - run by the Drishti service host (service-host\DrishtiServiceHost.cs, compiled here with the .NET Framework's own csc.exe: no
      download, no global install) registered with sc.exe;
    - under its own virtual service account "NT SERVICE\<name>" (no password, nothing to create; or a named account from the
      configuration), with read access to the release and its own env file only, and write access to its own log folder only;
    - started automatically (delayed auto-start), restarted on failure (the host restarts the program; the Service Control Manager
      restarts the host: 5 s, 10 s, 60 s), its output in <LogDir>\<name>\<name>.log rolled by size.
  Why not NSSM: it is a separate download and global install, and it keeps the environment (the secrets) in the registry; the host
  reads the service's ACL-protected env file instead (docs/drishti/runbooks/windows-services.md).
  -WhatIf / -DryRun: says what would be done, changes nothing (no administrator rights needed).

.EXAMPLE
  .\drishti-services.ps1 -Action Install -ConfigPath C:\Drishti\config\drishti.config.psd1 -WhatIf
  .\drishti-services.ps1 -Action Start
  .\drishti-services.ps1 -Action Status
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Restart', 'Status')][string]$Action,
  [string]$ConfigPath = 'C:\Drishti\config\drishti.config.psd1',
  [ValidateSet('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')][string[]]$Service,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Drishti.Common.ps1')
$dry = [bool]($DryRun -or $WhatIfPreference)

$config = Read-DrishtiConfig -Path $ConfigPath
$defs = Get-DrishtiServiceDefinitions -Config $config
if ($Service) { $defs = @($defs | Where-Object { $Service -contains $_.Name }) }
if ($defs.Count -eq 0) { throw 'No service selected (see Services in the configuration).' }
$byName = @{}
foreach ($d in $defs) { $byName[$d.Name] = $d }
$inStartOrder = @($script:DrishtiStartOrder | Where-Object { $byName.ContainsKey($_) } | ForEach-Object { $byName[$_] })
$inStopOrder = @($script:DrishtiStopOrder | Where-Object { $byName.ContainsKey($_) } | ForEach-Object { $byName[$_] })

if (-not $dry -and $Action -ne 'Status' -and -not (Test-DrishtiAdministrator)) { throw 'Run this from an elevated PowerShell (Administrator), or add -WhatIf to see what it would do.' }

$bin = Join-Path $config.InstallRoot 'bin'
$hostExe = Join-Path $bin 'DrishtiServiceHost.exe'
$hostSource = Join-Path $PSScriptRoot 'service-host\DrishtiServiceHost.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

function Install-DrishtiHost {
  $stale = -not (Test-Path -LiteralPath $hostExe) -or ((Get-Item -LiteralPath $hostSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $hostExe).LastWriteTimeUtc)
  if (-not $stale) { Write-DrishtiStep -Message "service host is up to date: $hostExe"; return }
  if (-not $dry -and -not (Test-Path -LiteralPath $csc)) { throw "The .NET Framework 4 C# compiler is missing: $csc" }
  if (-not $dry) { New-Item -ItemType Directory -Force -Path $bin | Out-Null }
  Invoke-DrishtiCommand -FilePath $csc -ArgumentList @('/nologo', '/target:exe', '/optimize+', "/out:$hostExe", '/reference:System.ServiceProcess.dll', $hostSource) -DryRun:$dry
}

function Install-DrishtiService {
  param($d)
  $account = Get-DrishtiServiceAccount -Config $config -Name $d.Name
  $servicesDir = Join-Path $config.InstallRoot 'services'
  $conf = Join-Path $servicesDir "$($d.Name).conf"
  $logs = Join-Path $config.LogDir $d.Name
  if (Get-Service -Name $d.Name -ErrorAction SilentlyContinue) { Write-DrishtiStep -Kind warn -Message "$($d.Name) is installed already: uninstall it first to change it"; return }
  if (-not $dry -and -not (Test-Path -LiteralPath $d.EnvFile)) { throw "$($d.EnvFile) is missing: make it with node scripts/gen-secrets.mjs --production --out-dir $($config.ConfigDir)" }
  if ($dry) { Write-DrishtiStep -Kind plan -Message "would write $conf (no secret: it names $($d.EnvFile)) and create $logs" }
  else {
    New-Item -ItemType Directory -Force -Path $servicesDir, $logs | Out-Null
    Set-Content -LiteralPath $conf -Value (ConvertTo-DrishtiHostConf -Definition $d -Config $config) -Encoding UTF8 -NoNewline
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
  Invoke-DrishtiCommand -FilePath 'sc.exe' -ArgumentList @('config', $d.Name, 'start=', 'delayed-auto', 'obj=', $account) -DryRun:$dry
  # A virtual account needs the service's own SID; then the restart rules of the Service Control Manager for the host itself.
  Invoke-DrishtiCommand -FilePath 'sc.exe' -ArgumentList @('sidtype', $d.Name, 'unrestricted') -DryRun:$dry
  Invoke-DrishtiCommand -FilePath 'sc.exe' -ArgumentList @('failure', $d.Name, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/60000') -DryRun:$dry
  Invoke-DrishtiCommand -FilePath 'sc.exe' -ArgumentList @('failureflag', $d.Name, '1') -DryRun:$dry
  # Least privilege: the account reads the release, the host and its own env file, and writes its own log folder; nothing else.
  Set-DrishtiAcl -Path $logs -ModifyAccounts @($account) -DryRun:$dry
  Set-DrishtiAcl -Path $d.EnvFile -ReadAccounts @($account) -IsFile -DryRun:$dry
  Set-DrishtiAcl -Path $conf -ReadAccounts @($account) -IsFile -DryRun:$dry
  if ($d.Name -eq 'DrishtiGo2rtc') { Set-DrishtiAcl -Path (Join-Path $config.ConfigDir 'go2rtc.yaml') -ReadAccounts @($account) -IsFile -DryRun:$dry }
}

function Grant-DrishtiReadAccess {
  # Every service account reads the host (bin); the three Node.js services also read the releases (app); go2rtc reads its own folder.
  foreach ($d in $defs) {
    $a = Get-DrishtiServiceAccount -Config $config -Name $d.Name
    Invoke-DrishtiCommand -FilePath 'icacls.exe' -ArgumentList @($bin, '/grant', "${a}:(OI)(CI)RX") -DryRun:$dry
    if ($d.Name -ne 'DrishtiGo2rtc') { Invoke-DrishtiCommand -FilePath 'icacls.exe' -ArgumentList @((Join-Path $config.InstallRoot 'app'), '/grant', "${a}:(OI)(CI)RX") -DryRun:$dry }
  }
  $go = @($defs | Where-Object { $_.Name -eq 'DrishtiGo2rtc' })
  if ($go.Count -gt 0) { Invoke-DrishtiCommand -FilePath 'icacls.exe' -ArgumentList @((Split-Path -Parent $config.Go2rtcExe), '/grant', "$(Get-DrishtiServiceAccount -Config $config -Name 'DrishtiGo2rtc'):(OI)(CI)RX") -DryRun:$dry }
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
    Write-DrishtiStep -Message "install $($inStartOrder.Name -join ', ')$(if ($dry) { ' (dry run: nothing is changed)' })"
    Install-DrishtiHost
    foreach ($d in $inStartOrder) { Install-DrishtiService -d $d }
    Grant-DrishtiReadAccess
    Write-DrishtiStep -Kind ok -Message 'installed; start them with -Action Start (go2rtc, worker, gateway, web app)'
  }
  'Uninstall' {
    Stop-DrishtiServices
    foreach ($d in $inStopOrder) {
      if ($dry -or (Get-Service -Name $d.Name -ErrorAction SilentlyContinue)) {
        if ($PSCmdlet.ShouldProcess($d.Name, 'delete the service (logs, config and releases are kept)')) { Invoke-DrishtiCommand -FilePath 'sc.exe' -ArgumentList @('delete', $d.Name) -DryRun:$dry }
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
  }
}
