// P5.4 brief item 4: backup and restore PROVEN in a disposable database. deploy/windows/backup.ps1 dumps the local database (the
// owner's data: read only, pg_dump in one snapshot with the row counts) to a temporary folder; deploy/windows/restore.ps1 restores it
// into a NEW database `drishti_restore_test` on the same local server, then compares the row counts of the key tables, checks the
// migration level against this checkout's migrations, decrypts every Vault secret and the canary secret, and compares the SHA-256 of
// the server's Vault root key with the one recorded in the backup (the key itself never leaves the database container here). The
// disposable database is dropped and the temporary folder removed. The live database is never written.
// Needs Docker (the database container); DRISHTI_SKIP_DOCKER_TESTS=1 says on purpose that this run has none.
// DRISHTI_EVIDENCE_DIR=<folder>: also copies the proof (counts and verdicts only, no secret) there.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const CONTAINER = 'supabase_db_cctv_hub'
const TARGET = 'drishti_restore_test'
const skip = process.platform !== 'win32' || process.env.DRISHTI_SKIP_DOCKER_TESTS === '1'
// Review 2 nit: the scripts never take docker from PATH; the test gives them this computer's docker.exe by its full path.
const dockerExe = () =>
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['docker'], { encoding: 'utf8' })
    .split(/\r?\n/).map((l) => l.trim()).find((l) => /docker\.exe$/i.test(l)) ?? 'docker'
const highestMigration = () => readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /^\d{14}_/.test(f)).map((f) => f.slice(0, 14)).sort().at(-1)

let dir = ''
let config = ''
// P5.4 fix round 3 (the owner's antivirus): the command goes to PowerShell on standard input; no policy switch, no script file written.
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
const ps = (script: string, args: string[]) => {
  const call = `& ${quote(path.join(ROOT, 'deploy', 'windows', script))} ${args.map((a) => (a.startsWith('-') ? a : quote(a))).join(' ')}`
  const input = `try { ${call}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input, encoding: 'utf8', timeout: 240_000 })
}
const psql = (sql: string) => execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-Atc', sql], { encoding: 'utf8' }).trim()

beforeAll(() => {
  if (skip) return
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-backup-'))
  config = path.join(dir, 'drishti.config.psd1')
  mkdirSync(path.join(dir, 'config'))
  writeFileSync(path.join(dir, 'config', 'web.env'), 'DRISHTI_ENV=production\r\nSTREAM_TOKEN_SECRET=p54-test-only-value-not-a-real-secret-0123\r\n')
  writeFileSync(config, [
    '@{',
    `  InstallRoot = '${dir}'; ConfigDir = '${path.join(dir, 'config')}'; DataDir = '${dir}'; LogDir = '${dir}'; BackupDir = '${path.join(dir, 'backups')}'`,
    `  NodeExe = '${process.execPath}'; Go2rtcExe = '${path.join(dir, 'go2rtc.exe')}'; Services = @('DrishtiWeb')`,
    `  Database = @{ Mode = 'Container'; Container = '${CONTAINER}'; User = 'supabase_admin'; Name = 'postgres' }`,
    // Review 2 nit: docker by its full path (never from PATH).
    `  DockerExe = '${dockerExe()}'`,
    `  VaultKey = @{ Mode = 'ContainerFile'; Path = '/etc/postgresql-custom/pgsodium_root.key'; KeyBackupDir = '${path.join(dir, 'keys')}' }`,
    '  Retention = @{ Days = 30; KeepAtLeast = 7 }',
    '}',
  ].join('\r\n'))
  // Review I-1: the live path is rehearsed with a DISPOSABLE database playing the live one (Name below); the owner's is never touched.
  configLive = path.join(dir, 'drishti.live.config.psd1')
  writeFileSync(configLive, readFileSync(config, 'utf8').replace("Name = 'postgres'", `Name = '${LIVE}'`))
  dropTestDatabases()
})
afterAll(() => {
  if (skip) return
  try {
    dropTestDatabases()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
let configLive = ''
const LIVE = 'drishti_restore_live'
function dropTestDatabases() {
  for (const name of psql("SELECT datname FROM pg_database WHERE datname LIKE 'drishti\\_restore%'").split(/\r?\n/).filter(Boolean)) {
    if (!/^drishti_restore[a-z0-9_]*$/.test(name)) continue
    psql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  }
}
const psqlIn = (db: string, sql: string) => execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'supabase_admin', '-d', db, '-Atc', sql], { encoding: 'utf8' }).trim()

type Proof = {
  passed: boolean; allCountsEqual: boolean; live: boolean
  counts: Record<string, { backup: number; restored: number; equal: boolean }>
  migration: { backup: string; restored: string; expected: string; equalToBackup: boolean; pending: boolean }
  vault: { secrets: number; decryptable: number; allDecrypt: boolean; canaryOk: boolean }
  vaultKeyMatchesBackup: boolean | null
}

describe.skipIf(skip)('backup and restore into a disposable database (P5.4)', () => {
  let folder = ''

  it('backup.ps1 writes the dump and a manifest (counts in the dump\'s own snapshot, no secret)', () => {
    const res = path.join(dir, 'backup-result.json')
    // Final review C-I11: a test run's backup is recorded as 'backup:test', never as the real "last backup".
    const r = ps('backup.ps1', ['-ConfigPath', config, '-Tag', 'restore-test', '-IncludeConfig', '-ResultPath', res, '-RecordAs', 'backup:test'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    folder = (JSON.parse(readFileSync(res, 'utf8').replace(/^﻿/, '')) as { folder: string }).folder
    const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8').replace(/^﻿/, ''))
    expect(manifest.kind).toBe('drishti-backup')
    expect(manifest.migration).toBe(highestMigration())
    expect(manifest.counts['public.cameras']).toBeGreaterThan(0)
    expect(manifest.counts['vault.secrets']).toBeGreaterThan(0)
    expect(manifest.vaultKey.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.vaultKey.copied).toBe(false) // the key stays in the container in this test
    expect(readdirSync(path.join(dir, 'keys')).filter((f) => f.endsWith('.key'))).toEqual([])
    // -IncludeConfig: the configuration (the services' secrets) goes with the key copies, never into the dump folder.
    expect(manifest.config.copied).toBe(true)
    expect(readFileSync(path.join(manifest.config.copiedTo, 'web.env'), 'utf8')).toContain('STREAM_TOKEN_SECRET=')
    expect(readdirSync(folder).sort()).toEqual(['db.dump', 'manifest.json'])
    expect(Number(psql("SELECT extract(epoch FROM now() - last_run_at) FROM public.housekeeping_runs WHERE task = 'backup:test'"))).toBeLessThan(120)
    const text = JSON.stringify(manifest) + r.stdout
    expect(text).not.toMatch(/drishti-vault-canary-v1|password|PGPASSWORD|p54-test-only-value/i)
  }, 240_000)

  // Review 2 m3 (a key folder others may read is refused before anything is copied into it): tests/windows-lab, as it changes an
  // access list.

  it('restore.ps1 restores into a NEW database and proves it: counts, migration level, every Vault secret, the canary, the root key', () => {
    const res = path.join(dir, 'restore-result.json')
    const r = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', TARGET, '-CreateDatabase', '-DropAfterVerify', '-SourcePath', ROOT, '-ResultPath', res])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const proof = JSON.parse(readFileSync(res, 'utf8').replace(/^﻿/, '')) as Proof
    expect(proof.passed).toBe(true)
    expect(proof.live).toBe(false)
    expect(proof.allCountsEqual).toBe(true)
    for (const [t, c] of Object.entries(proof.counts)) expect(c.restored, t).toBe(c.backup)
    expect(Object.keys(proof.counts)).toEqual(expect.arrayContaining(['public.locations', 'public.recorders', 'public.cameras', 'public.access_grants', 'public.admin_audit_log', 'auth.users', 'vault.secrets']))
    expect(proof.migration).toMatchObject({ restored: highestMigration(), expected: highestMigration(), equalToBackup: true, pending: false })
    expect(proof.vault.secrets).toBeGreaterThan(0)
    expect(proof.vault).toMatchObject({ allDecrypt: true, canaryOk: true })
    expect(proof.vault.decryptable).toBe(proof.vault.secrets)
    expect(proof.vaultKeyMatchesBackup).toBe(true)
    // The disposable database is gone again; the live one was never the target.
    expect(psql(`SELECT count(*) FROM pg_database WHERE datname = '${TARGET}'`)).toBe('0')
    const evidence = process.env.DRISHTI_EVIDENCE_DIR
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(path.join(evidence, 'backup-restore-proof.json'), JSON.stringify({ ranAt: new Date().toISOString(), restoreOutput: r.stdout.split(/\r?\n/).filter(Boolean), proof }, null, 2))
    }
  }, 240_000)

  // Review I-1: the live path, rehearsed on disposable databases. A database made from the backup plays the live one; it is changed
  // (an extra row); then the live restore backs it up, restores into a new copy, proves the copy, and only then swaps it in, keeping
  // the changed one under another name. An in-place `pg_restore --clean` was tried first and fails on a Supabase database
  // (partitioned realtime tables), which is why the restore copies and swaps.
  it('the live path on a disposable "live" database: backup first, restore into a copy, prove it, swap; the old one kept', () => {
    const made = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', LIVE, '-CreateDatabase'])
    expect(made.status, made.stdout + made.stderr).toBe(0)
    const before = Number(psqlIn(LIVE, 'SELECT count(*) FROM public.admin_audit_log'))
    psqlIn(LIVE, "INSERT INTO public.admin_audit_log (org_id, action) SELECT id, 'p54_live_restore_marker' FROM public.organizations ORDER BY created_at LIMIT 1")
    expect(Number(psqlIn(LIVE, 'SELECT count(*) FROM public.admin_audit_log'))).toBe(before + 1)
    const res = path.join(dir, 'live-result.json')
    const r = ps('restore.ps1', ['-ConfigPath', configLive, '-BackupPath', folder, '-TargetDatabase', LIVE, '-AllowLiveDatabase', '-PreRestoreBackup', '-ResultPath', res])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const proof = JSON.parse(readFileSync(res, 'utf8').replace(/^﻿/, '')) as Proof & { swapped: boolean; keptAs: string; preRestoreBackup: boolean }
    expect(proof).toMatchObject({ passed: true, live: true, swapped: true, preRestoreBackup: true, allCountsEqual: true })
    // The live name now holds the backup's state again; the changed database is kept, intact, under its new name.
    expect(Number(psqlIn(LIVE, 'SELECT count(*) FROM public.admin_audit_log'))).toBe(before)
    expect(proof.keptAs).toMatch(/^drishti_restore_live_before_restore_\d{14}$/)
    expect(psqlIn(proof.keptAs, "SELECT count(*) FROM public.admin_audit_log WHERE action = 'p54_live_restore_marker'")).toBe('1')
    expect(psqlIn(LIVE, "SELECT count(*) FILTER (WHERE decrypted_secret IS NOT NULL) = count(*) FROM vault.decrypted_secrets")).toBe('t')
    // The backup before the restore exists (the live database as it was, made by backup.ps1).
    expect(readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('-before-restore'))).toBe(true)
    expect(r.stdout).toMatch(/the database as it was is kept as drishti_restore_live_before_restore_/)
  }, 300_000)

  it('the live path refuses to swap a copy that does not prove out: the "live" database stays as it was', () => {
    // A manifest that claims one more camera than the dump holds: the copy's counts differ, so nothing is swapped.
    const forged = path.join(dir, 'forged')
    mkdirSync(forged)
    copyFileSync(path.join(folder, 'db.dump'), path.join(forged, 'db.dump'))
    const m = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8').replace(/^﻿/, ''))
    m.counts['public.cameras'] += 1
    writeFileSync(path.join(forged, 'manifest.json'), JSON.stringify(m))
    const before = psqlIn(LIVE, 'SELECT count(*) FROM public.cameras')
    const r = ps('restore.ps1', ['-ConfigPath', configLive, '-BackupPath', forged, '-TargetDatabase', LIVE, '-AllowLiveDatabase'])
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/the live database drishti_restore_live was NOT changed/)
    expect(psqlIn(LIVE, 'SELECT count(*) FROM public.cameras')).toBe(before)
    // The unused copy was dropped; only the live one and the kept one of the previous test remain.
    expect(psql("SELECT count(*) FROM pg_database WHERE datname LIKE 'drishti_restore_live_restored%'")).toBe('0')
  }, 300_000)

  // Fix round 2 (re-review M-new-3): a swap that fails half way says exactly where the databases are, puts the live one back when it
  // can, and never drops the restored copy once the live database has been renamed.
  it('a swap that fails after closing the live database opens it again; one that fails after the first rename puts it back and keeps the copy', () => {
    const before = psqlIn(LIVE, 'SELECT count(*) FROM public.cameras')
    const closedRes = path.join(dir, 'swap-closed.json')
    const closed = ps('restore.ps1', ['-ConfigPath', configLive, '-BackupPath', folder, '-TargetDatabase', LIVE, '-AllowLiveDatabase', '-SimulateSwapFailure', 'AfterClose', '-ResultPath', closedRes])
    expect(closed.status).not.toBe(0)
    expect(closed.stdout).toMatch(/STOPPED before anything was renamed: drishti_restore_live was closed to new connections for the swap and is open again/)
    expect(closed.stdout).not.toMatch(/was NOT changed/)
    expect(JSON.parse(readFileSync(closedRes, 'utf8').replace(/^﻿/, ''))).toMatchObject({ swapState: 'reopened', swapped: false })
    expect(psql(`SELECT datallowconn FROM pg_database WHERE datname = '${LIVE}'`)).toBe('t')
    expect(psql("SELECT count(*) FROM pg_database WHERE datname LIKE 'drishti_restore_live_restored%'")).toBe('0') // nothing renamed: dropped

    const renamedRes = path.join(dir, 'swap-renamed.json')
    const renamed = ps('restore.ps1', ['-ConfigPath', configLive, '-BackupPath', folder, '-TargetDatabase', LIVE, '-AllowLiveDatabase', '-SimulateSwapFailure', 'AfterFirstRename', '-ResultPath', renamedRes])
    expect(renamed.status).not.toBe(0)
    expect(renamed.stdout).toMatch(/STOPPED half way through the swap: the old database was put back as drishti_restore_live and accepts connections again/)
    expect(renamed.stdout).not.toMatch(/was NOT changed/)
    const state = JSON.parse(readFileSync(renamedRes, 'utf8').replace(/^﻿/, '')) as { swapState: string; restoredCopy: string }
    expect(state.swapState).toBe('put back')
    expect(psqlIn(LIVE, 'SELECT count(*) FROM public.cameras')).toBe(before)
    expect(psql(`SELECT datallowconn FROM pg_database WHERE datname = '${LIVE}'`)).toBe('t')
    // The proven copy is kept (not dropped) for a person to look at.
    expect(psql(`SELECT count(*) FROM pg_database WHERE datname = '${state.restoredCopy}'`)).toBe('1')
    // A test-only switch, refused for any other database.
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', 'postgres', '-AllowLiveDatabase', '-SimulateSwapFailure', 'AfterClose', '-DryRun']).stdout + '').not.toMatch(/would restore/)
  }, 600_000)

  it('refuses the live database without -AllowLiveDatabase, a bad name, an existing database and a damaged dump, changing nothing', () => {
    const before = psql("SELECT count(*) FROM public.cameras WHERE org_id IN (SELECT id FROM public.organizations WHERE slug NOT LIKE 'test-%')")
    const live = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', 'postgres'])
    expect(live.status).not.toBe(0)
    expect(live.stdout + live.stderr).toMatch(/live database/)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', 'Bad-Name;', '-CreateDatabase']).status).not.toBe(0)
    expect(ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', 'postgres_copy']).status).not.toBe(0) // needs -CreateDatabase
    const existing = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', 'template1', '-CreateDatabase'])
    expect(existing.status).not.toBe(0)
    expect(existing.stdout + existing.stderr).toMatch(/exists already/)
    const damaged = path.join(dir, 'damaged')
    mkdirSync(damaged)
    copyFileSync(path.join(folder, 'manifest.json'), path.join(damaged, 'manifest.json'))
    const bytes = readFileSync(path.join(folder, 'db.dump'))
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    writeFileSync(path.join(damaged, 'db.dump'), bytes)
    const bad = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', damaged, '-TargetDatabase', TARGET, '-CreateDatabase'])
    expect(bad.status).not.toBe(0)
    expect(bad.stdout + bad.stderr).toMatch(/SHA-256 differs/)
    expect(psql(`SELECT count(*) FROM pg_database WHERE datname = '${TARGET}'`)).toBe('0')
    expect(psql("SELECT count(*) FROM public.cameras WHERE org_id IN (SELECT id FROM public.organizations WHERE slug NOT LIKE 'test-%')")).toBe(before)
  }, 240_000)

  it('the dry runs plan only: no backup folder, no database', () => {
    const b = ps('backup.ps1', ['-ConfigPath', config, '-Tag', 'dry', '-DryRun', '-ApplyRetention'])
    expect(b.status, b.stderr).toBe(0)
    expect(b.stdout).toMatch(/PLAN would open one REPEATABLE READ snapshot/)
    expect(readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('-dry'))).toEqual([])
    const r = ps('restore.ps1', ['-ConfigPath', config, '-BackupPath', folder, '-TargetDatabase', TARGET, '-CreateDatabase', '-DropAfterVerify', '-DryRun'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/PLAN would create the database drishti_restore_test/)
    expect(psql(`SELECT count(*) FROM pg_database WHERE datname = '${TARGET}'`)).toBe('0')
  }, 240_000)
})
