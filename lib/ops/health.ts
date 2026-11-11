import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkerStatus } from '@/lib/monitor/health'
import { HOUSEKEEPING_EVERY_MS } from '@/lib/monitor/housekeeping'
import type { GatewayHealthView } from '@/lib/streams/gateway-health'
import { mfaHealthCheck } from '@/lib/security/production-checks' // final fix Y (review A I-1, B I-1): two-step sign-in

// P5.4 brief item 3: the detailed health of an installation, for super administrators (the Health page /admin/health and
// /api/health/detail). The public /api/health says only "ok" or "degraded" (publicStatus). Each check is judged on its own, in plain
// English, and one that fails or cannot be read never hides the others. Nothing here carries a secret, a lease holder id, a token,
// an address or an error text from the database: only states, ages, counts and the migration level.

export type CheckState = 'ok' | 'warning' | 'failed' | 'unknown'
export type CheckKey = 'database' | 'vault' | 'gateway' | 'worker' | 'clock' | 'migrations' | 'disk' | 'cleanup' | 'fixtures' | 'backup' | 'mfa'
export type HealthCheck = { key: CheckKey; label: string; state: CheckState; summary: string; facts: [string, string][] }
export type DetailedHealth = { status: 'ok' | 'degraded'; build: string; checkedAt: string; checks: HealthCheck[] }

/** What ops_health_status() answers (migration 20261021000041). */
export type OpsDbStatus = {
  db_time: string
  migration: { level: string | null; applied: number }
  vault: { ok: boolean }
  housekeeping: { task: string; last_run_at: string; removed: number; db_role: string }[]
  /** Migration 0046: whether the test fixture switch is on, and whether the database is marked as a production one. */
  test_fixtures?: { on: boolean; production: boolean }
}
export type DiskInfo = { path: string; freeBytes: number; totalBytes: number }

export type HealthInputs = {
  build: string
  now: Date
  db: { ok: true; status: OpsDbStatus; latencyMs: number } | { ok: false }
  /** null = could not be read. */
  worker: WorkerStatus | null
  gateway: GatewayHealthView
  expectedMigration: string | null
  /** One disk, or each disk of diskDirs() (null = could not be read). */
  disk: DiskInfo | null | (DiskInfo | null)[]
  /** Production mode (DRISHTI_ENV=production): the test fixture switch must be off. */
  production?: boolean
  /** Final review C-I5: false when the worker is kept stopped on purpose (DRISHTI_WORKER_EXPECTED=false). */
  workerExpected?: boolean
}

/** More than this between two clocks is a warning (the same 30 s as the worker's own warning, docs/drishti/worker-lease.md section 9). */
export const CLOCK_SKEW_WARN_SEC = 30
/** A worker heartbeat older than this is a worker that is not running: its clock is not compared (the Worker check says it is down). */
export const WORKER_CLOCK_STALE_SEC = 300
/** The clean-up runs every 10 minutes; three missed runs is a warning. */
export const CLEANUP_STALE_MS = 3 * HOUSEKEEPING_EVERY_MS
const GB = 1024 ** 3
export const DISK_FAIL = { bytes: 2 * GB, percent: 5 }
export const DISK_WARN = { bytes: 10 * GB, percent: 15 }
const MIGRATION = /^\d{14}$/

function ago(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 90) return `${s} second${s === 1 ? '' : 's'} ago`
  const min = Math.round(s / 60)
  if (min < 120) return `${min} minutes ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`
}
const secs = (n: number) => `${Math.abs(n)} second${Math.abs(n) === 1 ? '' : 's'}`
const gb = (b: number) => `${(b / GB).toFixed(1)} GB`

function database(i: HealthInputs): HealthCheck {
  const base = { key: 'database' as const, label: 'Database' }
  if (!i.db.ok) {
    return {
      ...base, state: 'failed', facts: [],
      // Final review C-I13: after an unattended restart the database may simply not have started yet.
      summary: 'The database could not be reached or did not answer the health question. After a restart of the server: is the database server running? Docker Desktop starts only when somebody signs in, so it does not bring a database back by itself (docs/drishti/runbooks/windows-services.md section 1).',
    }
  }
  return { ...base, state: 'ok', summary: `Answering (${i.db.latencyMs} ms).`, facts: [['Answer time', `${i.db.latencyMs} ms`]] }
}

function vault(i: HealthInputs): HealthCheck {
  const base = { key: 'vault' as const, label: 'Vault (saved NVR logins)' }
  if (!i.db.ok) return { ...base, state: 'unknown', summary: 'Not known: the database could not be read.', facts: [] }
  return i.db.status.vault.ok
    ? { ...base, state: 'ok', summary: "Saved NVR logins can be read back (the Vault's check value decrypts).", facts: [] }
    : {
        ...base, state: 'failed', facts: [],
        summary: "The Vault's check value does not decrypt: the Vault root key of this server is not the one the NVR logins were saved with (restore the root key file with the backup; docs/drishti/runbooks/backup-restore.md).",
      }
}

function gateway(i: HealthInputs): HealthCheck {
  const base = { key: 'gateway' as const, label: 'Video gateway' }
  if (!i.gateway.ok) return { ...base, state: 'failed', summary: 'Not answering: live video and playback cannot start.', facts: [] }
  const g = i.gateway.health
  const facts: [string, string][] = [['Open video connections', String(g.openSessions)]]
  if (g.lastValidationAgeSec !== null) facts.push(['Connections last re-checked', ago(g.lastValidationAgeSec)])
  if (g.status !== 'ok' || g.registry !== 'ok') {
    return { ...base, state: 'warning', facts, summary: 'Answering, but it cannot check open video connections against the database right now (it closes them if this lasts).' }
  }
  const checked = g.lastValidationAgeSec === null ? 'not re-checked yet' : `checked ${ago(g.lastValidationAgeSec)}`
  return { ...base, state: 'ok', facts, summary: `Answering; ${g.openSessions} video connection${g.openSessions === 1 ? '' : 's'} open, ${checked}.` }
}

function worker(i: HealthInputs): HealthCheck {
  const base = { key: 'worker' as const, label: 'Monitoring worker' }
  if (!i.db.ok || !i.worker) return { ...base, state: 'unknown', summary: 'Not known: its status could not be read.', facts: [] }
  const w = i.worker
  const facts: [string, string][] = [['Last sign of life', w.heartbeatAgeSec === null ? 'never' : ago(w.heartbeatAgeSec)]]
  const host = typeof w.lease?.holderInfo.host === 'string' ? w.lease.holderInfo.host : null
  if (w.lease) {
    facts.push(['Lease', w.lease.held ? `held, renewed ${ago(w.lease.renewedAgeSec)}` : `not held (last renewed ${ago(w.lease.renewedAgeSec)})`])
    if (host) facts.push(['Lease taken on', host.slice(0, 64)])
    facts.push(['Lease taken', ago((i.now.getTime() - Date.parse(w.lease.acquiredAt)) / 1000)])
  }
  if (!w.ok && i.workerExpected === false) {
    return { ...base, state: 'warning', facts, summary: 'Not running: stopped on purpose (DRISHTI_WORKER_EXPECTED=false). Monitoring results are not checked while it is stopped.' }
  }
  if (!w.ok) {
    return { ...base, state: 'failed', facts, summary: `Not running: no sign of life ${w.heartbeatAgeSec === null ? 'ever' : `for ${ago(w.heartbeatAgeSec).replace(' ago', '')}`}. Status on the other pages is going out of date.` }
  }
  if (!w.lease || !w.lease.held) {
    return { ...base, state: 'warning', facts, summary: 'Alive, but no worker holds the monitoring lease right now (it takes it within 20 seconds; if this lasts, see the "worker stuck" runbook).' }
  }
  return { ...base, state: 'ok', facts, summary: `Running; it holds the monitoring lease (renewed ${ago(w.lease.renewedAgeSec)}).` }
}

function clock(i: HealthInputs): HealthCheck {
  const base = { key: 'clock' as const, label: 'Clocks' }
  const notes: string[] = []
  const facts: [string, string][] = []
  let known = false
  // P5.4 fix round 3 (P5.5 report defect 3): the skew comes from the worker's last heartbeat; a worker that has not run for more than
  // WORKER_CLOCK_STALE_SEC is not running, and an old heartbeat is not a clock difference.
  const stale = i.worker && (i.worker.heartbeatAgeSec === null || i.worker.heartbeatAgeSec > WORKER_CLOCK_STALE_SEC)
  if (i.worker && stale) {
    facts.push(["Worker's clock against the database", 'not compared: the worker is not running'])
  } else if (i.worker && i.worker.clockSkewSec !== null) {
    known = true
    const s = i.worker.clockSkewSec
    facts.push(["Worker's clock against the database", s === 0 ? 'the same' : `${secs(s)} ${s > 0 ? 'ahead' : 'behind'}`])
    if (i.worker.clockSkewWarning || Math.abs(s) > CLOCK_SKEW_WARN_SEC) notes.push(`The worker's clock is ${secs(s)} ${s > 0 ? 'ahead of' : 'behind'} the database's.`)
  }
  if (i.db.ok) {
    known = true
    // The database's time was taken half way through the call, roughly.
    const web = Math.round((i.now.getTime() - i.db.latencyMs / 2 - Date.parse(i.db.status.db_time)) / 1000)
    facts.push(["Web server's clock against the database", web === 0 ? 'the same' : `${secs(web)} ${web > 0 ? 'ahead' : 'behind'}`])
    if (Math.abs(web) > CLOCK_SKEW_WARN_SEC) notes.push(`The web server's clock is ${secs(web)} ${web > 0 ? 'ahead of' : 'behind'} the database's.`)
  }
  if (!known) return { ...base, state: 'unknown', summary: 'Not known: neither clock could be compared.', facts }
  if (notes.length > 0) return { ...base, state: 'warning', facts, summary: `${notes.join(' ')} Keep the server on time sync.` }
  return { ...base, state: 'ok', facts, summary: `Within ${CLOCK_SKEW_WARN_SEC} seconds of the database's clock.` }
}

function migrations(i: HealthInputs): HealthCheck {
  const base = { key: 'migrations' as const, label: 'Database version' }
  if (!i.db.ok) return { ...base, state: 'unknown', summary: 'Not known: the database could not be read.', facts: [] }
  const level = i.db.status.migration.level
  const facts: [string, string][] = [['Database level', level ?? 'not recorded'], ['Needed by this release', i.expectedMigration ?? 'not known']]
  if (!level || !i.expectedMigration) return { ...base, state: 'unknown', facts, summary: 'The level the database is at, or the level this release needs, is not known.' }
  if (level === i.expectedMigration) return { ...base, state: 'ok', facts, summary: `The database is at ${level}, the level this release needs.` }
  if (level < i.expectedMigration) {
    return { ...base, state: 'failed', facts, summary: `Migrations up to ${i.expectedMigration} are not applied yet (the database is at ${level}): run the update again (docs/drishti/runbooks/update-rollback.md).` }
  }
  return { ...base, state: 'warning', facts, summary: `The database (${level}) is newer than this release expects (${i.expectedMigration}): the code was rolled back without the database.` }
}

function disk(i: HealthInputs): HealthCheck {
  const base = { key: 'disk' as const, label: 'Free disk space' }
  // P5.4 review M-4: the data folder and the backup folder may be on different disks; each is reported and the fuller one decides.
  const many = Array.isArray(i.disk)
  const disks = (many ? (i.disk as (DiskInfo | null)[]) : [i.disk as DiskInfo | null]).filter((d): d is DiskInfo => d !== null && d.totalBytes > 0)
  if (disks.length === 0) return { ...base, state: 'unknown', summary: 'Not known: the disk could not be read.', facts: [] }
  let worst: 'ok' | 'warning' | 'failed' = 'ok'
  const parts: string[] = []
  const facts: [string, string][] = []
  for (const d of disks) {
    const percent = Math.round((d.freeBytes / d.totalBytes) * 100)
    parts.push(`${gb(d.freeBytes)} free of ${gb(d.totalBytes)} (${percent} %) on ${d.path}.`)
    facts.push([many ? `Free on ${d.path}` : 'Free', `${gb(d.freeBytes)} (${percent} %)`])
    if (d.freeBytes < DISK_FAIL.bytes || percent < DISK_FAIL.percent) worst = 'failed'
    else if ((d.freeBytes < DISK_WARN.bytes || percent < DISK_WARN.percent) && worst === 'ok') worst = 'warning'
  }
  const summary = parts.join(' ')
  if (worst === 'failed') return { ...base, state: 'failed', facts, summary: `${summary} Backups and logs will fail soon: free some space.` }
  if (worst === 'warning') return { ...base, state: 'warning', facts, summary: `${summary} Plan to free some space.` }
  return { ...base, state: 'ok', facts, summary }
}

/**
 * The folders whose disks the Health page reports: DRISHTI_DATA_DIR (data and logs) and DRISHTI_BACKUP_DIR (the backups, often on
 * another disk), each once (compared without case, as on Windows); the server's own folder when neither is set.
 */
export function diskDirs(env: Record<string, string | undefined>, fallback: string): string[] {
  const out: string[] = []
  for (const v of [env.DRISHTI_DATA_DIR, env.DRISHTI_BACKUP_DIR]) {
    const d = v?.trim()
    if (d && !out.some((o) => o.toLowerCase() === d.toLowerCase())) out.push(d)
  }
  return out.length > 0 ? out : [fallback]
}

function cleanup(i: HealthInputs): HealthCheck {
  const base = { key: 'cleanup' as const, label: 'Clean-up of unused video sessions' }
  if (!i.db.ok) return { ...base, state: 'unknown', summary: 'Not known: the database could not be read.', facts: [] }
  const run = i.db.status.housekeeping.find((h) => h.task === 'media_sessions_prune')
  if (!run) {
    return { ...base, state: i.worker?.ok ? 'warning' : 'unknown', facts: [], summary: 'A clean-up run is not recorded yet (the worker runs it every 10 minutes while it holds the lease).' }
  }
  const ageMs = i.now.getTime() - Date.parse(run.last_run_at)
  const facts: [string, string][] = [['Last run', ago(ageMs / 1000)], ['Rows removed then', String(run.removed)], ['Run by', run.db_role === 'monitor_worker' ? 'the worker' : run.db_role]]
  if (ageMs > CLEANUP_STALE_MS) {
    return { ...base, state: 'warning', facts, summary: `The last clean-up was ${ago(ageMs / 1000)}; it should run every 10 minutes (is the worker running and holding the lease?).` }
  }
  return { ...base, state: 'ok', facts, summary: `Unused video sessions were last cleaned up ${ago(ageMs / 1000)} (${run.removed} removed).` }
}

// P5.4 fix round 2 (re-review N-2): the test helpers (and the test fixtures header) run only while this switch is on; supabase/seed.sql
// turns it on, so on a production database it means the database was seeded for tests.
function fixtures(i: HealthInputs): HealthCheck {
  const base = { key: 'fixtures' as const, label: 'Test fixture switch' }
  if (!i.db.ok || !i.db.status.test_fixtures) return { ...base, state: 'unknown', summary: 'Not known: the database does not report it (migration 20261021000046).', facts: [] }
  const t = i.db.status.test_fixtures
  const facts: [string, string][] = [['Switch', t.on ? 'on' : 'off'], ['Marked as a production database', t.production ? 'yes' : 'no']]
  if (!t.on) return { ...base, state: 'ok', facts, summary: `Off: the test helpers cannot run on this database${t.production ? ' (marked as a production one)' : ''}.` }
  if (i.production) {
    return {
      ...base, state: 'failed', facts,
      summary: 'On: this database was seeded for tests (supabase/seed.sql), which a production database must never be. As the database owner: UPDATE public.test_fixture_switch SET honoured = false; then find out how the seed was applied.',
    }
  }
  return { ...base, state: 'ok', facts, summary: 'On: expected on a development or test stack (supabase/seed.sql); never on a production database.' }
}

/** Final review C-I11: a nightly backup that stops is noticed. backup.ps1 records each good backup ('backup'; a test run's 'backup:test'). */
export const BACKUP_STALE_HOURS = 26
function backup(i: HealthInputs): HealthCheck {
  const base = { key: 'backup' as const, label: 'Last backup' }
  if (!i.db.ok) return { ...base, state: 'unknown', summary: 'Not known: the database could not be read.', facts: [] }
  const run = i.db.status.housekeeping.find((h) => h.task === 'backup')
  if (!run) return { ...base, state: 'warning', facts: [], summary: 'No backup is recorded yet (backup.ps1 records each good one; the nightly task: docs/drishti/runbooks/backup-restore.md section 4).' }
  const ageSec = (i.now.getTime() - Date.parse(run.last_run_at)) / 1000
  const facts: [string, string][] = [['Last good backup', ago(ageSec)]]
  if (ageSec > BACKUP_STALE_HOURS * 3600) {
    return {
      ...base, state: i.production ? 'failed' : 'warning', facts,
      summary: `The last good backup was ${ago(ageSec)}: the nightly backup has not worked since. Look at the scheduled task "Drishti nightly backup" and its last result (docs/drishti/runbooks/backup-restore.md section 4).`,
    }
  }
  return { ...base, state: 'ok', facts, summary: `The last good backup was ${ago(ageSec)}.` }
}

/** The judgement of every check. "degraded" when any check failed; warnings and unknowns alone keep "ok". */
export function assessHealth(i: HealthInputs): DetailedHealth {
  const checks = [database(i), vault(i), gateway(i), worker(i), clock(i), migrations(i), disk(i), cleanup(i), fixtures(i), backup(i), mfaHealthCheck(i.db.ok ? (i.db.status as Parameters<typeof mfaHealthCheck>[0]) : null, i.production === true)]
  return { status: checks.some((c) => c.state === 'failed') ? 'degraded' : 'ok', build: i.build, checkedAt: i.now.toISOString(), checks }
}

/** What anybody may see (the public /api/health): the status word only. */
export const publicStatus = (h: Pick<DetailedHealth, 'status'>): { status: 'ok' | 'degraded' } => ({ status: h.status })

export type HealthDeps = {
  build: string
  now: () => Date
  /** ops_health_status() through the web app's own database role. */
  opsStatus: () => Promise<OpsDbStatus>
  workerStatus: () => Promise<WorkerStatus>
  gateway: () => Promise<GatewayHealthView>
  disk: () => Promise<DiskInfo | null | (DiskInfo | null)[]>
  expectedMigration: () => string | null
  timeoutMs?: number
  production?: boolean
  workerExpected?: boolean
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.())])

/** Gathers every input (each within its own time limit; a failure becomes "failed" or "unknown") and judges them. Never throws. */
export async function collectHealth(d: HealthDeps): Promise<DetailedHealth> {
  const ms = d.timeoutMs ?? 3000
  const started = Date.now()
  const [db, w, g, disk] = await Promise.all([
    within(d.opsStatus(), ms).then((status) => ({ ok: true as const, status, latencyMs: Date.now() - started })).catch(() => ({ ok: false as const })),
    within(d.workerStatus(), ms).catch(() => null),
    within(d.gateway(), ms).catch(() => ({ ok: false as const })),
    within(d.disk(), ms).catch(() => null),
  ])
  let expected: string | null = null
  try {
    expected = d.expectedMigration()
  } catch {
    expected = null
  }
  return assessHealth({ build: d.build, now: d.now(), db, worker: w, gateway: g, expectedMigration: expected, disk, production: d.production, workerExpected: d.workerExpected })
}

/**
 * The migration level this release needs: `release.json` next to the server (written by deploy/windows/update.ps1), else
 * DRISHTI_EXPECTED_MIGRATION, else the highest file in supabase/migrations (development), else null.
 */
export function expectedMigration(dir: string = process.cwd(), env: Record<string, string | undefined> = process.env): string | null {
  try {
    const r = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')) as { migration?: unknown }
    if (typeof r.migration === 'string' && MIGRATION.test(r.migration)) return r.migration
  } catch {
    // no release.json (development) or not readable
  }
  const fromEnv = env.DRISHTI_EXPECTED_MIGRATION?.trim()
  if (fromEnv && MIGRATION.test(fromEnv)) return fromEnv
  try {
    const files = readdirSync(path.join(dir, 'supabase', 'migrations')).filter((f) => /^\d{14}_[A-Za-z0-9_.-]+\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort()
    return files.length > 0 ? files[files.length - 1] : null
  } catch {
    return null
  }
}
