// P5.4 brief items 1, 2 and 4: the Windows deployment scripts (deploy/windows) checked WITHOUT touching this computer's services,
// accounts, firewall, scheduled tasks or registry: the PowerShell parser on every script, the review rules PSScriptAnalyzer would
// apply (it is not installed here and nothing is installed for this), and the dry runs (-WhatIf / -DryRun) of the install, the update
// with its roll back, and the retention of backups. Every run uses a scratch configuration under the system temp folder.
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
const ps = (script: string, args: string[]) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(WIN, script), ...args], { encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
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
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' })
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
      const c = /would create (\S+)$/.exec(l)
      if (c) created.add(c[1])
      const u = /would (?:lock (\S+):|run: (?:robocopy \S+ ->|\S*csc\.exe .*\/out:)\s*(\S+))/.exec(l)
      const used = u && (u[1] ?? u[2])
      if (used && !firstUse.has(used)) firstUse.set(used, i)
    })
    const root = path.join(dir, 'Drishti')
    for (const p of [root, ...['bin', 'services', 'scripts', 'app', 'config'].map((x) => path.join(root, x)), path.join(dir, 'logs'), path.join(dir, 'logs', 'DrishtiWeb'), path.join(dir, 'data'), path.join(dir, 'backups'), path.join(dir, 'keys')]) {
      expect(created.has(p), `created ${p}`).toBe(true)
      const createdAt = lines.findIndex((l) => l.endsWith(`would create ${p}`))
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

  it('the ACL check: a locked folder has no problem; Authenticated Users with modify (as C:\\ gives) is reported; synthetic rules', () => {
    const p = path.join(dir, 'acltest')
    const common = path.join(WIN, 'lib', 'Drishti.Common.ps1')
    const cmd = [
      `. '${common}'`, `$p = '${p}'`, 'Set-DrishtiAcl -Path $p', '$a = @(Test-DrishtiPathAcl -Path $p -TrustOperator)',
      "icacls $p /grant '*S-1-5-11:(OI)(CI)M' | Out-Null", '$b = @(Test-DrishtiPathAcl -Path $p -TrustOperator)',
      "$s = @(Find-DrishtiAclProblems -Rules @([pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights=-536805376;Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights='ReadAndExecute';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-18';Rights='FullControl';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Deny'}, [pscustomobject]@{Sid='S-1-5-80-1';Rights='Modify';Type='Allow'}) -AllowedSids @('S-1-5-80-1'))",
      'Write-Output "before=$($a.Count) after=$($b.Count) synthetic=$($s.Count)"',
    ].join('; ')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' })
    expect(r.stdout, r.stderr).toMatch(/before=0 after=1 synthetic=2/)
  })

  // Fix round 2 (re-review N-1), on real scratch folders and files: a lock rebuilds the list from nothing (an explicit foreign entry,
  // read or write, on the folder, a file or a sub-folder does not survive a second lock, which is what RepairAcl runs); a secret file
  // readable by Users is reported; a foreign owner is reported; a planted junction is refused.
  const psFile = (lines: string[], env: Record<string, string> = {}) => {
    const file = path.join(dir, `probe-${Math.random().toString(36).slice(2)}.ps1`)
    writeFileSync(file, [`. '${path.join(WIN, 'lib', 'Drishti.Common.ps1')}'`, ...lines].join('\r\n'))
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 })
    rmSync(file, { force: true })
    return `${r.stdout}\n${r.stderr}`
  }

  it('N-1: a second lock (RepairAcl) removes explicit foreign entries everywhere; Users:(R) on web.env is reported; a foreign owner is reported', () => {
    const p = path.join(dir, 'n1')
    const out = psFile([
      `$p = '${p}'`, 'Set-DrishtiAcl -Path $p | Out-Null',
      "$f = Join-Path $p 'web.env'", "Set-Content -LiteralPath $f -Value 'X=1'",
      "Set-DrishtiAcl -Path $f -ReadAccounts @('*S-1-5-19') -IsFile | Out-Null",
      "& icacls.exe $f /grant '*S-1-5-32-545:R' | Out-Null", // drift: Users may read the secret
      "& icacls.exe $p /grant '*S-1-5-11:(OI)(CI)M' | Out-Null", // an explicit write entry on the folder
      "$sub = Join-Path $p 'sub'", 'New-Item -ItemType Directory -Path $sub | Out-Null', "& icacls.exe $sub /grant '*S-1-1-0:(OI)(CI)F' | Out-Null",
      "$a1 = @(Test-DrishtiPathAcl -Path $f -ReadAccounts @('*S-1-5-19') -Secret -TrustOperator)", '$a2 = @(Test-DrishtiPathAcl -Path $p -Secret -TrustOperator)',
      '"fileBefore=$($a1.Count) folderBefore=$($a2.Count)"', '$a1', '$a2',
      'Set-DrishtiAcl -Path $p | Out-Null', "Set-DrishtiAcl -Path $f -ReadAccounts @('*S-1-5-19') -IsFile | Out-Null",
      "$b1 = @(Test-DrishtiPathAcl -Path $f -ReadAccounts @('*S-1-5-19') -Secret -TrustOperator)", '$b2 = @(Test-DrishtiPathAcl -Path $p -Secret -TrustOperator)', '$b3 = @(Test-DrishtiPathAcl -Path $sub -Secret -TrustOperator)',
      '$explicit = @((Get-Acl -LiteralPath $sub).Access | Where-Object { -not $_.IsInherited }).Count',
      "$svc = @((Get-Acl -LiteralPath $f).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19' }).Count",
      '"fileAfter=$($b1.Count) folderAfter=$($b2.Count) subAfter=$($b3.Count) subExplicit=$explicit serviceRead=$svc"', '$b1', '$b2', '$b3',
      "$full = @((Get-Acl -LiteralPath $p).Access | Where-Object { $_.FileSystemRights -eq 'FullControl' -and -not $_.IsInherited } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) -join ','",
      '"full=$full protected=$((Get-Acl -LiteralPath $p).AreAccessRulesProtected)"',
      // Without trusting the person who ran it (the Audit never does), their ownership of the folder is a problem.
      '$o = @(Test-DrishtiPathAcl -Path $p)', '"owner: $($o -join " | ")"',
      "$syn = @(Find-DrishtiAclProblems -Owner 'S-1-5-21-1-2-3-1001' -Rules @([pscustomobject]@{Sid='S-1-5-32-545';Rights='Read';Type='Allow'}) -Secret)", '"synthetic: $($syn -join " | ")"',
    ])
    expect(out).toMatch(/fileBefore=1 folderBefore=1/)
    expect(out).toMatch(/web\.env: S-1-5-32-545 may read a secret/)
    expect(out).toMatch(/n1: S-1-5-11 may write/)
    expect(out).toMatch(/fileAfter=0 folderAfter=0 subAfter=0 subExplicit=0 serviceRead=1/)
    expect(out).toMatch(/full=S-1-5-18,S-1-5-32-544,S-1-5-21-[0-9-]+ protected=True/)
    expect(out).toMatch(/owner: .*n1: the owner is S-1-5-21-/)
    expect(out).toMatch(/synthetic: the owner is S-1-5-21-1-2-3-1001.* \| S-1-5-32-545 may read a secret/)
  })

  it('N-1: a folder made before the install that holds a junction is refused (never followed); one with another owner is named in a warning', () => {
    const q = path.join(dir, 'precreated')
    const decoy = path.join(dir, 'precreated-target')
    mkdirSync(q, { recursive: true })
    mkdirSync(decoy, { recursive: true })
    writeFileSync(path.join(decoy, 'keep.txt'), 'outside')
    expect(spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(q, 'evil'), decoy], { encoding: 'utf8' }).status).toBe(0)
    const refused = psFile([`try { Set-DrishtiAcl -Path '${q}'; 'notRefused' } catch { "refused: $($_.Exception.Message)" }`])
    expect(refused).toMatch(/refused: Refused: \S+precreated contains a junction or link the installation did not make \(\S+evil\)/)
    // The decoy outside keeps its own (inherited) rules: nothing was followed.
    expect(spawnSync('icacls.exe', [decoy], { encoding: 'utf8' }).stdout).toMatch(/\(I\)/)
    spawnSync('cmd.exe', ['/d', '/c', 'rmdir', path.join(q, 'evil')])
    // Without the operator's own entry (as in production), a folder the person made is "made by someone else".
    const warned = psFile([`Set-DrishtiAcl -Path '${q}'`, `& icacls.exe '${q}' /grant "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)F" | Out-Null`], { DRISHTI_ACL_TEST_NO_OPERATOR: '1' })
    expect(warned).toMatch(/precreated existed already and belongs to S-1-5-21-[0-9-]+, not to the Administrators/)
  })

  // Review M-4 / M-new-1, a real call under the plan's entry: a locked folder with no entry for an account gives that account EPERM from
  // statfs; the plan's List entry (RA,S on the folder only) gives it the free space, and still not the folder's contents.
  it('M-4: the free space of a locked data or backup folder is readable with the List entry only, and nothing in it is', () => {
    const d = path.join(dir, 'diskprobe')
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'secret.txt'), 'not for the web app')
    const node = process.execPath.replace(/'/g, "''")
    const probe = `& '${node}' -e "const fs=require('fs');fs.promises.statfs(process.argv[1]).then(s=>console.log('statfs ok', s.bavail>0),e=>console.log('statfs', e.code));try{fs.readdirSync(process.argv[1]);console.log('list ok')}catch(e){console.log('list', e.code)}" '${d}'`
    const me = "$me = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
    const out = psFile([
      me, `Set-DrishtiAcl -Path '${d}' | Out-Null`, '"--- no entry"', probe,
      `Set-DrishtiAcl -Path '${d}' -ListAccounts @($me) | Out-Null`, '"--- list entry"', probe,
      `& icacls.exe '${d}' /grant "$($me):(OI)(CI)F" | Out-Null`, // the owner keeps the right to change the rules: give access back
    ], { DRISHTI_ACL_TEST_NO_OPERATOR: '1' })
    const [, none, list] = out.split(/--- (?:no entry|list entry)/)
    expect(none).toMatch(/statfs EPERM/)
    expect(list).toMatch(/statfs ok true/)
    expect(list).toMatch(/list EPERM/)
    rmSync(d, { recursive: true, force: true })
  })

  it('Audit and Status say when the access rules are not in place (nothing installed here)', () => {
    const r = ps('drishti-services.ps1', ['-Action', 'Audit', '-ConfigPath', config])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is missing/)
    expect(r.out).toMatch(/run -Action RepairAcl/)
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
      'would start DrishtiWorker', 'would start DrishtiGateway', 'would start DrishtiWeb', 'would wait up to', '\\scripts', 'would keep the newest',
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

  it('the virtual account SIDs are computed as Windows does (the services do not exist yet when the folders are locked); no service to stop is no service, not all', () => {
    const out = psFile(["Get-DrishtiServiceSid -ServiceName TrustedInstaller", "ConvertTo-DrishtiSid 'NT SERVICE\\Spooler'"])
    expect(out).toContain('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') // TrustedInstaller's well-known SID
    const sc = spawnSync('sc.exe', ['showsid', 'Spooler'], { encoding: 'utf8' }).stdout
    const scSid = /S-1-5-80-[0-9-]+/.exec(sc)?.[0]
    expect(scSid).toBeTruthy()
    expect(out).toContain(scSid!)
    // A configuration with go2rtc only: the update stops and starts nothing else (an empty list never means "every service").
    const only = path.join(dir, 'go2rtc-only.config.psd1')
    writeFileSync(only, readFileSync(config, 'utf8').replace("Services = @('DrishtiGo2rtc', 'DrishtiWorker', 'DrishtiGateway', 'DrishtiWeb')", "Services = @('DrishtiGo2rtc')"))
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', only, '-BuildId', 'nit1', '-DryRun'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/no service to stop/)
    expect(r.out).not.toMatch(/would stop DrishtiGo2rtc/)
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

  // Review I-6: a SYSTEM task deleting old backups must never follow a junction out of the backup folder.
  it('retention for real (-RetentionOnly): an old backup goes; a junction inside one or in place of one is never followed; the decoys stay', () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const decoy = path.join(dir, 'decoy')
    const decoy2 = path.join(dir, 'decoy2')
    mkdirSync(decoy)
    mkdirSync(decoy2)
    writeFileSync(path.join(decoy, 'keep.txt'), 'precious')
    writeFileSync(path.join(decoy2, 'manifest.json'), '{"kind":"drishti-backup"}')
    writeFileSync(path.join(decoy2, 'keep.txt'), 'precious too')
    const recent = [1, 2, 3].map((n) => `${day(n)}-nightly`)
    for (const m of recent) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    const old = `${day(40)}-nightly`
    const trap = `${day(41)}-trap`
    const jtop = `${day(42)}-jtop`
    for (const m of [old, trap]) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    const mk = (link: string, target: string) => spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
    expect(mk(path.join(backups, trap, 'inside'), decoy).status).toBe(0)
    expect(mk(path.join(backups, jtop), decoy2).status).toBe(0)
    const r = ps('backup.ps1', ['-ConfigPath', config, '-RetentionOnly'])
    expect(r.status, r.out).toBe(0)
    const left = readdirSync(backups).sort()
    expect(left).not.toContain(old)
    expect(left).toEqual([...recent, trap, jtop].sort())
    expect(readFileSync(path.join(decoy, 'keep.txt'), 'utf8')).toBe('precious')
    expect(readFileSync(path.join(decoy2, 'keep.txt'), 'utf8')).toBe('precious too')
    expect(r.out).toMatch(/kept \S+-trap: it contains a junction or link/)
    expect(r.out).toMatch(/skipped \S+-jtop: a junction or link/)
    // Remove the links themselves (never their targets) before the folder goes.
    spawnSync('cmd.exe', ['/d', '/c', 'rmdir', path.join(backups, trap, 'inside')])
    spawnSync('cmd.exe', ['/d', '/c', 'rmdir', path.join(backups, jtop)])
    rmSync(backups, { recursive: true, force: true })
  })

  // Re-review M-new-8: the backup itself (not only the retention) refuses a backup folder others may write, before it reads anything.
  it('a backup refuses a backup folder that others may write, before touching the database', () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    spawnSync('icacls.exe', [backups, '/grant', '*S-1-5-11:(OI)(CI)M'], { encoding: 'utf8' })
    const r = ps('backup.ps1', ['-ConfigPath', config, '-Tag', 'x'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Backup refused: others may change or read the backup folder\s+\(\S+backups: S-1-5-11 may write/)
    expect(r.out).not.toMatch(/backup of database/)
    expect(readdirSync(backups)).toEqual([])
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

