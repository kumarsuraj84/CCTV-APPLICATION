// P5.4 brief items 1, 2 and 4: the Windows deployment scripts (deploy/windows) checked WITHOUT touching this computer's services,
// accounts, firewall, scheduled tasks or registry: the PowerShell parser on every script, the review rules PSScriptAnalyzer would
// apply (it is not installed here and nothing is installed for this), and the dry runs (-WhatIf / -DryRun) of the install, the update
// with its roll back, and the retention of backups. Every run uses a scratch configuration under the system temp folder.
// P5.4 fix round 3 and re-review 3 m-f (the owner's antivirus), exactly what this default file does: it writes no script or program
// file (only .psd1 data files and plain folders under the temp folder), compiles nothing, runs no icacls, takeown, sc, mklink or
// whoami, makes no junction or hard link, grants nobody, and never uses -ExecutionPolicy Bypass, -EncodedCommand or Invoke-Expression.
// PowerShell reads its commands from standard input (-Command -) and parses, plans (-WhatIf / -DryRun), reads, or runs the pure
// decisions on made-up data with fake providers. A dry run may create its own scratch folders; nothing here changes an access list.
// The behaviour on the real file system (locks, junctions, hard links, the service host) is the lab suite: tests/windows-lab (opt-in,
// DRISHTI_WINDOWS_LAB=1, run on the production server before the install). Elsewhere in the default run, the integration backup test
// lets backup.ps1 lock its own new folders under the temp folder through .NET (no icacls), and execSync starts cmd.exe as its shell.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const WIN = path.join(ROOT, 'deploy', 'windows')
const windows = process.platform === 'win32'
const scripts = (dir = WIN): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? scripts(path.join(dir, f)) : f.endsWith('.ps1') ? [path.join(dir, f)] : []))
const TOP = ['drishti-services.ps1', 'update.ps1', 'backup.ps1', 'restore.ps1']

let dir = ''
let config = ''
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
/** Runs one repo script with its arguments, the command given on standard input (no script file written, no policy switch). */
const ps = (script: string, args: string[]) => {
  const call = `& ${quote(path.join(WIN, script))} ${args.map((a) => (a.startsWith('-') ? a : quote(a))).join(' ')}`
  const input = `try { ${call}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}
/** Commands for one PowerShell process that dot-sources the shared library (read from standard input; nothing written). */
const psCommon = (lines: string[]) => {
  const input = [`. ${quote(path.join(WIN, 'lib', 'Drishti.Common.ps1'))}`, ...lines].join('\r\n')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input, encoding: 'utf8', timeout: 120_000 })
  return `${r.stdout}\n${r.stderr}`
}
const order = (text: string, parts: string[]) => {
  let at = -1
  for (const p of parts) {
    const i = text.indexOf(p, at + 1)
    expect(i, `"${p}" after position ${at}`).toBeGreaterThan(at)
    at = i
  }
}

beforeAll(() => {
  if (!windows) return
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-scripts-'))
  config = path.join(dir, 'drishti.config.psd1')
  writeFileSync(config, [
    '@{',
    `  InstallRoot = '${dir}\\Drishti'; ConfigDir = '${dir}\\Drishti\\config'; DataDir = '${dir}\\data'; LogDir = '${dir}\\logs'; BackupDir = '${dir}\\backups'`,
    `  NodeExe = 'C:\\Program Files\\nodejs\\node.exe'; Go2rtcExe = '${dir}\\Drishti\\go2rtc\\go2rtc.exe'`,
    "  Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')",
    "  Database = @{ Mode = 'Direct'; PgBin = 'C:\\pg\\bin'; Host = '127.0.0.1'; Port = 5432; User = 'postgres'; Name = 'postgres'; PasswordEnv = 'DRISHTI_DB_PASSWORD' }",
    "  MigrationMode = 'DbUrl'",
    `  VaultKey = @{ Mode = 'File'; Path = 'C:\\pg\\pgsodium_root.key'; KeyBackupDir = '${dir}\\keys' }`,
    '  Retention = @{ Days = 30; KeepAtLeast = 3 }',
    '}',
  ].join('\r\n'))
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!windows)('Windows deployment scripts (P5.4; nothing installed, nothing changed)', () => {
  it('every script parses with the PowerShell parser', () => {
    const files = scripts()
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['Drishti.Common.ps1', ...TOP].sort())
    const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',')
    const cmd = `$n=0; foreach ($f in @(${list})) { $t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e) | Out-Null; foreach ($x in $e) { $n++; Write-Output "$f $($x.Extent.StartLineNumber): $($x.Message)" } }; Write-Output "errors=$n"`
    // Parsing only (nothing runs), one process for every script, the command on standard input.
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: cmd, encoding: 'utf8' })
    expect(r.stdout.trim().split(/\r?\n/).at(-1), r.stdout).toBe('errors=0')
  })

  it('review rules (what PSScriptAnalyzer would flag): ShouldProcess, stop on errors, no Invoke-Expression, no plain-text secrets, no $args', () => {
    for (const f of scripts()) {
      const t = readFileSync(f, 'utf8')
      const name = path.basename(f)
      expect(t, name).not.toMatch(/Invoke-Expression|\biex\b/i)
      expect(t, name).not.toMatch(/ConvertTo-SecureString[^\n]*-AsPlainText/i)
      expect(t, name).not.toMatch(/^\s*\$args\s*=/m) // PSAvoidAssignmentToAutomaticVariable
      expect(t, name).not.toMatch(/password\s*=\s*['"][^'"$<]/i)
      expect(t, name).not.toMatch(/Write-(Output|Host)[^\n]*\$env:[A-Z_]*(SECRET|PASSWORD|KEY)/i)
      if (TOP.includes(name)) {
        expect(t, name).toMatch(/\[CmdletBinding\(SupportsShouldProcess = \$true\)\]/)
        expect(t, name).toMatch(/\$ErrorActionPreference = 'Stop'/)
        expect(t, name).toMatch(/\[switch\]\$DryRun/)
        expect(t, name).toMatch(/\.SYNOPSIS/)
      }
    }
    const example = readFileSync(path.join(WIN, 'drishti.config.example.psd1'), 'utf8')
    expect(example).not.toMatch(/Password\s*=/)
    expect(example).toMatch(/PasswordEnv\s*=\s*'DRISHTI_DB_PASSWORD'/)
    // Review M-11: well-known SIDs, never the localised names, in every icacls grant.
    for (const f of scripts()) expect(readFileSync(f, 'utf8'), path.basename(f)).not.toMatch(/['"](Administrators|SYSTEM):/)
    // Re-review M-new-6: no tool taken from PATH (a nightly SYSTEM task runs these): the Windows tools by full path, docker, git, npm
    // and npx from the configuration.
    for (const f of scripts()) {
      const code = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
      expect(code, path.basename(f)).not.toMatch(/-FilePath '(icacls|robocopy|sc|cmd|takeown|npm|npx)\.(exe|cmd)'|& (icacls|robocopy|sc|cmd|takeown|powershell)\.exe |& (docker|git) |FileName = 'docker'/)
    }
  })

  // P5.4 fix round 3: the rules behind the locks, the retention and the update, on made-up data (one PowerShell process; it changes
  // nothing and reads no folder). The same rules on the real file system: tests/windows-lab.
  describe('the decisions, on made-up data', () => {
    let out = ''
    const line = (key: string) => (new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? '<missing>').trim()
    beforeAll(() => {
      out = psCommon([
        // Write and read rights, owners, secrets (review C-2, N-1).
        "$s = @(Find-DrishtiAclProblems -Rules @([pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights=-536805376;Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights='ReadAndExecute';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-18';Rights='FullControl';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Deny'}, [pscustomobject]@{Sid='S-1-5-80-1';Rights='Modify';Type='Allow'}) -AllowedSids @('S-1-5-80-1'))",
        '"synthetic=$($s.Count)"',
        "$o = @(Find-DrishtiAclProblems -Owner 'S-1-5-21-1-2-3-1001' -Rules @([pscustomobject]@{Sid='S-1-5-32-545';Rights='Read';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-80-7';Rights='Read';Type='Allow'}) -Secret -ReaderSids @('S-1-5-80-7'))",
        '"secret=$($o -join \' | \')"',
        '"admins-owner=$(@(Find-DrishtiAclProblems -Owner \'S-1-5-32-544\' -Rules @()).Count)"',
        // The tree below a folder (review 2 N-3): only the checked app\\current may be a link; a hard link refuses; an unreadable item too.
        "$tree = @([pscustomobject]@{Path='C:\\D\\app\\current';IsDirectory=$true;IsReparse=$true;IsHardLink=$false;Error=$null}, [pscustomobject]@{Path='C:\\D\\app\\releases\\b1\\evil';IsDirectory=$true;IsReparse=$true;IsHardLink=$false;Error=$null}, [pscustomobject]@{Path='C:\\D\\logs\\x.log';IsDirectory=$false;IsReparse=$false;IsHardLink=$true;Error=$null}, [pscustomobject]@{Path='C:\\D\\bin\\host.exe';IsDirectory=$false;IsReparse=$false;IsHardLink=$false;Error=$null}, [pscustomobject]@{Path='C:\\D\\locked';IsDirectory=$true;IsReparse=$false;IsHardLink=$false;Error='cannot be read'})",
        "$tp = @(Get-DrishtiTreeProblems -Entries $tree -AllowedLinks @('C:\\D\\app\\current'))",
        '"tree=$($tp -join \' | \')"',
        '"tree-none=$(@(Get-DrishtiTreeProblems -Entries @($tree[3])).Count)"',
        // Rebuild rules: an own entry, a protected list or another owner needs a reset; a plain inherited item does not.
        '"reset=$((Test-DrishtiNeedsReset -ExplicitRules 1 -Protected $false -Owner \'S-1-5-32-544\' -WantedOwner \'S-1-5-32-544\')),$((Test-DrishtiNeedsReset -ExplicitRules 0 -Protected $true -Owner \'x\' -WantedOwner \'\')),$((Test-DrishtiNeedsReset -ExplicitRules 0 -Protected $false -Owner \'S-1-5-21-9\' -WantedOwner \'S-1-5-32-544\')),$((Test-DrishtiNeedsReset -ExplicitRules 0 -Protected $false -Owner \'S-1-5-21-9\' -WantedOwner \'\'))"',
        // Owners of a folder that existed already: SYSTEM, Administrators, TrustedInstaller (and the operator in tests) only.
        '"owners=$((Test-DrishtiTrustedOwner -Owner \'S-1-5-18\')),$((Test-DrishtiTrustedOwner -Owner \'S-1-5-32-544\')),$((Test-DrishtiTrustedOwner -Owner \'S-1-5-21-1-2-3-1001\')),$((Test-DrishtiTrustedOwner -Owner \'S-1-5-21-1-2-3-1001\' -Operator @(\'S-1-5-21-1-2-3-1001\')))"',
        // The one link update.ps1 makes: a junction to a folder directly under app\\releases.
        "$rel = 'C:\\D\\app\\releases'",
        '"link=$((Test-DrishtiReleaseLink -IsJunction $true -Target \'C:\\D\\app\\releases\\b1\' -ReleasesDir $rel -TargetIsPlainFolder $true)),$((Test-DrishtiReleaseLink -IsJunction $true -Target \'\\??\\C:\\D\\app\\releases\\b1\' -ReleasesDir $rel -TargetIsPlainFolder $true)),$((Test-DrishtiReleaseLink -IsJunction $true -Target \'C:\\\' -ReleasesDir $rel -TargetIsPlainFolder $true)),$((Test-DrishtiReleaseLink -IsJunction $true -Target \'C:\\D\\app\\releases\\b1\\sub\' -ReleasesDir $rel -TargetIsPlainFolder $true)),$((Test-DrishtiReleaseLink -IsJunction $false -Target \'C:\\D\\app\\releases\\b1\' -ReleasesDir $rel -TargetIsPlainFolder $true)),$((Test-DrishtiReleaseLink -IsJunction $true -Target \'C:\\D\\app\\releases\\b1\' -ReleasesDir $rel -TargetIsPlainFolder $false))"',
        // Retention (review I-6): only folders the backup made; a link is never a candidate; a candidate holding a link is kept.
        "$now = [datetime]'2026-10-23T06:00:00'",
        "$f = @([pscustomobject]@{Name='20261022-020000-nightly';IsReparse=$false;ManifestKind='drishti-backup';HasReparseBelow=$false}, [pscustomobject]@{Name='20260901-020000-nightly';IsReparse=$false;ManifestKind='drishti-backup';HasReparseBelow=$false}, [pscustomobject]@{Name='20260902-020000-nightly';IsReparse=$false;ManifestKind='drishti-backup';HasReparseBelow=$true}, [pscustomobject]@{Name='20260801-020000-trap';IsReparse=$true;ManifestKind=$null;HasReparseBelow=$false}, [pscustomobject]@{Name='20260701-020000-other';IsReparse=$false;ManifestKind='something-else';HasReparseBelow=$false}, [pscustomobject]@{Name='my-folder';IsReparse=$false;ManifestKind='drishti-backup';HasReparseBelow=$false})",
        '"retention=$((Get-DrishtiRetentionPlan -Folders $f -Days 30 -Keep 1 -Now $now | Sort-Object Name | ForEach-Object { $_.Name + \':\' + $_.Action }) -join \' \')"',
        // The update verdict (final review C-I5): only a broken release rolls back.
        "$v = { param($h) $r = Get-DrishtiReleaseVerdictFrom @h; $r.Verdict + ':' + ($r.Reasons -join ' / ') }",
        '"verdict-ok=$(& $v @{ VersionAnswered = $true; GatewayChecked = $true; GatewayAnswered = $true; DbLevel = \'20261021000047\'; Expected = \'20261021000047\'; PublicStatus = \'ok\' })"',
        '"verdict-env=$(& $v @{ VersionAnswered = $true; GatewayChecked = $true; GatewayAnswered = $true; DbLevel = \'20261021000047\'; Expected = \'20261021000047\'; PublicStatus = \'degraded\' })"',
        '"verdict-version=$(& $v @{ VersionAnswered = $false; BuildId = \'b9\'; GatewayChecked = $false; DbLevel = \'20261021000047\'; Expected = \'20261021000047\'; PublicStatus = \'ok\' })"',
        '"verdict-service=$(& $v @{ VersionAnswered = $true; NotRunning = @(\'DrishtiWeb\'); GatewayChecked = $true; GatewayAnswered = $false; DbLevel = \'20261021000046\'; Expected = \'20261021000047\'; PublicStatus = \'degraded\' })"',
        // The virtual account SIDs, computed from the service name before the service exists (as sc.exe showsid prints them; the
        // values were compared with sc.exe once and are kept here; the lab suite compares again on the server).
        '"sid-ti=$(Get-DrishtiServiceSid -ServiceName TrustedInstaller)"',
        '"sid-spooler=$(ConvertTo-DrishtiSid \'NT SERVICE\\Spooler\')"',
        '"sid-web=$(ConvertTo-DrishtiSid \'NT SERVICE\\DrishtiWeb\')"',
        '"sid-case=$(Get-DrishtiServiceSid -ServiceName drishtiweb)"',
      ])
    })

    it('write rights, owners and secret readers', () => {
      expect(line('synthetic'), out).toBe('2')
      expect(line('secret')).toBe('the owner is S-1-5-21-1-2-3-1001, not SYSTEM, the Administrators or TrustedInstaller (an owner may always change the rules) | S-1-5-32-545 may read a secret (rights 0x00020089)')
      expect(line('admins-owner')).toBe('0')
    })

    it('a link other than the checked app\\current, a hard link and an unreadable item refuse a lock; a plain file does not', () => {
      expect(line('tree')).toBe('C:\\D\\app\\releases\\b1\\evil: a junction or link the installation did not make (not followed) | C:\\D\\logs\\x.log: has more than one name, a hard link (not changed) | C:\\D\\locked: cannot be read')
      expect(line('tree-none')).toBe('0')
    })

    it('rebuild rules and trusted owners', () => {
      expect(line('reset')).toBe('True,True,True,False')
      expect(line('owners')).toBe('True,True,False,True')
    })

    it('app\\current is trusted only as a junction to a folder directly under app\\releases', () => {
      expect(line('link')).toBe('True,True,False,False,False,False')
    })

    it('retention: only folders the backup made; old ones beyond the newest go; a link or a folder holding one is never removed', () => {
      expect(line('retention')).toBe('20260701-020000-other:ignore 20260801-020000-trap:skip-link 20260901-020000-nightly:remove 20260902-020000-nightly:keep-link 20261022-020000-nightly:keep my-folder:ignore')
    })

    it('the update verdict: a server problem keeps the release; a release that does not answer, a stopped service or a missing migration rolls back', () => {
      expect(line('verdict-ok')).toBe('ok:')
      expect(line('verdict-env')).toBe('environment:the public health says degraded')
      expect(line('verdict-version')).toBe('release:/api/version did not answer with build b9')
      expect(line('verdict-service')).toMatch(/^release:DrishtiWeb is not running .* \/ the gateway does not answer its \/g\/health \/ the database is at 20261021000046, the release needs 20261021000047$/)
    })

    it('the virtual account SIDs from the service name (SHA-1 of the upper-case name), also for a service that does not exist yet', () => {
      expect(line('sid-ti')).toBe('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') // TrustedInstaller, well known
      expect(line('sid-spooler')).toBe('S-1-5-80-3951239711-1671533544-1416304335-3763227691-3930497994') // sc.exe showsid Spooler
      expect(line('sid-web')).toBe('S-1-5-80-22909492-60703657-1105579311-46060339-2887122739') // sc.exe showsid DrishtiWeb (not installed)
      expect(line('sid-case')).toBe(line('sid-web'))
    })
  })

  // P5.4 fix round 4 (re-review 3 N-4, N-5, m-b): the lock's walk and reset, the allowed link, the services a repair must stop and
  // the database outage after an update, decided on made-up data with fake providers (nothing on disk is read or changed).
  describe('round 4 decisions, with fake providers', () => {
    let out = ''
    const line = (key: string) => (new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? '<missing>').trim()
    beforeAll(() => {
      out = psCommon(String.raw`
# N-5: the one link the installation makes, as Audit, Status and the plan see it.
"allowed=$(@(Get-DrishtiAllowedLinks -InstallRoot 'C:\Drishti\') -join ',')"
"links=$(@(Get-DrishtiLinkProblems -Links @('C:\Drishti\app\current', 'C:\DRISHTI\APP\CURRENT\', 'C:\Drishti\logs\DrishtiWeb\evil') -Allowed (Get-DrishtiAllowedLinks -InstallRoot 'C:\Drishti')) -join ' | ')"
"planlinks=$(@((Get-DrishtiAclPlan -Config @{ InstallRoot = 'C:\Drishti'; ConfigDir = 'C:\Drishti\config'; DataDir = 'C:\Drishti\data'; LogDir = 'C:\Drishti\logs'; BackupDir = 'D:\B'; Go2rtcExe = '' } -Definitions @())[0].AllowedLinks) -join ',')"
# N-4 (b): every walked item's owner, not only the top folder's.
$tree = @([pscustomobject]@{Path='C:\D\app\a';IsDirectory=$true;IsReparse=$false;IsHardLink=$false;Error=$null;Owner='S-1-5-32-544'}, [pscustomobject]@{Path='C:\D\app\a\deep\x.js';IsDirectory=$false;IsReparse=$false;IsHardLink=$false;Error=$null;Owner='S-1-5-21-1-2-3-1001'}, [pscustomobject]@{Path='C:\D\app\svc.log';IsDirectory=$false;IsReparse=$false;IsHardLink=$false;Error=$null;Owner='S-1-5-80-7'}, [pscustomobject]@{Path='C:\D\app\b';IsDirectory=$true;IsReparse=$false;IsHardLink=$false;Error=$null;Owner='S-1-5-18'})
"owners=$(@(Get-DrishtiTreeProblems -Entries $tree -TrustedOwners @('S-1-5-80-7')) -join ' | ')"
# N-4 (c): just before each change, nothing between the root and the item may have become a link. The fake file system changes under
# the reset: resetting C:\D\a swaps C:\D\b for a junction (as a service or an owner below could).
$global:fs = @{ 'C:\D' = 'Directory'; 'C:\D\a' = 'Directory'; 'C:\D\a\f.txt' = 'Archive'; 'C:\D\b' = 'Directory'; 'C:\D\b\g.txt' = 'Archive'; 'C:\D\c.txt' = 'Archive' }
$global:changed = New-Object System.Collections.Generic.List[string]
$provider = @{ GetAttributes = { param($p) if ($global:fs.ContainsKey($p)) { [IO.FileAttributes]$global:fs[$p] } else { $null } }; NeedsReset = { param($e, $owner) $e.Path -ne 'C:\D\c.txt' }; Reset = { param($e, $owner) $global:changed.Add($e.Path); if ($e.Path -eq 'C:\D\a') { $global:fs['C:\D\b'] = 'Directory, ReparsePoint' } } }
$walked = @('C:\D\a', 'C:\D\a\f.txt', 'C:\D\b', 'C:\D\b\g.txt', 'C:\D\c.txt') | ForEach-Object { [pscustomobject]@{ Path = $_; IsDirectory = -not $_.EndsWith('.txt'); IsReparse = $false; IsHardLink = $false; Error = $null; Owner = 'S-1-5-32-544' } }
$r = Invoke-DrishtiTreeReset -Entries $walked -Root 'C:\D' -OwnerSid 'S-1-5-32-544' -Provider $provider
"reset-changed=$($global:changed -join ',')"
"reset-skipped=$(@($r.Problems) -join ' | ')"
"inside=$((Test-DrishtiPathStillInside -Path 'C:\D\a\f.txt' -Root 'C:\D' -GetAttributes $provider.GetAttributes)),$((Test-DrishtiPathStillInside -Path 'C:\D\b\g.txt' -Root 'C:\D' -GetAttributes $provider.GetAttributes)),$((Test-DrishtiPathStillInside -Path 'C:\E\x' -Root 'C:\D' -GetAttributes $provider.GetAttributes)),$((Test-DrishtiPathStillInside -Path 'C:\D\gone' -Root 'C:\D' -GetAttributes $provider.GetAttributes))"
# N-4 (a): folders a service may write are locked themselves only (never walked); every other folder is walked without the planned
# folders below it (each has its own walk: nothing is walked twice).
$plan = @([pscustomobject]@{ Path = 'C:\D'; Modify = @() }, [pscustomobject]@{ Path = 'C:\D\app'; Modify = @() }, [pscustomobject]@{ Path = 'C:\D\logs'; Modify = @() }, [pscustomobject]@{ Path = 'C:\D\logs\DrishtiWeb'; Modify = @('NT SERVICE\DrishtiWeb') }, [pscustomobject]@{ Path = 'C:\D\data\caddy'; Modify = @('NT SERVICE\DrishtiProxy') })
"scope=$((Get-DrishtiLockScope -Plan $plan | ForEach-Object { $_.Path + ':' + $(if ($_.Walk) { 'walk' } else { 'self' }) + '[' + ($_.Exclude -join ';') + ']' }) -join ' ')"
# N-4 (a): RepairAcl stops the services that write their own folders first, and refuses when one cannot be stopped.
$svc = @([pscustomobject]@{ Name = 'DrishtiWeb'; Status = 'Running'; CanStop = $true }, [pscustomobject]@{ Name = 'DrishtiWorker'; Status = 'Stopped'; CanStop = $false }, [pscustomobject]@{ Name = 'DrishtiGateway'; Status = 'Running'; CanStop = $true })
$s1 = Get-DrishtiRepairServiceSteps -Writers @('DrishtiWeb', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiProxy') -Services $svc
"repair=stop:$($s1.Stop -join ',') again:$($s1.StartAgain -join ',') refuse:$(@($s1.Refuse).Count)"
$s2 = Get-DrishtiRepairServiceSteps -Writers @('DrishtiWeb', 'DrishtiGateway') -Services @([pscustomobject]@{ Name = 'DrishtiWeb'; Status = 'Running'; CanStop = $true }, [pscustomobject]@{ Name = 'DrishtiGateway'; Status = 'Running'; CanStop = $false })
"repair-refuse=$($s2.Refuse -join ' | ')"
# m-b: the database level cannot be read after an update: a database outage, not a broken release.
$v = Get-DrishtiReleaseVerdictFrom -VersionAnswered $false -BuildId 'b9' -GatewayChecked $true -GatewayAnswered $true -DbLevel '' -Expected '20261021000047' -PublicStatus 'degraded'
"verdict-nodb=$($v.Verdict):$($v.Reasons -join ' / ')"
`.split('\n'))
    })

    it('N-5: the allowed link is <InstallRoot>\\app\\current, the same for the plan and the Audit; only other links are problems', () => {
      expect(line('allowed'), out).toBe('C:\\Drishti\\app\\current')
      expect(line('links')).toBe('C:\\Drishti\\logs\\DrishtiWeb\\evil: a junction or link the installation did not make')
      expect(line('planlinks')).toBe('C:\\Drishti\\app\\current')
    })

    it('N-4: an item below with a foreign owner refuses the whole lock; SYSTEM, the Administrators and an allowed service are fine', () => {
      expect(line('owners')).toBe('C:\\D\\app\\a\\deep\\x.js: belongs to S-1-5-21-1-2-3-1001, not to SYSTEM, the Administrators or TrustedInstaller (not changed)')
    })

    it('N-4: an item that became a link (or sits below one) between the walk and its reset is skipped and reported, never followed', () => {
      expect(line('reset-changed')).toBe('C:\\D\\a,C:\\D\\a\\f.txt')
      expect(line('reset-skipped')).toBe('C:\\D\\b: became a junction or link (or moved) after it was read: skipped, not followed | C:\\D\\b\\g.txt: became a junction or link (or moved) after it was read: skipped, not followed')
      expect(line('inside')).toBe('True,False,False,False')
    })

    it('N-4: a folder a service may write is locked itself only; nothing is walked twice', () => {
      expect(line('scope')).toBe('C:\\D:walk[C:\\D\\app;C:\\D\\logs;C:\\D\\data\\caddy] C:\\D\\app:walk[] C:\\D\\logs:walk[C:\\D\\logs\\DrishtiWeb] C:\\D\\logs\\DrishtiWeb:self[] C:\\D\\data\\caddy:self[]')
    })

    it('N-4: RepairAcl stops the running services that write their folders (and starts them again); one that cannot stop refuses it', () => {
      expect(line('repair')).toBe('stop:DrishtiWeb,DrishtiGateway again:DrishtiWeb,DrishtiGateway refuse:0')
      expect(line('repair-refuse')).toBe('DrishtiGateway is running and cannot be stopped: its folder would be changed while it writes there. Nothing was changed.')
    })

    it('m-b: a database that does not answer after an update is a problem of the server: nothing is rolled back', () => {
      expect(line('verdict-nodb')).toBe('environment:the database does not answer (its level could not be read); the other checks depend on it: nothing was rolled back or restored')
    })
  })

  // Re-review 3 m-c: the lock never comes back to a tool that follows junctions: no icacls, no takeown, no recursive copy or delete
  // in the deployment scripts (the retention's rmdir /s /q never follows a link and is the one recursive delete).
  it('m-c: no icacls, takeown, /T, /R or -Recurse in the deployment scripts', () => {
    for (const f of scripts()) {
      const code = readFileSync(f, 'utf8').replace(/<#[\s\S]*?#>/g, '').split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')
      const name = path.basename(f)
      expect(code, name).not.toMatch(/\b(icacls|takeown)(\.exe)?\b|IcaclsExe|TakeownExe/i)
      expect(code, name).not.toMatch(/\s\/(T|R)(\s|'|"|$)/m)
      expect(code, name).not.toMatch(/-Recurse\b/i)
      expect(code, name).not.toMatch(/\/reset\b/i)
    }
    // Re-review 3 N-5: the Audit takes the allowed link from the same pure function as the plan (no hand-built path).
    const services = readFileSync(path.join(WIN, 'drishti-services.ps1'), 'utf8')
    expect(services).toMatch(/Get-DrishtiLinkProblems -Links @\(Get-DrishtiReparsePoints -Path \$p\) -Allowed \$allowed/)
    expect(services).toMatch(/\$allowed = @\(Get-DrishtiAllowedLinks -InstallRoot \$config\.InstallRoot\)/)
    expect(services).not.toMatch(/'appcurrent'|TrimEnd\(''\)/)
    // Re-review 3 m-e: Caddy's admin API is off (a restart applies a changed Caddyfile).
    const caddy = readFileSync(path.join(WIN, 'Caddyfile.example'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(caddy).toMatch(/^\s*admin off\s*$/m)
    expect(caddy).not.toMatch(/admin\s+(localhost|127\.|:)/)
  })

  // No service to stop is no service, not all (re-review 2 nit): a go2rtc-only configuration updates nothing else.
  it('an empty service list means no service, never all', () => {
    const only = path.join(dir, 'go2rtc-only.config.psd1')
    writeFileSync(only, readFileSync(config, 'utf8').replace("Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')", "Services = @('DrishtiGo2rtc')"))
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', only, '-BuildId', 'nit1', '-DryRun'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/no service to stop/)
    expect(r.out).not.toMatch(/would stop DrishtiGo2rtc/)
  })

  it('install -WhatIf: the host compiled with the built-in C# compiler, four services in start order, own virtual accounts, auto-start, restart on failure, own log folders', () => {
    const r = ps('drishti-services.ps1', ['-Action', 'Install', '-ConfigPath', config, '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/csc\.exe \/nologo \/target:exe/)
    order(r.out, ['New-Service -Name DrishtiGo2rtc', 'New-Service -Name DrishtiWorker', 'New-Service -Name DrishtiGateway', 'New-Service -Name DrishtiWeb'])
    for (const s of ['DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb']) {
      expect(r.out).toContain(`sc.exe config ${s} start= delayed-auto obj= NT SERVICE\\${s}`)
      expect(r.out).toContain(`sc.exe failure ${s} reset= 86400 actions= restart/5000/restart/10000/restart/60000`)
      expect(r.out).toContain(`sc.exe sidtype ${s} unrestricted`)
      expect(r.out).toMatch(new RegExp(`would lock \\S+\\\\logs\\\\${s}: owner unchanged \\(not elevated\\); every other entry removed.* NT SERVICE\\\\${s}:\\(OI\\)\\(CI\\)M`))
      expect(r.out).toMatch(new RegExp(`would lock \\S+\\\\config\\\\\\w+\\.env: .* NT SERVICE\\\\${s}:R`))
    }
    expect(r.out).toContain('-DependsOn DrishtiGo2rtc')
    // go2rtc never reads the releases; nothing is created or changed in a dry run.
    expect(r.out).not.toMatch(/\\app: [^\n]*DrishtiGo2rtc/)
    // Review M-4: the web account may read the free space of the data and backup disks (RA,S on the folder only), nothing in them.
    expect(r.out).toMatch(/would lock \S+\\data: .* NT SERVICE\\DrishtiWeb:\(RA,S\)/)
    expect(r.out).toMatch(/would lock \S+\\backups: .* NT SERVICE\\DrishtiWeb:\(RA,S\)/)
    expect(r.out).not.toMatch(/would lock \S+\\(data|backups): [^\n]*Drishti(Worker|Gateway|Go2rtc)/)
    expect(readdirSync(dir)).not.toContain('Drishti')
  })

  // Review C-2 / I-3: from an EMPTY root every folder is created and locked (inheritance removed, SYSTEM and Administrators by SID,
  // then the service accounts only) before anything is written into it or granted on it; nobody else gets any right.
  it('install -WhatIf from an empty root: every folder created and locked before use; no right for Users, Authenticated Users or Everyone', () => {
    const r = ps('drishti-services.ps1', ['-Action', 'Install', '-ConfigPath', config, '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    const lines = r.out.split(/\r?\n/)
    const created = new Set<string>()
    const firstUse = new Map<string, number>()
    lines.forEach((l, i) => {
      const c = /would create (\S+) \(locked as it is made/.exec(l) // re-review 3 m-d: a folder is made with its own rules
      if (c) created.add(c[1])
      const u = /would (?:lock (\S+):|run: (?:robocopy \S+ ->|\S*csc\.exe .*\/out:)\s*(\S+))/.exec(l)
      const used = u && (u[1] ?? u[2])
      if (used && !firstUse.has(used)) firstUse.set(used, i)
    })
    const root = path.join(dir, 'Drishti')
    for (const p of [root, ...['bin', 'services', 'scripts', 'app', 'config'].map((x) => path.join(root, x)), path.join(dir, 'logs'), path.join(dir, 'logs', 'DrishtiWeb'), path.join(dir, 'data'), path.join(dir, 'backups'), path.join(dir, 'keys')]) {
      expect(created.has(p), `created ${p}`).toBe(true)
      const createdAt = lines.findIndex((l) => l.includes(`would create ${p} (locked as it is made`))
      const lockedAt = lines.findIndex((l) => l.includes(`would lock ${p}:`))
      expect(lockedAt, `locked ${p}`).toBeGreaterThan(createdAt)
    }
    // The first thing ever written into the root is after the root's own lock.
    const rootLock = lines.findIndex((l) => l.includes(`would lock ${root}:`))
    const firstWrite = lines.findIndex((l) => /would (write|copy)|robocopy|csc\.exe/.test(l))
    expect(rootLock).toBeGreaterThan(-1)
    expect(firstWrite).toBeGreaterThan(rootLock)
    const locks = lines.filter((x) => x.includes('would lock '))
    expect(locks.length).toBeGreaterThan(15)
    for (const l of locks) {
      expect(l).toContain('every other entry removed, nothing inherited')
      expect(l).toContain('*S-1-5-18:')
      expect(l).toContain('*S-1-5-32-544:')
      expect(l).not.toMatch(/S-1-5-11|S-1-5-32-545|S-1-1-0|Users:|Everyone/i)
    }
    expect(r.out).toMatch(/robocopy .+ -> \S+\\scripts \(the admin-only copy/)
  })


  it('Audit and Status say when the access rules are not in place (nothing installed here)', () => {
    const r = ps('drishti-services.ps1', ['-Action', 'Audit', '-ConfigPath', config])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is missing/)
    expect(r.out).toMatch(/run -Action RepairAcl/)
    // Review 2 m4: Status without elevation does not count false problems; it says the rules were not checked.
    const s = ps('drishti-services.ps1', ['-Action', 'Status', '-ConfigPath', config])
    expect(s.status, s.out).toBe(0)
    expect(s.out).toMatch(/access rules: not checked \(run elevated/)
    expect(s.out).not.toMatch(/access rules: \d+ problem/)
  })

  const containerConfig = (name: string, extra = '') => {
    const file = path.join(dir, `${name}.config.psd1`)
    writeFileSync(file, readFileSync(config, 'utf8')
      .replace(/  Database = @\{[^\n]*\n/, "  Database = @{ Mode = 'Container'; Container = 'supabase_db_x'; User = 'postgres'; Name = 'postgres' }\n")
      .replace("  MigrationMode = 'DbUrl'", extra || "  MigrationMode = 'DbUrl'"))
    return file
  }

  // Review 2 m1: the Supabase CLI's local (seeded) stack is never updated by update.ps1, even on a test server.
  it('m1: update.ps1 refuses MigrationMode Local, even with TestServer, and says what to do instead (never switch the switch off)', () => {
    const file = containerConfig('local-test', "  MigrationMode = 'Local'; TestServer = $true")
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', file, '-BuildId', 'm1', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/update\.ps1 is for production databases/)
    expect(r.out).toMatch(/npx supabase migration up --local/)
    expect(r.out).toMatch(/Do NOT switch the test fixture switch off/)
    expect(r.out).not.toMatch(/would lock|robocopy|would stop/)
  })

  // Review 2 nit: docker (and git) are never taken from PATH: a Container configuration without DockerExe is refused before anything runs.
  it('Container mode without DockerExe is refused (never docker from PATH)', () => {
    const r = ps('backup.ps1', ['-ConfigPath', containerConfig('nodocker'), '-Tag', 'x', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/DockerExe is not set in the configuration/)
    rmSync(path.join(dir, 'backups'), { recursive: true, force: true })
  })

  it('stopping go2rtc alone stops the gateway (which depends on it) first, and a restart starts both (review M-3)', () => {
    const r = ps('drishti-services.ps1', ['-Action', 'Restart', '-Service', 'DrishtiGo2rtc', '-ConfigPath', config, '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    order(r.out, ['DrishtiGateway depends on DrishtiGo2rtc', 'would stop DrishtiGateway', 'would stop DrishtiGo2rtc', 'would start DrishtiGo2rtc', 'would start DrishtiGateway'])
  })

  // Review C-1: the services are now called in this process with their names as an array; the dry run goes through the real call
  // (the service script's own plan lines prove the binding of all three names).
  it('update -DryRun: build, back up, stop each service in order (through the real call), migrate without a password on the command line, switch, start, check', () => {
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', '20261023-0600-test', '-DryRun'])
    expect(r.status, r.out).toBe(0)
    order(r.out, [
      'would check that the test fixture switch of the database is off',
      'robocopy', 'npm ci', 'CK_BUILD_ID=20261023-0600-test', 'release.json', 'backup.ps1 -Tag pre-update-20261023-0600-test',
      'would stop DrishtiWeb', 'would stop DrishtiGateway', 'would stop DrishtiWorker', 'npx supabase migration up',
      'would mark the database as a production one', 'current to',
      'would start DrishtiWorker', 'would start DrishtiGateway', 'would start DrishtiWeb', 'would check the new release for up to', 'is reported, the new release kept','\\scripts', 'would keep the newest',
    ])
    expect(r.out).not.toMatch(/would stop DrishtiGo2rtc/)
    // Review I-2: the connection string has no password; it reaches the child as PGPASSWORD only.
    expect(r.out).toContain('--db-url postgresql://postgres@127.0.0.1:5432/postgres')
    expect(r.out).toMatch(/PGPASSWORD to the child only/)
    expect(r.out).not.toMatch(/postgresql:\/\/[^@\s]*:[^@\s]*@/)
    expect(r.out).not.toMatch(/Rolling back|PositionalParameterNotFound|positional parameter/i)
    expect(readdirSync(dir)).not.toContain('Drishti')
  })

  it('update roll back plans: everything stops (go2rtc too); a restore with a backup first; a failed restore leaves the system STOPPED', () => {
    const health = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b2', '-DryRun', '-SimulateFailure', 'Health'])
    expect(health.status, health.out).toBe(0)
    const h = health.out.slice(health.out.indexOf('Rolling back'))
    order(h, ['would stop DrishtiWeb', 'would stop DrishtiGateway', 'would stop DrishtiWorker', 'would stop DrishtiGo2rtc', 'restore.ps1 -BackupPath', '-PreRestoreBackup',
      'current to <the previous release>', 'would start DrishtiGo2rtc', 'would start DrishtiWorker', 'would start DrishtiGateway', 'would start DrishtiWeb', 'end of the simulated roll back'])
    const start = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b3', '-DryRun', '-SimulateFailure', 'Start'])
    order(start.out.slice(start.out.indexOf('Rolling back')), ['would stop DrishtiGo2rtc', 'restore.ps1 -BackupPath', 'current to <the previous release>'])
    // The restore itself fails: nothing is started, the system is left stopped with what to do.
    const failed = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b5', '-DryRun', '-SimulateFailure', 'Restore'])
    expect(failed.status, failed.out).toBe(0)
    const f = failed.out.slice(failed.out.indexOf('Rolling back'))
    order(f, ['would stop DrishtiGo2rtc', 'restore.ps1 -BackupPath', 'THE SYSTEM IS STOPPED', 'every Drishti service: would be stopped (dry run)', 'update-rollback.md'])
    expect(f).not.toMatch(/Every Drishti service is stopped and stays stopped/) // re-review M-new-4: the real states, never a promise
    expect(f.slice(f.indexOf('THE SYSTEM IS STOPPED'))).not.toMatch(/would start|current to <the previous/)
    // A failed migration: no restore, no switch back; everything is started again on the old release.
    const migrate = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b4', '-DryRun', '-SimulateFailure', 'Migrate'])
    expect(migrate.status, migrate.out).toBe(0)
    const after = migrate.out.slice(migrate.out.indexOf('Rolling back'))
    expect(after).not.toContain('restore.ps1')
    expect(after).not.toContain('current to')
    order(after, ['would stop DrishtiGo2rtc', 'would start DrishtiGo2rtc', 'would start DrishtiWeb'])
    // -SimulateFailure without a dry run is refused.
    expect(ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-SimulateFailure', 'Health']).status).not.toBe(0)
  })

  // Review M-13: the database mode and the migration mode must fit; install and update refuse a pair that does not.
  it('M-13: Direct + Local, and Container + Local outside a test server, are refused by install and update; Container + DbUrl and a test server pass', () => {
    const variant = (name: string, db: string, extra: string) => {
      const file = path.join(dir, `${name}.config.psd1`)
      writeFileSync(file, readFileSync(config, 'utf8').replace(/  Database = @\{[^\n]*\n/, `  Database = ${db}\n`).replace("  MigrationMode = 'DbUrl'", extra))
      return file
    }
    const container = "@{ Mode = 'Container'; Container = 'supabase_db_x'; User = 'postgres'; Host = '127.0.0.1'; Port = 54322; Name = 'postgres'; MigrateUser = 'postgres'; PasswordEnv = 'DRISHTI_DB_PASSWORD' }"
    const direct = "@{ Mode = 'Direct'; PgBin = 'C:\\pg\\bin'; Host = '127.0.0.1'; Port = 5432; User = 'postgres'; Name = 'postgres'; PasswordEnv = 'DRISHTI_DB_PASSWORD' }"
    const directLocal = variant('direct-local', direct, "  MigrationMode = 'Local'")
    const containerLocal = variant('container-local', container, "  MigrationMode = 'Local'")
    const testServer = variant('test-server', container, "  MigrationMode = 'Local'; TestServer = $true")
    const containerUrl = variant('container-url', container, "  MigrationMode = 'DbUrl'")
    const noMode = variant('no-mode', direct, '')
    for (const [file, msg] of [[directLocal, /Database\.Mode must be 'Container'/], [containerLocal, /for a test server only: set TestServer/], [noMode, /MigrationMode must be 'DbUrl'/]] as const) {
      for (const run of [ps('drishti-services.ps1', ['-Action', 'Install', '-ConfigPath', file, '-WhatIf']), ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', file, '-BuildId', 'm13', '-DryRun'])]) {
        expect(run.status, run.out).not.toBe(0)
        expect(run.out).toMatch(msg)
        expect(run.out).not.toMatch(/would lock|robocopy/)
      }
    }
    expect(ps('drishti-services.ps1', ['-Action', 'Install', '-ConfigPath', testServer, '-WhatIf']).status).toBe(0)
    const url = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', containerUrl, '-BuildId', 'm13b', '-DryRun'])
    expect(url.status, url.out).toBe(0)
    expect(url.out).toContain('--db-url postgresql://postgres@127.0.0.1:54322/postgres')
  })


  // Final review C-I12: Caddy as the DrishtiProxy service, laid out to fit the locks: its program read and run, the Caddyfile and the
  // certificates read, its own storage and log folder written, by its own account only.
  it('C-I12: install -WhatIf with CaddyExe: DrishtiProxy started last, its files under the locked folders with only its own rights', () => {
    const file = path.join(dir, 'proxy.config.psd1')
    writeFileSync(file, readFileSync(config, 'utf8')
      .replace("Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')", "Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb', 'DrishtiProxy')")
      .replace("  MigrationMode = 'DbUrl'", `  MigrationMode = 'DbUrl'\r\n  CaddyExe = '${dir}\\Drishti\\caddy\\caddy.exe'`))
    const r = ps('drishti-services.ps1', ['-Action', 'Install', '-ConfigPath', file, '-WhatIf'])
    expect(r.status, r.out).toBe(0)
    order(r.out, ['New-Service -Name DrishtiWeb', 'New-Service -Name DrishtiProxy'])
    expect(r.out).toMatch(/would lock \S+\\Drishti\\caddy: .* NT SERVICE\\DrishtiProxy:\(OI\)\(CI\)RX/)
    expect(r.out).toMatch(/would lock \S+\\config\\certs: .* NT SERVICE\\DrishtiProxy:\(OI\)\(CI\)RX/)
    expect(r.out).toMatch(/would lock \S+\\data\\caddy: .* NT SERVICE\\DrishtiProxy:\(OI\)\(CI\)M/)
    expect(r.out).toMatch(/would lock \S+\\logs\\DrishtiProxy: .* NT SERVICE\\DrishtiProxy:\(OI\)\(CI\)M/)
    expect(r.out).toMatch(/would lock \S+\\config\\Caddyfile: .* NT SERVICE\\DrishtiProxy:R/)
    expect(r.out).toMatch(/would write \S+\\config\\proxy\.env \(no secret: Caddy's storage under \S+\\data\\caddy\)/)
    for (const l of r.out.split(/\r?\n/).filter((x) => /would lock \S+\\(data\\caddy|config\\certs|config\\Caddyfile):/.test(x))) {
      expect(l).not.toMatch(/Drishti(Web|Worker|Gateway|Go2rtc):/)
    }
    expect(ps('drishti-services.ps1', ['-Action', 'Restart', '-Service', 'DrishtiProxy', '-ConfigPath', file, '-WhatIf']).out).toMatch(/would stop DrishtiProxy/)
  })

  // Final review C-I5: a degraded Health page for a reason of the server keeps the new release (no roll back, no restore); a worker
  // stopped on purpose (WorkerExpected = $false) is neither started nor counted.
  it('C-I5: a server problem after the update is reported and nothing is rolled back; a worker kept stopped on purpose is left alone', () => {
    const env = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'ci5', '-DryRun', '-SimulateFailure', 'Environment'])
    expect(env.status, env.out).toBe(0)
    expect(env.out).toMatch(/updated to ci5, which works; but the Health page reports a problem of the server, not of the release \(simulated: the disk is nearly full\)\. Nothing was rolled back/)
    expect(env.out).not.toMatch(/Rolling back|restore\.ps1 -BackupPath/)
    // A release that does not answer still rolls back.
    expect(ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'ci5b', '-DryRun', '-SimulateFailure', 'Health']).out).toMatch(/the new release does not answer\. Rolling back/)
    const noWorker = path.join(dir, 'noworker.config.psd1')
    writeFileSync(noWorker, readFileSync(config, 'utf8').replace("  MigrationMode = 'DbUrl'", "  MigrationMode = 'DbUrl'\r\n  WorkerExpected = $false"))
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', noWorker, '-BuildId', 'ci5c', '-DryRun'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toMatch(/would (stop|start) DrishtiWorker/)
    expect(r.out).toMatch(/would start DrishtiWeb/)
    // Re-review 3 m-a: a roll back does not start it either.
    const back = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', noWorker, '-BuildId', 'ci5d', '-DryRun', '-SimulateFailure', 'Health'])
    const after = back.out.slice(back.out.indexOf('Rolling back'))
    expect(after, back.out).toMatch(/would start DrishtiWeb/)
    expect(after).not.toMatch(/would start DrishtiWorker/)
  })

  const day = (n: number) => {
    const d = new Date(Date.now() - n * 86_400_000)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-020000`
  }

  it('backup retention (-DryRun): older than the days AND beyond the newest few go; anything not made by backup.ps1 is never touched', () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const made = [1, 2, 40, 45, 50, 60].map((n) => `${day(n)}-nightly`)
    for (const m of made) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    mkdirSync(path.join(backups, 'my-own-folder'))
    mkdirSync(path.join(backups, `${day(90)}-nomanifest`))
    mkdirSync(path.join(backups, `${day(91)}-otherkind`))
    writeFileSync(path.join(backups, `${day(91)}-otherkind`, 'manifest.json'), '{"kind":"something-else"}')
    const r = ps('backup.ps1', ['-ConfigPath', config, '-Tag', 'x', '-DryRun', '-ApplyRetention'])
    expect(r.status, r.out).toBe(0)
    const removed = [...r.out.matchAll(/would remove the old backup \S+\\(\S+) /g)].map((m) => m[1]).sort()
    // Keep at least 3 (the newest three: 1, 2 and 40 days old) and anything under 30 days; the rest is older and beyond them. A
    // manifest of another kind is never a candidate (review M-7).
    expect(removed).toEqual([made[3], made[4], made[5]].sort())
    rmSync(backups, { recursive: true, force: true })
  })


  it('the key copies may not live in or around the backup folder (review M-8)', () => {
    const bad = path.join(dir, 'bad.config.psd1')
    writeFileSync(bad, readFileSync(config, 'utf8').replace(/KeyBackupDir = '[^']+'/, `KeyBackupDir = '${path.join(dir, 'backups', 'keys')}'`))
    const r = ps('backup.ps1', ['-ConfigPath', bad, '-Tag', 'x', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must not be the backup folder/)
  })

  it('restore refuses the live database and a database it would not create, before reading anything; the live plan is copy, prove, swap', () => {
    const r = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'postgres', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/live database/)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'copy1', '-DryRun']).out).toMatch(/needs -CreateDatabase/)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'postgres', '-AllowLiveDatabase', '-DropAfterVerify', '-DryRun']).out).toMatch(/never applies to the live database/)
  })
})

