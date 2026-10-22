<#
.SYNOPSIS
  CityKart Drishti read-only endpoint collector (work package WP-6.2a).

.DESCRIPTION
  Collects an inventory and health snapshot of THIS Windows PC and returns it as one JSON document
  (schema: docs/drishti/agent-telemetry-schema.json, notes: docs/drishti/agent-telemetry.md).

  READ ONLY. The script never changes the machine: it does not write the registry, services, files,
  tasks, accounts or settings, it starts no other program, and it makes no network call and talks to
  no other host. The only write it can perform is the JSON file named by -OutFile (a .json file in a
  folder that already exists, chosen by the caller).

  A datum that cannot be read (for example because it needs an elevated or SYSTEM token) is reported
  as 'unavailable' with a reason in collection.items. Values are never invented.

  PowerShell 5.1, Windows 10/11, no external modules. Works as a standard user, an elevated
  administrator or SYSTEM; elevated and SYSTEM runs return more.

.PARAMETER Sections
  Comma separated list of sections to collect. Default: all.
  Names: host, os, hardware, network, software, services, security, updates, metrics.

.PARAMETER OutFile
  Write the JSON document to this file instead of the console. Must end in .json and its folder must exist.

.PARAMETER Quiet
  Print nothing on success (errors still go to the error stream, the exit code still tells the result).

.PARAMETER SelfTest
  Collect, then check the produced document against the built-in schema rules. Prints one result line
  and never prints machine data. Exit code 0 = pass, 1 = fail.

.PARAMETER Redact
  Replace serial numbers, UUID, MAC addresses, computer name, domain/workgroup and user names with
  stable salted hashes, so the file can be shared. The same machine gives the same hashes every run.

.PARAMETER RedactSalt
  Salt for -Redact. Use a private value to stop others reproducing the hashes from a guessed name.

.PARAMETER RequiredServices
  Comma separated service names to report in services.required. Default: Windows Update, Microsoft
  Defender, Windows Firewall, Windows Time, Print Spooler, RPC, DHCP Client, DNS Client, plus the
  Drishti agent service when it is installed.

.PARAMETER SimulateFailure
  Test hook: make the named section fail, to prove one failing section never stops the others.

.PARAMETER Pretty
  Indent the JSON (default is compact).

.NOTES
  Exit codes: 0 ok, 1 self test failed, 2 bad arguments or -OutFile refused, 3 unexpected failure.
#>
[CmdletBinding()]
param(
    [string[]]$Sections,
    [string]$OutFile,
    [switch]$Quiet,
    [switch]$SelfTest,
    [switch]$Redact,
    [string]$RedactSalt = 'drishti-share-v1',
    [string[]]$RequiredServices,
    [string]$SimulateFailure,
    [switch]$Pretty
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Culture-invariant numbers and dates for this process only.
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
[System.Threading.Thread]::CurrentThread.CurrentUICulture = [System.Globalization.CultureInfo]::InvariantCulture

$script:CollectorVersion = '0.1.0'
$script:SchemaVersion = '1.0'
$script:AllSections = @('host', 'os', 'hardware', 'network', 'software', 'services', 'security', 'updates', 'metrics')
$script:MaxText = 256
$script:MaxSoftware = 2000
$script:MaxHotfixes = 200
$script:Doc = [ordered]@{}
$script:Items = [System.Collections.Generic.List[object]]::new()
$script:Wanted = @()
$script:Inv = [System.Globalization.CultureInfo]::InvariantCulture

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

function ConvertTo-DrishtiText {
    # Text for the document: control characters removed, white space collapsed, at most 256 characters.
    param($Value, [int]$Max = 256)
    if ($null -eq $Value) { return $null }
    $s = [string]::Format($script:Inv, '{0}', $Value)
    $s = [regex]::Replace($s, '[\x00-\x1F\x7F-\x9F]', ' ')
    $s = [regex]::Replace($s, '\s+', ' ').Trim()
    if ($s.Length -eq 0) { return $null }
    if ($s.Length -gt $Max) {
        $s = $s.Substring(0, $Max)
        if ([char]::IsHighSurrogate($s[$s.Length - 1])) { $s = $s.Substring(0, $s.Length - 1) }
    }
    return $s
}

function ConvertTo-DrishtiNumber {
    param($Value, [int]$Digits = 2)
    if ($null -eq $Value) { return $null }
    try { return [math]::Round([double]$Value, $Digits) } catch { return $null }
}

function ConvertTo-DrishtiInt {
    param($Value)
    if ($null -eq $Value) { return $null }
    try { return [int64][math]::Round([double]$Value, 0) } catch { return $null }
}

function Format-DrishtiUtc {
    param($Date)
    if ($null -eq $Date) { return $null }
    try { $d = [datetime]$Date } catch { return $null }
    if ($d.Year -lt 1990) { return $null }
    return $d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $script:Inv)
}

function Format-DrishtiDay {
    param($Date)
    if ($null -eq $Date) { return $null }
    try { $d = [datetime]$Date } catch { return $null }
    if ($d.Year -lt 1990) { return $null }
    return $d.ToString('yyyy-MM-dd', $script:Inv)
}

function Get-DrishtiProp {
    # Safe property read: null when the object or the property is missing (strict mode safe).
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-DrishtiList {
    # Array of cleaned, non-empty strings (at most 16).
    param($Values)
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($v in @($Values)) {
        $t = ConvertTo-DrishtiText $v
        if ($null -ne $t -and $out.Count -lt 16) { [void]$out.Add($t) }
    }
    return , $out.ToArray()
}

function Get-DrishtiErrorText {
    param($ErrorRecord)
    $msg = ''
    try { $msg = [string]$ErrorRecord.Exception.Message } catch { $msg = 'unknown failure' }
    if ($msg -match 'denied|Unauthorized|0x80041003|not authorized|privilege') {
        return 'access denied: needs an elevation or a SYSTEM token'
    }
    $t = ConvertTo-DrishtiText $msg 200
    if ($null -eq $t) { return 'failed without a message' }
    return $t
}

function Test-DrishtiWanted {
    param([string]$Name)
    return ($script:Wanted -contains $Name)
}

function Note-DrishtiItem {
    # One line of the coverage report: section (or section.part), status ok|unavailable|error, reason.
    param([string]$Section, [string]$Status, $Reason)
    $r = ConvertTo-DrishtiText $Reason 200
    $item = [ordered]@{ section = $Section; status = $Status; reason = $r }
    [void]$script:Items.Add($item)
}

function Get-DrishtiCimSafe {
    # Local CIM query that returns an empty array (and a coverage note) instead of throwing.
    param([string]$Class, [string]$Filter, [string]$Namespace, [string]$NoteKey)
    try {
        $p = @{ ClassName = $Class; ErrorAction = 'Stop' }
        if ($Filter) { $p['Filter'] = $Filter }
        if ($Namespace) { $p['Namespace'] = $Namespace }
        # Callers wrap the call in @( ) to get an array, so nothing is emitted when nothing matches.
        return Get-CimInstance @p
    }
    catch {
        if ($NoteKey) { Note-DrishtiItem $NoteKey 'unavailable' (Get-DrishtiErrorText $_) }
        return
    }
}

function Get-DrishtiPrivilege {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        if ($id.IsSystem) { return 'system' }
        $pr = [System.Security.Principal.WindowsPrincipal]::new($id)
        if ($pr.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { return 'elevated' }
        return 'standard'
    }
    catch { return 'standard' }
}

function Test-DrishtiPlaceholder {
    # Firmware often ships placeholder serials; they are not identities.
    param($Value)
    $t = ConvertTo-DrishtiText $Value
    if ($null -eq $t) { return $true }
    if ($t -match '^(to be filled by o\.?e\.?m\.?|default string|system serial number|system product name|none|n/a|na|not specified|not applicable|unknown|serial number|123456789|0123456789|1234567890|ffffffff-ffff-ffff-ffff-ffffffffffff|00000000-0000-0000-0000-000000000000)$') { return $true }
    if ($t -match '^(.)\1*$') { return $true }
    return $false
}

function Open-DrishtiRegKey {
    # Read-only registry key (never writable). Returns null when the key does not exist.
    param([string]$Hive, [string]$Path, [string]$View = 'Registry64')
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$Hive, [Microsoft.Win32.RegistryView]$View)
    return $base.OpenSubKey($Path, $false)
}

function Get-DrishtiRegValue {
    param([string]$Hive, [string]$Path, [string]$Name, [string]$View = 'Registry64')
    $k = $null
    try {
        $k = Open-DrishtiRegKey -Hive $Hive -Path $Path -View $View
        if ($null -eq $k) { return $null }
        return $k.GetValue($Name, $null)
    }
    finally { if ($null -ne $k) { $k.Dispose() } }
}

function Read-DrishtiTimed {
    # Runs a script block in a separate runspace with a time limit. Local calls only.
    param([scriptblock]$Script, [int]$TimeoutSec = 10)
    $ps = [powershell]::Create()
    $timedOut = $false
    try {
        [void]$ps.AddScript($Script.ToString())
        $async = $ps.BeginInvoke()
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutSec * 1000)) {
            $timedOut = $true
            [void]$ps.BeginStop($null, $null)
            return @{ ok = $false; value = $null; error = ('timed out after ' + $TimeoutSec + ' s') }
        }
        $out = $ps.EndInvoke($async)
        if ($ps.Streams.Error.Count -gt 0) {
            return @{ ok = $false; value = $null; error = (Get-DrishtiErrorText $ps.Streams.Error[0]) }
        }
        $val = $null
        if ($out.Count -gt 0) { $val = $out[0] }
        return @{ ok = $true; value = $val; error = $null }
    }
    catch { return @{ ok = $false; value = $null; error = (Get-DrishtiErrorText $_) } }
    finally { if (-not $timedOut) { $ps.Dispose() } }
}

# ---------------------------------------------------------------------------------------------
# Redaction (stable salted hashes)
# ---------------------------------------------------------------------------------------------

function Get-DrishtiHash {
    param([string]$Prefix, $Value)
    $t = ConvertTo-DrishtiText $Value
    if ($null -eq $t) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($RedactSalt + '|' + $t.ToUpperInvariant())
        $hex = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
    return $Prefix + '-' + $hex.Substring(0, 12)
}

function Get-DrishtiUserNames {
    # Names of the current user and of local profiles (read only), used to scrub text when redacting.
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($n in @([Environment]::UserName, $env:USERNAME)) {
        $t = ConvertTo-DrishtiText $n
        if ($null -ne $t) { [void]$names.Add($t) }
    }
    $k = $null
    try {
        $k = Open-DrishtiRegKey -Hive 'LocalMachine' -Path 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
        if ($null -ne $k) {
            foreach ($sid in $k.GetSubKeyNames()) {
                if ($sid -notmatch '^S-1-5-21-') { continue }
                $sub = $k.OpenSubKey($sid, $false)
                if ($null -eq $sub) { continue }
                try {
                    $p = [string]$sub.GetValue('ProfileImagePath', '')
                    if ($p) {
                        $leaf = $p.TrimEnd('\').Split('\')[-1]
                        $t = ConvertTo-DrishtiText $leaf
                        if ($null -ne $t) { [void]$names.Add($t) }
                    }
                }
                finally { $sub.Dispose() }
            }
        }
    }
    catch { }
    finally { if ($null -ne $k) { $k.Dispose() } }
    return , @($names | Sort-Object -Unique)
}

function Convert-DrishtiRedactDoc {
    # Hash the identifying fields of the document in place and return the text scrub list.
    param($Doc)
    $scrub = [System.Collections.Generic.List[object]]::new()
    $hostSec = $null
    if ($Doc.Contains('host')) { $hostSec = $Doc['host'] }
    if ($null -ne $hostSec) {
        $pairs = @(
            @('computer_name', 'host'), @('domain_or_workgroup', 'dom'), @('serial_number', 'sn'),
            @('bios_serial', 'sn'), @('uuid', 'uuid')
        )
        foreach ($pr in $pairs) {
            $raw = $hostSec[$pr[0]]
            if ($null -ne $raw) {
                $h = Get-DrishtiHash $pr[1] $raw
                # The domain or workgroup name is hashed in its own field only: a text scrub of a word
                # such as WORKGROUP would also rewrite ordinary values like join_type.
                if ($pr[0] -ne 'domain_or_workgroup') { [void]$scrub.Add(@($raw, $h)) }
                $hostSec[$pr[0]] = $h
            }
        }
    }
    if ($Doc.Contains('hardware') -and $null -ne $Doc['hardware']) {
        $macs = [System.Collections.Generic.List[string]]::new()
        foreach ($m in @($Doc['hardware']['macs'])) {
            $h = Get-DrishtiHash 'mac' $m
            if ($null -ne $h) { [void]$macs.Add($h) }
            [void]$scrub.Add(@($m, $h))
        }
        $Doc['hardware']['macs'] = $macs.ToArray()
    }
    foreach ($u in (Get-DrishtiUserNames)) { [void]$scrub.Add(@($u, (Get-DrishtiHash 'user' $u))) }
    $Doc['redacted'] = $true
    return , $scrub
}

function Convert-DrishtiScrubText {
    # Replace any remaining occurrence of an identifying value (whole token, any case) in the JSON text.
    param([string]$Text, $Scrub)
    # Words that are also schema values (or section words) are never scrubbed as text.
    $structural = '^(domain|workgroup|azure_ad|desktop|laptop|server|unknown|standard|elevated|system|machine|user|ok|error|true|false|null)$'
    $ordered = @($Scrub | Where-Object { $null -ne $_[0] -and ([string]$_[0]).Length -ge 3 -and ([string]$_[0]) -notmatch $structural } | Sort-Object { - ([string]$_[0]).Length })
    foreach ($pair in $ordered) {
        $pattern = '(?<![A-Za-z0-9])' + [regex]::Escape([string]$pair[0]) + '(?![A-Za-z0-9])'
        $Text = [regex]::Replace($Text, $pattern, [string]$pair[1], [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $json = ([string]$pair[0]).Replace('\', '\\')
        if ($json -ne [string]$pair[0]) {
            $pattern2 = '(?<![A-Za-z0-9])' + [regex]::Escape($json) + '(?![A-Za-z0-9])'
            $Text = [regex]::Replace($Text, $pattern2, [string]$pair[1], [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    return $Text
}

# ---------------------------------------------------------------------------------------------
# Section runner: one failing section never stops the others
# ---------------------------------------------------------------------------------------------

function Read-DrishtiSection {
    param([string]$Name, [scriptblock]$Body)
    if (-not (Test-DrishtiWanted $Name)) { return }
    try {
        if ($SimulateFailure -and ($SimulateFailure -ieq $Name)) {
            throw 'simulated failure requested with the SimulateFailure parameter'
        }
        $result = & $Body
        $script:Doc[$Name] = $result
        Note-DrishtiItem $Name 'ok' $null
    }
    catch {
        $script:Doc[$Name] = $null
        $msg = [string]$_.Exception.Message
        if ($msg.StartsWith('UNAVAILABLE:')) {
            Note-DrishtiItem $Name 'unavailable' $msg.Substring(12)
        }
        else {
            Note-DrishtiItem $Name 'error' (Get-DrishtiErrorText $_)
        }
    }
}

# ---------------------------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------------------------

function Get-DrishtiHostInfo {
    $cs = @(Get-DrishtiCimSafe -Class 'Win32_ComputerSystem' -NoteKey 'host.system')
    $bios = @(Get-DrishtiCimSafe -Class 'Win32_BIOS' -NoteKey 'host.bios')
    $prod = @(Get-DrishtiCimSafe -Class 'Win32_ComputerSystemProduct' -NoteKey 'host.product')
    $enc = @(Get-DrishtiCimSafe -Class 'Win32_SystemEnclosure' -NoteKey 'host.enclosure')
    $c = $null; if ($cs.Count -gt 0) { $c = $cs[0] }
    $b = $null; if ($bios.Count -gt 0) { $b = $bios[0] }
    $p = $null; if ($prod.Count -gt 0) { $p = $prod[0] }

    $name = ConvertTo-DrishtiText (Get-DrishtiProp $c 'Name')
    if ($null -eq $name) { $name = ConvertTo-DrishtiText ([Environment]::MachineName) }
    $domain = ConvertTo-DrishtiText (Get-DrishtiProp $c 'Domain')
    $partOf = Get-DrishtiProp $c 'PartOfDomain'

    $aad = $null
    try {
        $jk = Open-DrishtiRegKey -Hive 'LocalMachine' -Path 'SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo'
        if ($null -eq $jk) { $aad = $false } else { $aad = ($jk.SubKeyCount -gt 0); $jk.Dispose() }
    }
    catch { Note-DrishtiItem 'host.azure_ad' 'unavailable' (Get-DrishtiErrorText $_) }

    $join = 'unknown'
    if ($null -ne $partOf -and [bool]$partOf) { $join = 'domain' }
    elseif ($aad -eq $true) { $join = 'azure_ad' }
    elseif ($null -ne $partOf -and $null -ne $domain) { $join = 'workgroup' }

    $serial = $null
    $biosSerialRaw = Get-DrishtiProp $b 'SerialNumber'
    if (-not (Test-DrishtiPlaceholder $biosSerialRaw)) { $serial = ConvertTo-DrishtiText $biosSerialRaw }
    if ($null -eq $serial) {
        $alt = Get-DrishtiProp $p 'IdentifyingNumber'
        if (-not (Test-DrishtiPlaceholder $alt)) { $serial = ConvertTo-DrishtiText $alt }
    }
    if ($null -eq $serial) { Note-DrishtiItem 'host.serial_number' 'unavailable' 'the firmware reports no serial number or only a placeholder' }
    $biosSerial = $null
    if (-not (Test-DrishtiPlaceholder $biosSerialRaw)) { $biosSerial = ConvertTo-DrishtiText $biosSerialRaw }

    $uuid = $null
    $uuidRaw = Get-DrishtiProp $p 'UUID'
    if (-not (Test-DrishtiPlaceholder $uuidRaw)) { $uuid = ConvertTo-DrishtiText $uuidRaw }

    $form = 'unknown'
    $role = Get-DrishtiProp $c 'DomainRole'
    if ($null -ne $role -and [int]$role -ge 2) { $form = 'server' }
    elseif ($enc.Count -gt 0) {
        $types = @(Get-DrishtiProp $enc[0] 'ChassisTypes')
        foreach ($t in $types) {
            if ($null -eq $t) { continue }
            $n = [int]$t
            if (@(8, 9, 10, 11, 12, 14, 30, 31, 32) -contains $n) { $form = 'laptop'; break }
            if (@(3, 4, 5, 6, 7, 13, 15, 16, 24, 34, 35, 36) -contains $n) { $form = 'desktop'; break }
            if (@(17, 23, 25, 28) -contains $n) { $form = 'server'; break }
        }
    }

    return [ordered]@{
        computer_name       = $name
        domain_or_workgroup = $domain
        join_type           = $join
        azure_ad_joined     = $aad
        form_factor         = $form
        manufacturer        = ConvertTo-DrishtiText (Get-DrishtiProp $c 'Manufacturer')
        model               = ConvertTo-DrishtiText (Get-DrishtiProp $c 'Model')
        serial_number       = $serial
        bios_serial         = $biosSerial
        bios_version        = ConvertTo-DrishtiText (Get-DrishtiProp $b 'SMBIOSBIOSVersion')
        uuid                = $uuid
    }
}

function Get-DrishtiOsInfo {
    $osr = @(Get-DrishtiCimSafe -Class 'Win32_OperatingSystem')
    if ($osr.Count -eq 0) { throw 'UNAVAILABLE:Win32_OperatingSystem returned nothing' }
    $o = $osr[0]
    $key = 'SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $ubr = $null; $edition = $null; $display = $null
    try {
        $ubr = Get-DrishtiRegValue 'LocalMachine' $key 'UBR'
        $edition = Get-DrishtiRegValue 'LocalMachine' $key 'EditionID'
        $display = Get-DrishtiRegValue 'LocalMachine' $key 'DisplayVersion'
        if ($null -eq $display) { $display = Get-DrishtiRegValue 'LocalMachine' $key 'ReleaseId' }
    }
    catch { Note-DrishtiItem 'os.registry' 'unavailable' (Get-DrishtiErrorText $_) }

    $build = ConvertTo-DrishtiText (Get-DrishtiProp $o 'BuildNumber')
    if ($null -ne $build -and $null -ne $ubr) { $build = $build + '.' + [string]$ubr }

    $activation = 'unavailable'
    $lic = @(Get-DrishtiCimSafe -Class 'SoftwareLicensingProduct' -Filter "ApplicationId='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -NoteKey 'os.activation')
    if ($lic.Count -gt 0) {
        $map = @('unlicensed', 'licensed', 'grace_oob', 'grace_oot', 'grace_non_genuine', 'notification', 'grace_extended')
        $st = Get-DrishtiProp $lic[0] 'LicenseStatus'
        if ($null -ne $st -and [int]$st -ge 0 -and [int]$st -lt $map.Count) { $activation = $map[[int]$st] }
    }
    elseif (-not ($script:Items | Where-Object { $_['section'] -eq 'os.activation' })) {
        Note-DrishtiItem 'os.activation' 'unavailable' 'no activated Windows licence record was found'
    }

    $boot = Get-DrishtiProp $o 'LastBootUpTime'
    $uptime = $null
    if ($null -ne $boot) {
        try { $uptime = [int64][math]::Max(0, ([datetime]::Now - [datetime]$boot).TotalSeconds) } catch { $uptime = $null }
    }

    return [ordered]@{
        caption          = ConvertTo-DrishtiText (Get-DrishtiProp $o 'Caption')
        version          = ConvertTo-DrishtiText (Get-DrishtiProp $o 'Version')
        build            = $build
        display_version  = ConvertTo-DrishtiText $display
        edition          = ConvertTo-DrishtiText $edition
        architecture     = ConvertTo-DrishtiText (Get-DrishtiProp $o 'OSArchitecture')
        install_date     = Format-DrishtiUtc (Get-DrishtiProp $o 'InstallDate')
        activation_state = $activation
        last_boot_utc    = Format-DrishtiUtc $boot
        uptime_s         = $uptime
    }
}

function Get-DrishtiDiskHealthMap {
    # Drive letter -> Windows storage health (Healthy/Warning/Unhealthy). Not raw SMART attributes.
    $map = @{}
    $ns = 'root/Microsoft/Windows/Storage'
    $parts = @(Get-DrishtiCimSafe -Class 'MSFT_Partition' -Namespace $ns -NoteKey 'hardware.smart')
    $disks = @(Get-DrishtiCimSafe -Class 'MSFT_PhysicalDisk' -Namespace $ns -NoteKey 'hardware.smart')
    $health = @{}
    foreach ($d in $disks) {
        $id = [string](Get-DrishtiProp $d 'DeviceId')
        $hs = Get-DrishtiProp $d 'HealthStatus'
        if ($id -and $null -ne $hs) {
            $label = 'unavailable'
            switch ([int]$hs) { 0 { $label = 'healthy' } 1 { $label = 'warning' } 2 { $label = 'unhealthy' } }
            $health[$id] = $label
        }
    }
    foreach ($pt in $parts) {
        $dl = Get-DrishtiProp $pt 'DriveLetter'
        if ($null -eq $dl) { continue }
        $letter = ''
        try { $letter = [string][char]$dl } catch { $letter = '' }
        if ($letter -notmatch '^[A-Za-z]$') { continue }
        $dn = [string](Get-DrishtiProp $pt 'DiskNumber')
        if ($dn -and $health.ContainsKey($dn)) { $map[$letter.ToUpperInvariant() + ':'] = $health[$dn] }
    }
    return $map
}

function Get-DrishtiHardwareInfo {
    $cpus = @(Get-DrishtiCimSafe -Class 'Win32_Processor' -NoteKey 'hardware.cpu')
    $cs = @(Get-DrishtiCimSafe -Class 'Win32_ComputerSystem' -NoteKey 'hardware.memory')
    $cores = 0; $logical = 0
    foreach ($c in $cpus) {
        $cores += [int](Get-DrishtiProp $c 'NumberOfCores')
        $logical += [int](Get-DrishtiProp $c 'NumberOfLogicalProcessors')
    }
    $ram = $null
    if ($cs.Count -gt 0) {
        $tp = Get-DrishtiProp $cs[0] 'TotalPhysicalMemory'
        if ($null -ne $tp) { $ram = ConvertTo-DrishtiInt ([double]$tp / 1MB) }
    }

    $healthMap = Get-DrishtiDiskHealthMap
    $disks = [System.Collections.Generic.List[object]]::new()
    $missingHealth = 0
    foreach ($d in @(Get-DrishtiCimSafe -Class 'Win32_LogicalDisk' -Filter 'DriveType=3' -NoteKey 'hardware.disks')) {
        $drive = ConvertTo-DrishtiText (Get-DrishtiProp $d 'DeviceID')
        $size = Get-DrishtiProp $d 'Size'
        $free = Get-DrishtiProp $d 'FreeSpace'
        $smart = 'unavailable'
        if ($null -ne $drive -and $healthMap.ContainsKey($drive.ToUpperInvariant())) { $smart = $healthMap[$drive.ToUpperInvariant()] } else { $missingHealth++ }
        if ($null -eq $drive) { continue }
        [void]$disks.Add([ordered]@{
                drive        = $drive
                label        = ConvertTo-DrishtiText (Get-DrishtiProp $d 'VolumeName')
                fs           = ConvertTo-DrishtiText (Get-DrishtiProp $d 'FileSystem')
                size_gb      = $(if ($null -ne $size) { ConvertTo-DrishtiNumber ([double]$size / 1GB) 2 } else { $null })
                free_gb      = $(if ($null -ne $free) { ConvertTo-DrishtiNumber ([double]$free / 1GB) 2 } else { $null })
                smart_status = $smart
            })
    }
    if ($missingHealth -gt 0 -and -not ($script:Items | Where-Object { $_['section'] -eq 'hardware.smart' })) {
        Note-DrishtiItem 'hardware.smart' 'unavailable' ('storage health is not exposed for ' + $missingHealth + ' drive(s)')
    }

    $gpu = [System.Collections.Generic.List[object]]::new()
    foreach ($g in @(Get-DrishtiCimSafe -Class 'Win32_VideoController' -NoteKey 'hardware.gpu')) {
        if ($gpu.Count -ge 16) { break }
        $ramB = Get-DrishtiProp $g 'AdapterRAM'
        $ramMb = $null
        if ($null -ne $ramB -and [double]$ramB -gt 0) { $ramMb = ConvertTo-DrishtiInt ([double]$ramB / 1MB) }
        [void]$gpu.Add([ordered]@{
                name           = ConvertTo-DrishtiText (Get-DrishtiProp $g 'Name')
                driver_version = ConvertTo-DrishtiText (Get-DrishtiProp $g 'DriverVersion')
                adapter_ram_mb = $ramMb
            })
    }

    $macs = [System.Collections.Generic.List[string]]::new()
    foreach ($n in @(Get-DrishtiCimSafe -Class 'Win32_NetworkAdapter' -Filter 'PhysicalAdapter=TRUE' -NoteKey 'hardware.macs')) {
        $m = ConvertTo-DrishtiText (Get-DrishtiProp $n 'MACAddress')
        if ($null -ne $m -and $m -match '^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$') {
            $mu = $m.ToUpperInvariant()
            if (-not $macs.Contains($mu) -and $macs.Count -lt 32) { [void]$macs.Add($mu) }
        }
    }

    $cpuName = $null
    if ($cpus.Count -gt 0) { $cpuName = ConvertTo-DrishtiText (Get-DrishtiProp $cpus[0] 'Name') }
    return [ordered]@{
        cpu_name     = $cpuName
        cpu_cores    = $(if ($cpus.Count -gt 0) { $cores } else { $null })
        cpu_logical  = $(if ($cpus.Count -gt 0) { $logical } else { $null })
        ram_total_mb = $ram
        disks        = $disks.ToArray()
        gpu          = $gpu.ToArray()
        macs         = $macs.ToArray()
    }
}

function Get-DrishtiNetworkInfo {
    $statusNames = @('disconnected', 'connecting', 'connected', 'disconnecting', 'hardware_not_present', 'hardware_disabled', 'hardware_malfunction', 'media_disconnected', 'authenticating', 'authentication_succeeded', 'authentication_failed', 'invalid_address', 'credentials_required')
    $cfgs = @{}
    foreach ($c in @(Get-DrishtiCimSafe -Class 'Win32_NetworkAdapterConfiguration' -NoteKey 'network.config')) {
        $idx = Get-DrishtiProp $c 'Index'
        if ($null -ne $idx) { $cfgs[[int]$idx] = $c }
    }
    $out = [System.Collections.Generic.List[object]]::new()
    foreach ($a in @(Get-DrishtiCimSafe -Class 'Win32_NetworkAdapter' -Filter 'NetConnectionID IS NOT NULL' -NoteKey 'network.adapters')) {
        if ($out.Count -ge 32) { break }
        $idx = Get-DrishtiProp $a 'Index'
        $cfg = $null
        if ($null -ne $idx -and $cfgs.ContainsKey([int]$idx)) { $cfg = $cfgs[[int]$idx] }
        $st = Get-DrishtiProp $a 'NetConnectionStatus'
        $status = 'unknown'
        if ($null -ne $st -and [int]$st -ge 0 -and [int]$st -lt $statusNames.Count) { $status = $statusNames[[int]$st] }
        $speed = Get-DrishtiProp $a 'Speed'
        $mbps = $null
        if ($null -ne $speed -and [double]$speed -gt 0 -and [double]$speed -lt 1e14) { $mbps = ConvertTo-DrishtiNumber ([double]$speed / 1e6) 0 }
        $v4 = @(); $gw = @(); $dns = @(); $dhcp = $null
        if ($null -ne $cfg) {
            $dhcp = Get-DrishtiProp $cfg 'DHCPEnabled'
            if ($null -ne $dhcp) { $dhcp = [bool]$dhcp }
            $v4 = @(@(Get-DrishtiProp $cfg 'IPAddress') | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            $gw = @(@(Get-DrishtiProp $cfg 'DefaultIPGateway') | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
            $dns = @(@(Get-DrishtiProp $cfg 'DNSServerSearchOrder') | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' })
        }
        [void]$out.Add([ordered]@{
                adapter         = ConvertTo-DrishtiText (Get-DrishtiProp $a 'NetConnectionID')
                status          = $status
                link_speed_mbps = $mbps
                dhcp            = $dhcp
                ipv4            = ConvertTo-DrishtiList $v4
                gateway         = ConvertTo-DrishtiList $gw
                dns             = ConvertTo-DrishtiList $dns
            })
    }
    return , $out.ToArray()
}

function Read-DrishtiUninstallKey {
    # Adds the entries of one Uninstall key to $List. Read only.
    param($Root, [string]$Scope, $Seen, $List, $Counter)
    $un = $null
    try {
        $un = $Root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
        if ($null -eq $un) { return }
        foreach ($sub in $un.GetSubKeyNames()) {
            $k = $null
            try {
                $k = $un.OpenSubKey($sub, $false)
                if ($null -eq $k) { continue }
                $name = ConvertTo-DrishtiText ($k.GetValue('DisplayName', $null))
                if ($null -eq $name) { continue }
                $sysComp = $k.GetValue('SystemComponent', 0)
                if ($null -ne $sysComp -and [int]$sysComp -eq 1) { continue }
                if ($null -ne $k.GetValue('ParentKeyName', $null)) { continue }
                $rel = [string]$k.GetValue('ReleaseType', '')
                if ($rel -match '^(Update|Hotfix|Security Update|Service Pack|Update Rollup)$') { continue }
                if ($name -match '^(Security Update|Hotfix|Update) for .*\(KB\d+\)') { continue }
                $ver = ConvertTo-DrishtiText ($k.GetValue('DisplayVersion', $null))
                $key = $name.ToLowerInvariant() + '|' + [string]$ver
                if ($Seen.ContainsKey($key)) { continue }
                $Seen[$key] = $true
                $date = $null
                $raw = [string]$k.GetValue('InstallDate', '')
                if ($raw -match '^(\d{4})(\d{2})(\d{2})$') {
                    $date = $Matches[1] + '-' + $Matches[2] + '-' + $Matches[3]
                    try { [void][datetime]::ParseExact($date, 'yyyy-MM-dd', $script:Inv) } catch { $date = $null }
                }
                $Counter.Total++
                [void]$List.Add([ordered]@{
                        name         = $name
                        version      = $ver
                        publisher    = ConvertTo-DrishtiText ($k.GetValue('Publisher', $null))
                        install_date = $date
                        scope        = $Scope
                    })
            }
            catch { }
            finally { if ($null -ne $k) { $k.Dispose() } }
        }
    }
    finally { if ($null -ne $un) { $un.Dispose() } }
}

function Get-DrishtiSoftwareInfo {
    $list = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    $counter = [pscustomobject]@{ Total = 0 }
    # Machine-wide: 64-bit view and the 32-bit (WOW6432Node) view.
    foreach ($view in @('Registry64', 'Registry32')) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]$view)
        try { Read-DrishtiUninstallKey $base 'machine' $seen $list $counter }
        catch { Note-DrishtiItem ('software.machine_' + $view.ToLowerInvariant()) 'unavailable' (Get-DrishtiErrorText $_) }
    }
    # Per user: only hives that are already loaded (the signed-in user, or every signed-in user when
    # running as SYSTEM). Hives of users who are not signed in are NOT loaded (loading writes to the
    # registry), so their per-user software is not included.
    $hivesRead = 0; $hivesDenied = 0
    foreach ($sid in [Microsoft.Win32.Registry]::Users.GetSubKeyNames()) {
        if ($sid -notmatch '^S-1-5-21-[0-9-]+$') { continue }
        $root = $null
        try {
            $root = [Microsoft.Win32.Registry]::Users.OpenSubKey($sid, $false)
            if ($null -ne $root) { Read-DrishtiUninstallKey $root 'user' $seen $list $counter; $hivesRead++ }
        }
        catch { $hivesDenied++ }
        finally { if ($null -ne $root) { $root.Dispose() } }
    }
    $reason = 'read ' + $hivesRead + ' loaded user hive(s); users who are not signed in are not included'
    if ($hivesDenied -gt 0) { $reason = $reason + '; ' + $hivesDenied + ' hive(s) denied' }
    Note-DrishtiItem 'software.per_user' 'ok' $reason

    $sorted = @($list | Sort-Object { $_['name'] }, { $_['version'] })
    if ($sorted.Count -gt $script:MaxSoftware) {
        Note-DrishtiItem 'software.truncated' 'ok' ('list cut to ' + $script:MaxSoftware + ' of ' + $sorted.Count + ' entries')
        $sorted = @($sorted | Select-Object -First $script:MaxSoftware)
    }
    return , $sorted
}

function Get-DrishtiServicesInfo {
    $defaults = @('wuauserv', 'WinDefend', 'mpssvc', 'W32Time', 'Spooler', 'RpcSs', 'Dhcp', 'Dnscache')
    $agentNames = @('DrishtiAgent', 'CityKartAgent')
    $names = [System.Collections.Generic.List[string]]::new()
    $custom = @()
    foreach ($s in @($RequiredServices)) {
        if ($null -eq $s) { continue }
        foreach ($p in ([string]$s -split '[,;]')) { $t = ConvertTo-DrishtiText $p; if ($null -ne $t) { $custom += $t } }
    }
    if ($custom.Count -gt 0) { foreach ($c in $custom) { [void]$names.Add($c) } }
    else { foreach ($d in $defaults) { [void]$names.Add($d) } }

    $all = @(Get-DrishtiCimSafe -Class 'Win32_Service' -NoteKey 'services.query')
    if ($all.Count -eq 0) { throw 'UNAVAILABLE:the service list could not be read' }
    $byName = @{}
    foreach ($s in $all) { $n = [string](Get-DrishtiProp $s 'Name'); if ($n) { $byName[$n.ToLowerInvariant()] = $s } }
    if ($custom.Count -eq 0) {
        foreach ($a in $agentNames) { if ($byName.ContainsKey($a.ToLowerInvariant())) { [void]$names.Add($a) } }
    }

    $out = [System.Collections.Generic.List[object]]::new()
    $done = @{}
    foreach ($n in $names) {
        $key = $n.ToLowerInvariant()
        if ($done.ContainsKey($key) -or $out.Count -ge 64) { continue }
        $done[$key] = $true
        if (-not $byName.ContainsKey($key)) {
            [void]$out.Add([ordered]@{ name = $n; display_name = $null; status = 'not_installed'; start_type = 'unavailable' })
            continue
        }
        $s = $byName[$key]
        $state = ([string](Get-DrishtiProp $s 'State')).ToLowerInvariant().Replace(' ', '_')
        if (@('running', 'stopped', 'start_pending', 'stop_pending', 'paused', 'continue_pending', 'pause_pending') -notcontains $state) { $state = 'unknown' }
        $mode = ([string](Get-DrishtiProp $s 'StartMode')).ToLowerInvariant()
        $start = 'unavailable'
        if ($mode -eq 'auto') {
            $start = 'automatic'
            $delayed = Get-DrishtiProp $s 'DelayedAutoStart'
            if ($null -ne $delayed -and [bool]$delayed) { $start = 'automatic_delayed' }
        }
        elseif ($mode -eq 'manual') { $start = 'manual' }
        elseif ($mode -eq 'disabled') { $start = 'disabled' }
        elseif ($mode -eq 'boot' -or $mode -eq 'system') { $start = 'automatic' }
        [void]$out.Add([ordered]@{
                name         = ConvertTo-DrishtiText (Get-DrishtiProp $s 'Name')
                display_name = ConvertTo-DrishtiText (Get-DrishtiProp $s 'DisplayName')
                status       = $state
                start_type   = $start
            })
    }
    return [ordered]@{ required = $out.ToArray() }
}

function Get-DrishtiAntivirus {
    # Windows Security Center (client SKUs), else Microsoft Defender, else 'unavailable'.
    $sc = $null
    try {
        $sc = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName 'AntiVirusProduct' -ErrorAction Stop)
    }
    catch { $sc = $null }
    if ($null -ne $sc -and $sc.Count -gt 0) {
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($p in $sc) {
            if ($out.Count -ge 16) { break }
            $ps = Get-DrishtiProp $p 'productState'
            $state = 'unknown'
            if ($null -ne $ps) {
                $hex = ([int64]$ps).ToString('X6')
                $on = $hex.Substring(2, 2)
                $upd = $hex.Substring(4, 2)
                if ($on -eq '10') { if ($upd -eq '00') { $state = 'on_up_to_date' } else { $state = 'on_out_of_date' } }
                elseif ($on -eq '00') { $state = 'off' }
                elseif ($on -eq '01') { $state = 'expired' }
                elseif ($on -eq '11') { $state = 'snoozed' }
            }
            [void]$out.Add([ordered]@{
                    name                       = ConvertTo-DrishtiText (Get-DrishtiProp $p 'displayName')
                    state                      = $state
                    signature_last_updated_utc = $null
                })
        }
        return , $out.ToArray()
    }
    try {
        $mp = Get-MpComputerStatus -ErrorAction Stop
        $enabled = Get-DrishtiProp $mp 'AntivirusEnabled'
        $rtp = Get-DrishtiProp $mp 'RealTimeProtectionEnabled'
        $age = Get-DrishtiProp $mp 'AntivirusSignatureAge'
        $state = 'unknown'
        if ($null -ne $enabled) {
            if (-not [bool]$enabled) { $state = 'off' }
            elseif ($null -ne $rtp -and -not [bool]$rtp) { $state = 'off' }
            elseif ($null -ne $age -and [int]$age -gt 7) { $state = 'on_out_of_date' }
            else { $state = 'on_up_to_date' }
        }
        return , @([ordered]@{
                name                       = 'Microsoft Defender Antivirus'
                state                      = $state
                signature_last_updated_utc = Format-DrishtiUtc (Get-DrishtiProp $mp 'AntivirusSignatureLastUpdated')
            })
    }
    catch {
        Note-DrishtiItem 'security.antivirus' 'unavailable' ('Security Center and Defender status could not be read: ' + (Get-DrishtiErrorText $_))
        return 'unavailable'
    }
}

function Get-DrishtiFirewallProfiles {
    try {
        $out = [System.Collections.Generic.List[object]]::new()
        foreach ($p in @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)) {
            $n = ([string](Get-DrishtiProp $p 'Name')).ToLowerInvariant()
            if (@('domain', 'private', 'public') -notcontains $n) { continue }
            $en = Get-DrishtiProp $p 'Enabled'
            $val = $null
            if ($null -ne $en) { $val = ([string]$en -eq 'True' -or [string]$en -eq '1') }
            [void]$out.Add([ordered]@{ profile = $n; enabled = $val })
        }
        if ($out.Count -eq 0) { throw 'no firewall profile returned' }
        return , $out.ToArray()
    }
    catch {
        Note-DrishtiItem 'security.firewall' 'unavailable' (Get-DrishtiErrorText $_)
        return 'unavailable'
    }
}

function Get-DrishtiBitLocker {
    param([string]$Privilege)
    $drive = $env:SystemDrive
    if (-not $drive) { $drive = 'C:' }
    # 1) Elevated / SYSTEM: the volume encryption provider. (Skipped for a standard user: the provider
    #    always answers "access denied", and the refusal takes about five seconds.)
    if ($Privilege -ne 'standard') {
        try {
            $v = @(Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName 'Win32_EncryptableVolume' -Filter ("DriveLetter='" + $drive + "'") -ErrorAction Stop)
            if ($v.Count -gt 0) {
                $ps = Get-DrishtiProp $v[0] 'ProtectionStatus'
                if ($null -ne $ps -and [int]$ps -eq 1) { return 'protected' }
                if ($null -ne $ps -and [int]$ps -eq 0) { return 'off' }
            }
        }
        catch { }
    }
    # 2) Standard user: the shell's volume property (what Explorer uses). Only the value 1 is trusted as
    #    "protected"; other values are not mapped because their meaning is not verified on a lab machine.
    $code = $null
    try {
        $sh = [Activator]::CreateInstance([type]::GetTypeFromProgID('Shell.Application'))
        $ns = $sh.NameSpace($drive + '\')
        $code = $ns.Self.ExtendedProperty('System.Volume.BitLockerProtection')
    }
    catch { $code = $null }
    if ($null -ne $code -and [int]$code -eq 1) {
        Note-DrishtiItem 'security.bitlocker' 'ok' 'read from the shell volume property (not elevated)'
        return 'protected'
    }
    $why = 'BitLocker state needs an elevation or a SYSTEM token'
    if ($null -ne $code) { $why = $why + '; the unelevated shell property reported code ' + [int]$code + ', which is not mapped to a state' }
    Note-DrishtiItem 'security.bitlocker' 'unavailable' $why
    return 'unavailable'
}

function Get-DrishtiTpm {
    param([string]$Privilege)
    if ($Privilege -ne 'standard') {
        try {
            $t = @(Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftTpm' -ClassName 'Win32_Tpm' -ErrorAction Stop)
            if ($t.Count -eq 0) { return [ordered]@{ present = $false; version = $null } }
            $spec = ConvertTo-DrishtiText (Get-DrishtiProp $t[0] 'SpecVersion')
            $ver = $null
            if ($null -ne $spec) { $ver = ($spec -split ',')[0].Trim() }
            return [ordered]@{ present = $true; version = $ver }
        }
        catch { }
    }
    # Not elevated: the device list shows a TPM only when the firmware exposes one and it is enabled.
    try {
        $dev = @(Get-CimInstance -ClassName 'Win32_PnPEntity' -Filter "PNPClass='SecurityDevices'" -ErrorAction Stop)
        foreach ($d in $dev) {
            $nm = [string](Get-DrishtiProp $d 'Name')
            if ($nm -match 'Trusted Platform Module\s*([0-9.]+)?') {
                $v = $null
                if ($Matches.Count -gt 1 -and $Matches[1]) { $v = $Matches[1] }
                Note-DrishtiItem 'security.tpm' 'ok' 'read from the device list (not elevated); ready/enabled state not read'
                return [ordered]@{ present = $true; version = $v }
            }
        }
        Note-DrishtiItem 'security.tpm' 'ok' 'no TPM device listed (not elevated; a TPM disabled in firmware is not listed)'
        return [ordered]@{ present = $false; version = $null }
    }
    catch {
        Note-DrishtiItem 'security.tpm' 'unavailable' (Get-DrishtiErrorText $_)
        return 'unavailable'
    }
}

function Get-DrishtiSecureBoot {
    try {
        $fw = Get-DrishtiRegValue 'LocalMachine' 'SYSTEM\CurrentControlSet\Control' 'PEFirmwareType'
        $state = Get-DrishtiRegValue 'LocalMachine' 'SYSTEM\CurrentControlSet\Control\SecureBoot\State' 'UEFISecureBootEnabled'
        if ($null -ne $state) { if ([int]$state -eq 1) { return 'on' } else { return 'off' } }
        if ($null -ne $fw -and [int]$fw -eq 1) { return 'unsupported' }
        Note-DrishtiItem 'security.secure_boot' 'unavailable' 'UEFI firmware but the Secure Boot state is not readable'
        return 'unavailable'
    }
    catch {
        Note-DrishtiItem 'security.secure_boot' 'unavailable' (Get-DrishtiErrorText $_)
        return 'unavailable'
    }
}

function Get-DrishtiSecurityInfo {
    $av = Get-DrishtiAntivirus
    $fw = Get-DrishtiFirewallProfiles
    $priv = Get-DrishtiPrivilege
    $bl = Get-DrishtiBitLocker $priv
    $tpm = Get-DrishtiTpm $priv
    $sb = Get-DrishtiSecureBoot
    return [ordered]@{
        antivirus         = $av
        firewall_profiles = $fw
        bitlocker         = [ordered]@{ system_drive = $bl }
        tpm               = $tpm
        secure_boot       = $sb
    }
}

function Get-DrishtiPendingReboot {
    $sources = [System.Collections.Generic.List[string]]::new()
    $readable = 0
    $checks = @(
        @('component_servicing', 'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending', $null),
        @('windows_update', 'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired', $null),
        @('file_rename', 'SYSTEM\CurrentControlSet\Control\Session Manager', 'PendingFileRenameOperations'),
        @('update_exe', 'SOFTWARE\Microsoft\Updates\UpdateExeVolatile', 'Flags')
    )
    foreach ($c in $checks) {
        $k = $null
        try {
            $k = Open-DrishtiRegKey -Hive 'LocalMachine' -Path $c[1]
            $readable++
            if ($null -ne $k) {
                if ($null -eq $c[2]) {
                    # Presence of the key is the indicator.
                    [void]$sources.Add($c[0])
                }
                elseif ($c[0] -eq 'file_rename') {
                    $v = @($k.GetValue($c[2], $null) | Where-Object { $_ -ne '' -and $null -ne $_ })
                    if ($v.Count -gt 0) { [void]$sources.Add($c[0]) }
                }
                else {
                    $v = $k.GetValue($c[2], $null)
                    if ($null -ne $v -and [int]$v -ne 0) { [void]$sources.Add($c[0]) }
                }
            }
        }
        catch { }
        finally { if ($null -ne $k) { $k.Dispose() } }
    }
    $pending = $null
    if ($readable -gt 0 -or $sources.Count -gt 0) { $pending = ($sources.Count -gt 0) }
    return @{ pending = $pending; sources = $sources.ToArray() }
}

function Get-DrishtiUpdatesInfo {
    $pr = Get-DrishtiPendingReboot
    if ($null -eq $pr['pending']) { Note-DrishtiItem 'updates.pending_reboot' 'unavailable' 'the reboot indicators could not be read' }

    # Hotfix list (local WMI data).
    $hot = [System.Collections.Generic.List[object]]::new()
    $hotMax = $null
    try {
        $all = @(Get-HotFix -ErrorAction Stop | Sort-Object { if ($null -ne $_.InstalledOn) { $_.InstalledOn } else { [datetime]::MinValue } } -Descending)
        foreach ($h in $all) {
            $id = ConvertTo-DrishtiText (Get-DrishtiProp $h 'HotFixID')
            if ($null -eq $id) { continue }
            $on = Get-DrishtiProp $h 'InstalledOn'
            if ($null -ne $on -and ($null -eq $hotMax -or [datetime]$on -gt $hotMax)) { $hotMax = [datetime]$on }
            if ($hot.Count -lt $script:MaxHotfixes) { [void]$hot.Add([ordered]@{ id = $id; installed_on = (Format-DrishtiDay $on) }) }
        }
    }
    catch { Note-DrishtiItem 'updates.hotfixes' 'unavailable' (Get-DrishtiErrorText $_) }

    # Update history through the local Windows Update Agent (no server contact), with a time limit.
    $lastInstall = $null
    # The Windows Update Agent reports its dates in UTC. The result is "history|lastScan" as ISO text.
    $hist = Read-DrishtiTimed -TimeoutSec 5 -Script {
        $fmt = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        $inv = [System.Globalization.CultureInfo]::InvariantCulture
        $latest = $null
        $s = [Activator]::CreateInstance([type]::GetTypeFromProgID('Microsoft.Update.Session'))
        $se = $s.CreateUpdateSearcher()
        $n = $se.GetTotalHistoryCount()
        if ($n -gt 0) {
            $take = [Math]::Min($n, 100)
            foreach ($e in $se.QueryHistory(0, $take)) {
                if ($e.Operation -eq 1 -and $e.ResultCode -eq 2) {
                    $d = [datetime]::SpecifyKind($e.Date, [System.DateTimeKind]::Utc)
                    if ($null -eq $latest -or $d -gt $latest) { $latest = $d }
                }
            }
        }
        $scan = ''
        try {
            $au = [Activator]::CreateInstance([type]::GetTypeFromProgID('Microsoft.Update.AutoUpdate'))
            $sd = [datetime]$au.Results.LastSearchSuccessDate
            if ($sd.Year -gt 1990) { $scan = [datetime]::SpecifyKind($sd, [System.DateTimeKind]::Utc).ToString($fmt, $inv) }
        }
        catch { $scan = '' }
        $first = ''
        if ($null -ne $latest) { $first = $latest.ToString($fmt, $inv) }
        $first + '|' + $scan
    }
    $lastScan = $null
    if ($hist['ok'] -and $hist['value']) {
        $parts = ([string]$hist['value']).Split('|')
        if ($parts.Count -ge 1 -and $parts[0]) { $lastInstall = $parts[0] }
        if ($parts.Count -ge 2 -and $parts[1]) { $lastScan = $parts[1] }
    }
    if ($null -eq $lastInstall) {
        if ($null -ne $hotMax) {
            $lastInstall = $hotMax.ToString("yyyy-MM-dd'T'00:00:00'Z'", $script:Inv)
            Note-DrishtiItem 'updates.last_install' 'ok' 'taken from the hotfix list (update history unavailable or empty); day precision'
        }
        else {
            $why = 'no successful update installation is recorded'
            if (-not $hist['ok']) { $why = [string]$hist['error'] }
            Note-DrishtiItem 'updates.last_install' 'unavailable' $why
        }
    }

    # Pending count from the local Windows Update cache only (Online = false: no server is contacted).
    $pendingCount = 'unavailable'
    $cnt = Read-DrishtiTimed -TimeoutSec 6 -Script {
        $s = [Activator]::CreateInstance([type]::GetTypeFromProgID('Microsoft.Update.Session'))
        $se = $s.CreateUpdateSearcher()
        $se.Online = $false
        $r = $se.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
        [int]$r.Updates.Count
    }
    if ($cnt['ok'] -and $null -ne $cnt['value'] -and $null -ne $lastScan) {
        $pendingCount = [int]$cnt['value']
    }
    elseif ($cnt['ok'] -and $null -eq $lastScan) {
        Note-DrishtiItem 'updates.pending_count' 'unavailable' 'no record of a successful Windows Update scan, so the offline cache cannot be trusted'
    }
    else {
        Note-DrishtiItem 'updates.pending_count' 'unavailable' ([string]$cnt['error'])
    }

    return [ordered]@{
        pending_reboot         = $pr['pending']
        pending_reboot_sources = $pr['sources']
        last_install_utc       = $lastInstall
        last_scan_utc          = $lastScan
        pending_count          = $pendingCount
        hotfixes               = $hot.ToArray()
    }
}

function Get-DrishtiMetricsInfo {
    # CPU: average of 3 samples one second apart (local performance data, language independent).
    # Four raw readings one second apart give three 1-second samples (idle-timer delta over time delta).
    $samples = [System.Collections.Generic.List[double]]::new()
    $prev = $null
    for ($i = 0; $i -lt 4; $i++) {
        if ($i -gt 0) { [System.Threading.Thread]::Sleep(1000) }
        $cur = $null
        try {
            $p = @(Get-CimInstance -ClassName 'Win32_PerfRawData_PerfOS_Processor' -Filter "Name='_Total'" -ErrorAction Stop)
            if ($p.Count -gt 0) {
                $cur = @([double](Get-DrishtiProp $p[0] 'PercentProcessorTime'), [double](Get-DrishtiProp $p[0] 'Timestamp_Sys100NS'))
            }
        }
        catch { $cur = $null }
        if ($null -ne $prev -and $null -ne $cur) {
            $dN = $cur[0] - $prev[0]
            $dD = $cur[1] - $prev[1]
            if ($dD -gt 0) {
                $v = (1 - ($dN / $dD)) * 100
                if ($v -lt 0) { $v = 0 }
                if ($v -gt 100) { $v = 100 }
                [void]$samples.Add($v)
            }
        }
        $prev = $cur
    }
    if ($samples.Count -eq 0) {
        # Fallback: the processor's own load figure.
        try {
            $q = @(Get-CimInstance -ClassName 'Win32_Processor' -ErrorAction Stop)
            $vals = @($q | ForEach-Object { Get-DrishtiProp $_ 'LoadPercentage' } | Where-Object { $null -ne $_ })
            if ($vals.Count -gt 0) { [void]$samples.Add([double](($vals | Measure-Object -Average).Average)) }
        }
        catch { }
    }
    $cpu = $null
    if ($samples.Count -gt 0) {
        $cpu = ConvertTo-DrishtiNumber (($samples | Measure-Object -Average).Average) 1
        if ($cpu -gt 100) { $cpu = 100 }
        if ($cpu -lt 0) { $cpu = 0 }
    }
    else { Note-DrishtiItem 'metrics.cpu' 'unavailable' 'no processor load sample could be read' }

    $ramPct = $null; $ramUsed = $null
    $osr = @(Get-DrishtiCimSafe -Class 'Win32_OperatingSystem' -NoteKey 'metrics.memory')
    if ($osr.Count -gt 0) {
        $tot = Get-DrishtiProp $osr[0] 'TotalVisibleMemorySize'
        $fre = Get-DrishtiProp $osr[0] 'FreePhysicalMemory'
        if ($null -ne $tot -and $null -ne $fre -and [double]$tot -gt 0) {
            $usedKb = [double]$tot - [double]$fre
            $ramUsed = ConvertTo-DrishtiInt ($usedKb / 1024)
            $ramPct = ConvertTo-DrishtiNumber (100 * $usedKb / [double]$tot) 1
        }
    }
    $disks = [System.Collections.Generic.List[object]]::new()
    foreach ($d in @(Get-DrishtiCimSafe -Class 'Win32_LogicalDisk' -Filter 'DriveType=3' -NoteKey 'metrics.disks')) {
        $drive = ConvertTo-DrishtiText (Get-DrishtiProp $d 'DeviceID')
        $size = Get-DrishtiProp $d 'Size'
        $free = Get-DrishtiProp $d 'FreeSpace'
        if ($null -eq $drive) { continue }
        $pct = $null
        if ($null -ne $size -and $null -ne $free -and [double]$size -gt 0) { $pct = ConvertTo-DrishtiNumber (100 * [double]$free / [double]$size) 1 }
        [void]$disks.Add([ordered]@{ drive = $drive; free_pct = $pct })
    }
    return [ordered]@{
        cpu_pct      = $cpu
        cpu_samples  = $samples.Count
        ram_used_pct = $ramPct
        ram_used_mb  = $ramUsed
        disks        = $disks.ToArray()
    }
}

# ---------------------------------------------------------------------------------------------
# Self test (built-in schema rules; prints no machine data)
# ---------------------------------------------------------------------------------------------

function Get-DrishtiStringsDeep {
    param($Value, $Into)
    if ($null -eq $Value) { return }
    if ($Value -is [string]) { [void]$Into.Add($Value); return }
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($k in $Value.Keys) { Get-DrishtiStringsDeep $Value[$k] $Into }
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($v in $Value) { Get-DrishtiStringsDeep $v $Into }
    }
}

function Test-DrishtiDocument {
    # Returns @{ checks = n; failures = @(names) }.
    param($Doc, $Json)
    $fail = [System.Collections.Generic.List[string]]::new()
    $n = 0
    $check = {
        param([string]$Name, [bool]$Ok)
        $script:SelfChecks++
        if (-not $Ok) { [void]$script:SelfFailures.Add($Name) }
    }
    $script:SelfChecks = 0
    $script:SelfFailures = $fail

    & $check 'schema_version' ($Doc['schema_version'] -eq '1.0')
    & $check 'collected_at_utc' ([string]$Doc['collected_at'] -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
    & $check 'collector_version' (-not [string]::IsNullOrEmpty([string]$Doc['collector_version']))
    & $check 'collection_present' ($Doc.Contains('collection') -and $null -ne $Doc['collection'])

    $topStatus = @{}
    foreach ($it in $Doc['collection']['items']) {
        & $check 'item_status_value' (@('ok', 'unavailable', 'error') -contains $it['status'])
        & $check 'item_section_name' ([string]$it['section'] -match '^[a-z_]+(\.[a-z_0-9]+)?$')
        if ($it['status'] -ne 'ok') { & $check 'item_reason_present' (-not [string]::IsNullOrEmpty([string]$it['reason'])) }
        if (([string]$it['section']) -notmatch '\.') { $topStatus[[string]$it['section']] = $it['status'] }
    }
    foreach ($s in $script:Wanted) {
        & $check ('section_' + $s + '_present') ($Doc.Contains($s))
        & $check ('section_' + $s + '_status') ($topStatus.ContainsKey($s))
        if ($topStatus.ContainsKey($s) -and $topStatus[$s] -eq 'ok') { & $check ('section_' + $s + '_filled') ($null -ne $Doc[$s]) }
    }
    foreach ($s in $script:AllSections) {
        if ($script:Wanted -notcontains $s) { & $check ('section_' + $s + '_absent') (-not $Doc.Contains($s)) }
    }

    $strings = [System.Collections.Generic.List[string]]::new()
    Get-DrishtiStringsDeep $Doc $strings
    $long = 0; $ctrl = 0
    foreach ($s in $strings) {
        if ($s.Length -gt $script:MaxText) { $long++ }
        if ([regex]::IsMatch($s, '[\x00-\x1F\x7F-\x9F]')) { $ctrl++ }
    }
    & $check 'strings_within_256' ($long -eq 0)
    & $check 'no_control_characters' ($ctrl -eq 0)

    if ($Doc.Contains('software') -and $null -ne $Doc['software']) { & $check 'software_cap' (@($Doc['software']).Count -le $script:MaxSoftware) }
    if ($Doc.Contains('updates') -and $null -ne $Doc['updates']) { & $check 'hotfix_cap' (@($Doc['updates']['hotfixes']).Count -le $script:MaxHotfixes) }
    if ($Doc.Contains('host') -and $null -ne $Doc['host']) {
        & $check 'join_type_value' (@('domain', 'workgroup', 'azure_ad', 'unknown') -contains $Doc['host']['join_type'])
    }
    if ($Doc.Contains('metrics') -and $null -ne $Doc['metrics']) {
        $cp = $Doc['metrics']['cpu_pct']
        & $check 'cpu_pct_range' ($null -eq $cp -or ($cp -ge 0 -and $cp -le 100))
        $rp = $Doc['metrics']['ram_used_pct']
        & $check 'ram_pct_range' ($null -eq $rp -or ($rp -ge 0 -and $rp -le 100))
    }
    if ($Doc.Contains('security') -and $null -ne $Doc['security']) {
        & $check 'bitlocker_value' (@('protected', 'off', 'unavailable') -contains $Doc['security']['bitlocker']['system_drive'])
        & $check 'secure_boot_value' (@('on', 'off', 'unsupported', 'unavailable') -contains $Doc['security']['secure_boot'])
    }

    # The JSON text must round-trip and be plain ASCII.
    $roundTrip = $false
    try { $back = $Json | ConvertFrom-Json; $roundTrip = ($null -ne $back -and $back.schema_version -eq '1.0') } catch { $roundTrip = $false }
    & $check 'json_round_trip' $roundTrip
    & $check 'json_ascii_only' (-not [regex]::IsMatch($Json, '[^\x00-\x7F]'))

    # Helper behaviour.
    $dirty = ("a" + [char]1 + "b" + [char]9 + "c" + ('x' * 400))
    $clean = ConvertTo-DrishtiText $dirty
    & $check 'text_helper_strips_and_caps' ($null -ne $clean -and $clean.Length -le 256 -and -not [regex]::IsMatch($clean, '[\x00-\x1F]'))
    $h1 = Get-DrishtiHash 'sn' 'ABC123'
    $h2 = Get-DrishtiHash 'sn' 'abc123'
    $h3 = Get-DrishtiHash 'sn' 'ABC124'
    & $check 'hash_stable_and_distinct' ($h1 -eq $h2 -and $h1 -ne $h3 -and $h1 -match '^sn-[0-9a-f]{12}$')

    $res = @{ checks = $script:SelfChecks; failures = @($fail) }
    return $res
}

# ---------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------

function Test-DrishtiOutFile {
    # Validates -OutFile BEFORE any collection; returns the full path or $null (message on stderr).
    param([string]$Path)
    try {
        $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $Path))
    }
    catch { [Console]::Error.WriteLine('OutFile refused: not a valid path'); return $null }
    if ([System.IO.Path]::GetExtension($full).ToLowerInvariant() -ne '.json') {
        [Console]::Error.WriteLine('OutFile refused: the file name must end in .json'); return $null
    }
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if (-not $dir -or -not [System.IO.Directory]::Exists($dir)) {
        [Console]::Error.WriteLine('OutFile refused: the folder does not exist (the collector never creates folders)'); return $null
    }
    if ([System.IO.Directory]::Exists($full)) {
        [Console]::Error.WriteLine('OutFile refused: the path is a folder'); return $null
    }
    return $full
}

function Write-DrishtiOutFile {
    # The ONLY place the collector writes to disk: the caller's .json file, UTF-8 without BOM.
    param([string]$FullPath, [string]$Text)
    $enc = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($FullPath, $Text, $enc)
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

$exitCode = 0
try {
    $wantedList = [System.Collections.Generic.List[string]]::new()
    foreach ($s in @($Sections)) {
        if ($null -eq $s) { continue }
        foreach ($p in ([string]$s -split '[,;\s]+')) {
            if ($p) { [void]$wantedList.Add($p.ToLowerInvariant()) }
        }
    }
    if ($wantedList.Count -eq 0) { foreach ($s in $script:AllSections) { [void]$wantedList.Add($s) } }
    $unknown = @($wantedList | Where-Object { $script:AllSections -notcontains $_ })
    if ($unknown.Count -gt 0) {
        [Console]::Error.WriteLine('Unknown section name(s). Valid: ' + ($script:AllSections -join ', '))
        exit 2
    }
    $script:Wanted = @($script:AllSections | Where-Object { $wantedList -contains $_ })

    $outFull = $null
    if ($OutFile) {
        $outFull = Test-DrishtiOutFile $OutFile
        if ($null -eq $outFull) { exit 2 }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $script:Doc['schema_version'] = $script:SchemaVersion
    $script:Doc['collected_at'] = Format-DrishtiUtc ([datetime]::UtcNow)
    $script:Doc['collector_version'] = $script:CollectorVersion

    Read-DrishtiSection 'host' { Get-DrishtiHostInfo }
    Read-DrishtiSection 'os' { Get-DrishtiOsInfo }
    Read-DrishtiSection 'hardware' { Get-DrishtiHardwareInfo }
    Read-DrishtiSection 'network' { Get-DrishtiNetworkInfo }
    Read-DrishtiSection 'software' { Get-DrishtiSoftwareInfo }
    Read-DrishtiSection 'services' { Get-DrishtiServicesInfo }
    Read-DrishtiSection 'security' { Get-DrishtiSecurityInfo }
    Read-DrishtiSection 'updates' { Get-DrishtiUpdatesInfo }
    Read-DrishtiSection 'metrics' { Get-DrishtiMetricsInfo }

    $sw.Stop()
    $script:Doc['collection'] = [ordered]@{
        duration_ms        = [int64]$sw.ElapsedMilliseconds
        privilege          = Get-DrishtiPrivilege
        powershell_version = [string]$PSVersionTable.PSVersion
        items              = $script:Items.ToArray()
    }

    $scrub = @()
    if ($Redact) { $scrub = Convert-DrishtiRedactDoc $script:Doc }

    $json = ConvertTo-Json -InputObject $script:Doc -Depth 8 -Compress:(-not $Pretty)
    $json = [regex]::Replace($json, '[^\x00-\x7F]', [System.Text.RegularExpressions.MatchEvaluator] {
            param($m) '\u' + ([int][char]$m.Value[0]).ToString('x4')
        })
    if ($Redact) { $json = Convert-DrishtiScrubText $json $scrub }

    if ($SelfTest) {
        $r = Test-DrishtiDocument $script:Doc $json
        $failures = @($r['failures'])
        if ($failures.Count -eq 0) {
            if (-not $Quiet) { [Console]::Out.WriteLine('SELFTEST: PASS (' + $r['checks'] + ' checks)') }
        }
        else {
            $names = ($failures | Select-Object -First 10) -join '; '
            [Console]::Out.WriteLine('SELFTEST: FAIL (' + $failures.Count + ' of ' + $r['checks'] + ' checks): ' + $names)
            $exitCode = 1
        }
        if ($outFull) { Write-DrishtiOutFile $outFull $json }
    }
    elseif ($outFull) {
        Write-DrishtiOutFile $outFull $json
        if (-not $Quiet) { [Console]::Out.WriteLine('Wrote ' + $json.Length + ' characters to ' + $outFull) }
    }
    elseif (-not $Quiet) {
        [Console]::Out.WriteLine($json)
    }
}
catch {
    [Console]::Error.WriteLine('Collector failed: ' + (Get-DrishtiErrorText $_))
    $exitCode = 3
}
exit $exitCode
