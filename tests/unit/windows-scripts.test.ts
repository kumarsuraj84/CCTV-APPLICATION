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
    expect(r.out).not.toMatch(/app \/grant NT SERVICE\\DrishtiGo2rtc/)
    expect(readdirSync(dir)).not.toContain('Drishti')
  })

  it('update -DryRun: build, back up, stop in order, migrate, switch, start, check, keep releases', () => {
    const r = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', '20261023-0600-test', '-DryRun'])
    expect(r.status, r.out).toBe(0)
    order(r.out, [
      'robocopy', 'npm ci', 'CK_BUILD_ID=20261023-0600-test', 'release.json', 'backup.ps1 -Tag pre-update-20261023-0600-test',
      '-Action Stop -Service DrishtiWeb,DrishtiGateway,DrishtiWorker', 'npx supabase migration up', 'current to', '-Action Start', 'would wait up to', 'would keep the newest',
    ])
    expect(r.out).toContain('<password from DRISHTI_DB_PASSWORD>')
    expect(r.out).not.toMatch(/Rolling back/)
    expect(readdirSync(dir)).not.toContain('Drishti')
  })

  it('update roll back plans: a failed health check restores the database and the previous release; a failed migration only restarts the old one', () => {
    const health = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b2', '-DryRun', '-SimulateFailure', 'Health'])
    expect(health.status, health.out).toBe(0)
    order(health.out, ['Rolling back', '-Action Stop', 'restore.ps1 -BackupPath', '-AllowLiveDatabase', 'current to <the previous release>', '-Action Start', 'end of the simulated roll back'])
    const start = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b3', '-DryRun', '-SimulateFailure', 'Start'])
    order(start.out, ['Rolling back', 'restore.ps1 -BackupPath', 'current to <the previous release>'])
    const migrate = ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-BuildId', 'b4', '-DryRun', '-SimulateFailure', 'Migrate'])
    expect(migrate.status, migrate.out).toBe(0)
    const after = migrate.out.slice(migrate.out.indexOf('Rolling back'))
    expect(after).not.toContain('restore.ps1')
    expect(after).not.toContain('current to')
    order(after, ['-Action Stop', '-Action Start'])
    // -SimulateFailure without a dry run is refused.
    expect(ps('update.ps1', ['-SourcePath', ROOT, '-ConfigPath', config, '-SimulateFailure', 'Health']).status).not.toBe(0)
  })

  it('backup retention (-DryRun): older than the days AND beyond the newest few go; anything not made by backup.ps1 is never touched', () => {
    const backups = path.join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const day = (n: number) => {
      const d = new Date(Date.now() - n * 86_400_000)
      const p = (x: number) => String(x).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-020000`
    }
    const made = [1, 2, 40, 45, 50, 60].map((n) => `${day(n)}-nightly`)
    for (const m of made) {
      mkdirSync(path.join(backups, m))
      writeFileSync(path.join(backups, m, 'manifest.json'), '{"kind":"drishti-backup"}')
    }
    mkdirSync(path.join(backups, 'my-own-folder'))
    mkdirSync(path.join(backups, `${day(90)}-nomanifest`))
    const r = ps('backup.ps1', ['-ConfigPath', config, '-Tag', 'x', '-DryRun', '-ApplyRetention'])
    expect(r.status, r.out).toBe(0)
    const removed = [...r.out.matchAll(/would remove the old backup \S+\\(\S+) /g)].map((m) => m[1]).sort()
    // Keep at least 3 (the newest three: 1, 2 and 40 days old) and anything under 30 days; the rest is older and beyond them.
    expect(removed).toEqual([made[3], made[4], made[5]].sort())
    expect(readdirSync(backups).sort()).toEqual([...made, 'my-own-folder', `${day(90)}-nomanifest`].sort())
  })

  it('restore refuses the live database and a database it would not create, before reading anything', () => {
    const r = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'postgres', '-DryRun'])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/live database/)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'copy1', '-DryRun']).out).toMatch(/needs -CreateDatabase/)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', dir, '-TargetDatabase', 'postgres', '-AllowLiveDatabase', '-DropAfterVerify', '-DryRun']).out).toMatch(/never applies to the live database/)
  })
})
