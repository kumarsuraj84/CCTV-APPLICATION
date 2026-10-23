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
      expect(r.out).toMatch(new RegExp(`icacls\\.exe \\S+\\\\logs\\\\${s} /inheritance:r .*NT SERVICE\\\\${s}:\\(OI\\)\\(CI\\)M`))
      expect(r.out).toMatch(new RegExp(`icacls\\.exe \\S+\\\\config\\\\\\w+\\.env /inheritance:r .*NT SERVICE\\\\${s}:R`))
    }
    expect(r.out).toContain('-DependsOn DrishtiGo2rtc')
    // go2rtc never reads the releases; nothing is created or changed in a dry run.
    expect(r.out).not.toMatch(/\\app \/inheritance:r [^\n]*DrishtiGo2rtc/)
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
      const u = /would run: (?:icacls\.exe|robocopy \S+ ->|\S*csc\.exe .*\/out:)\s*(\S+)/.exec(l)
      if (u && !firstUse.has(u[1])) firstUse.set(u[1], i)
    })
    const root = path.join(dir, 'Drishti')
    for (const p of [root, ...['bin', 'services', 'scripts', 'app', 'config'].map((x) => path.join(root, x)), path.join(dir, 'logs'), path.join(dir, 'logs', 'DrishtiWeb'), path.join(dir, 'data'), path.join(dir, 'backups'), path.join(dir, 'keys')]) {
      expect(created.has(p), `created ${p}`).toBe(true)
      const createdAt = lines.findIndex((l) => l.endsWith(`would create ${p}`))
      const lockedAt = lines.findIndex((l) => l.includes(`icacls.exe ${p} /inheritance:r`))
      expect(lockedAt, `locked ${p}`).toBeGreaterThan(createdAt)
    }
    // The first thing ever written into the root is after the root's own lock.
    const rootLock = lines.findIndex((l) => l.includes(`icacls.exe ${root} /inheritance:r`))
    const firstWrite = lines.findIndex((l) => /would (write|copy)|robocopy|csc\.exe/.test(l))
    expect(rootLock).toBeGreaterThan(-1)
    expect(firstWrite).toBeGreaterThan(rootLock)
    for (const l of lines.filter((x) => x.includes('icacls.exe') && x.includes('/inheritance:r'))) {
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
      `. '${common}'`, `$p = '${p}'`, 'Set-DrishtiAcl -Path $p', '$a = @(Test-DrishtiPathAcl -Path $p)',
      "icacls $p /grant '*S-1-5-11:(OI)(CI)M' | Out-Null", '$b = @(Test-DrishtiPathAcl -Path $p)',
      "$s = @(Find-DrishtiAclProblems -Rules @([pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights=-536805376;Type='Allow'}, [pscustomobject]@{Sid='S-1-5-11';Rights='ReadAndExecute';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-18';Rights='FullControl';Type='Allow'}, [pscustomobject]@{Sid='S-1-5-32-545';Rights='Modify';Type='Deny'}, [pscustomobject]@{Sid='S-1-5-80-1';Rights='Modify';Type='Allow'}) -AllowedSids @('S-1-5-80-1'))",
      'Write-Output "before=$($a.Count) after=$($b.Count) synthetic=$($s.Count)"',
    ].join('; ')
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' })
    expect(r.stdout, r.stderr).toMatch(/before=0 after=1 synthetic=2/)
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
      'robocopy', 'npm ci', 'CK_BUILD_ID=20261023-0600-test', 'release.json', 'backup.ps1 -Tag pre-update-20261023-0600-test',
      'would stop DrishtiWeb', 'would stop DrishtiGateway', 'would stop DrishtiWorker', 'npx supabase migration up', 'current to',
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
    order(f, ['would stop DrishtiGo2rtc', 'restore.ps1 -BackupPath', 'THE SYSTEM IS STOPPED', 'update-rollback.md'])
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

