import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkerStatus } from '@/lib/monitor/health'
import { assessHealth, collectHealth, expectedMigration, publicStatus, type HealthInputs, type OpsDbStatus } from '@/lib/ops/health'

// P5.4 brief item 3: the detailed health of the installation for super administrators (the Health page, /api/health/detail): the
// database, the Vault, the video gateway, the worker (lease, heartbeat, clock), the migration level, free disk space and the
// media-session clean-up. Each check is judged on its own; one failing check never hides the others.

const NOW = new Date('2026-10-23T06:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const GB = 1024 ** 3

const dbStatus = (o: Partial<OpsDbStatus> = {}): OpsDbStatus => ({
  db_time: NOW.toISOString(),
  migration: { level: '20261021000041', applied: 41 },
  vault: { ok: true },
  housekeeping: [
    { task: 'media_sessions_prune', last_run_at: iso(4 * 60_000), removed: 12, db_role: 'monitor_worker' },
    { task: 'rate_limit_prune', last_run_at: iso(4 * 60_000), removed: 0, db_role: 'monitor_worker' },
    { task: 'vault_reads_prune', last_run_at: iso(4 * 60_000), removed: 0, db_role: 'monitor_worker' },
  ],
  ...o,
})

const worker = (o: Partial<WorkerStatus> = {}): WorkerStatus => ({
  ok: true, heartbeatAgeSec: 3, requestedAt: null, runStartedAt: null, runFinishedAt: null, lastDevicesRoundAt: null, lastCamerasRoundAt: null,
  running: false, progressDone: 0, progressTotal: 0, clockSkewSec: 1, clockSkewWarning: false,
  lease: { name: 'monitor', holder: '6a2f…', token: 7, held: true, acquiredAt: iso(3_600_000), renewedAt: iso(2000), leaseUntil: iso(-18_000), renewedAgeSec: 2, holderInfo: { host: 'DRISHTI-SRV', pid: 4242 } },
  ...o,
})

const inputs = (o: Partial<HealthInputs> = {}): HealthInputs => ({
  build: 'b-20261023-0600-abc1234',
  now: NOW,
  db: { ok: true, status: dbStatus(), latencyMs: 12 },
  worker: worker(),
  gateway: { ok: true, health: { status: 'ok', registry: 'ok', openSessions: 4, lastValidationAgeSec: 3, validateEverySec: 15, failClosedAfterSec: 60 } },
  expectedMigration: '20261021000041',
  disk: { path: 'C:\\Drishti', freeBytes: 120 * GB, totalBytes: 500 * GB },
  ...o,
})

const check = (h: ReturnType<typeof assessHealth>, key: string) => h.checks.find((c) => c.key === key)!

describe('assessHealth (P5.4)', () => {
  it('everything well: status ok, every check ok, with plain summaries', () => {
    const h = assessHealth(inputs())
    expect(h.status).toBe('ok')
    expect(h.checks.map((c) => [c.key, c.state])).toEqual([
      ['database', 'ok'], ['vault', 'ok'], ['gateway', 'ok'], ['worker', 'ok'], ['clock', 'ok'], ['migrations', 'ok'], ['disk', 'ok'], ['cleanup', 'ok'],
    ])
    expect(check(h, 'worker').summary).toBe('Running; it holds the monitoring lease (renewed 2 seconds ago).')
    expect(check(h, 'cleanup').summary).toBe('Unused video sessions were last cleaned up 4 minutes ago (12 removed).')
    expect(check(h, 'migrations').summary).toBe('The database is at 20261021000041, the level this release needs.')
    expect(check(h, 'gateway').summary).toBe('Answering; 4 video connections open, checked 3 seconds ago.')
    expect(h.build).toBe('b-20261023-0600-abc1234')
  })

  it('the database down: database failed, the Vault, migrations and clean-up unknown, status degraded', () => {
    const h = assessHealth(inputs({ db: { ok: false }, worker: null }))
    expect(h.status).toBe('degraded')
    expect(check(h, 'database').state).toBe('failed')
    expect(check(h, 'vault').state).toBe('unknown')
    expect(check(h, 'migrations').state).toBe('unknown')
    expect(check(h, 'cleanup').state).toBe('unknown')
    expect(check(h, 'worker').state).toBe('unknown')
    // The other checks are still judged.
    expect(check(h, 'gateway').state).toBe('ok')
    expect(check(h, 'disk').state).toBe('ok')
  })

  it('a Vault that does not decrypt (restored without its root key) fails, with what to do', () => {
    const h = assessHealth(inputs({ db: { ok: true, status: dbStatus({ vault: { ok: false } }), latencyMs: 5 } }))
    expect(h.status).toBe('degraded')
    expect(check(h, 'vault').state).toBe('failed')
    expect(check(h, 'vault').summary).toMatch(/root key/)
  })

  it('the gateway not answering fails; answering without checking its connections is a warning', () => {
    expect(check(assessHealth(inputs({ gateway: { ok: false } })), 'gateway').state).toBe('failed')
    const notVerifying = assessHealth(inputs({ gateway: { ok: true, health: { status: 'not_verifying', registry: 'failing', openSessions: 0, lastValidationAgeSec: 90, validateEverySec: 15, failClosedAfterSec: 60 } } }))
    expect(check(notVerifying, 'gateway').state).toBe('warning')
    expect(notVerifying.status).toBe('ok')
  })

  it('the worker: stopped fails; running without the lease (standby) is a warning; the clock skew warning is shown', () => {
    const stopped = assessHealth(inputs({ worker: worker({ ok: false, heartbeatAgeSec: 400, lease: null }) }))
    expect(check(stopped, 'worker').state).toBe('failed')
    expect(check(stopped, 'worker').summary).toMatch(/Not running.*7 minutes/)
    const standby = assessHealth(inputs({ worker: worker({ lease: { ...worker().lease!, held: false, renewedAgeSec: 95 } }) }))
    expect(check(standby, 'worker').state).toBe('warning')
    const skewed = assessHealth(inputs({ worker: worker({ clockSkewSec: -95, clockSkewWarning: true }) }))
    expect(check(skewed, 'clock').state).toBe('warning')
    expect(check(skewed, 'clock').summary).toBe("The worker's clock is 95 seconds behind the database's. Keep the server on time sync.")
  })

  it('the web server clock against the database clock is checked too (more than 30 s off is a warning)', () => {
    const h = assessHealth(inputs({ db: { ok: true, status: dbStatus({ db_time: new Date(NOW.getTime() + 45_000).toISOString() }), latencyMs: 10 } }))
    expect(check(h, 'clock').state).toBe('warning')
    expect(check(h, 'clock').summary).toMatch(/web server's clock is 45 seconds behind/)
  })

  it('migrations: pending ones fail, a database ahead of the code warns, an unknown expectation is unknown', () => {
    const pending = assessHealth(inputs({ db: { ok: true, status: dbStatus({ migration: { level: '20261021000039', applied: 39 } }), latencyMs: 1 } }))
    expect(check(pending, 'migrations').state).toBe('failed')
    expect(check(pending, 'migrations').summary).toMatch(/not applied yet/)
    const ahead = assessHealth(inputs({ expectedMigration: '20261021000040' }))
    expect(check(ahead, 'migrations').state).toBe('warning')
    expect(check(assessHealth(inputs({ expectedMigration: null })), 'migrations').state).toBe('unknown')
  })

  it('disk: under 15 % or 10 GB free warns, under 5 % or 2 GB fails, unreadable is unknown', () => {
    expect(check(assessHealth(inputs({ disk: { path: 'C:\\', freeBytes: 40 * GB, totalBytes: 500 * GB } })), 'disk').state).toBe('warning')
    expect(check(assessHealth(inputs({ disk: { path: 'C:\\', freeBytes: 8 * GB, totalBytes: 50 * GB } })), 'disk').state).toBe('warning')
    expect(check(assessHealth(inputs({ disk: { path: 'C:\\', freeBytes: 1.5 * GB, totalBytes: 500 * GB } })), 'disk').state).toBe('failed')
    expect(check(assessHealth(inputs({ disk: null })), 'disk').state).toBe('unknown')
    expect(check(assessHealth(inputs()), 'disk').summary).toBe('120.0 GB free of 500.0 GB (24 %) on C:\\Drishti.')
  })

  it('the media-session clean-up: older than 30 minutes warns; never recorded is a warning while the worker runs', () => {
    const old = dbStatus({ housekeeping: [{ task: 'media_sessions_prune', last_run_at: iso(45 * 60_000), removed: 0, db_role: 'monitor_worker' }] })
    expect(check(assessHealth(inputs({ db: { ok: true, status: old, latencyMs: 1 } })), 'cleanup').state).toBe('warning')
    const never = dbStatus({ housekeeping: [] })
    const h = assessHealth(inputs({ db: { ok: true, status: never, latencyMs: 1 } }))
    expect(check(h, 'cleanup').state).toBe('warning')
    expect(check(h, 'cleanup').summary).toMatch(/not recorded yet/)
  })

  it('carries no secret: no lease holder id, no token value, no key', () => {
    const text = JSON.stringify(assessHealth(inputs()))
    expect(text).not.toContain('6a2f')
    expect(text).not.toMatch(/token|password|secret/i)
  })

  it('publicStatus is the status only', () => {
    expect(publicStatus(assessHealth(inputs()))).toEqual({ status: 'ok' })
    expect(publicStatus(assessHealth(inputs({ db: { ok: false }, worker: null })))).toEqual({ status: 'degraded' })
  })
})

describe('collectHealth (P5.4)', () => {
  it('a check that throws or hangs is reported as failed or unknown and never stops the others', async () => {
    const h = await collectHealth({
      build: 'dev', now: () => NOW, timeoutMs: 50,
      opsStatus: async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2')
      },
      workerStatus: () => new Promise(() => {}),
      gateway: async () => ({ ok: false }),
      disk: async () => ({ path: 'C:\\', freeBytes: 100 * GB, totalBytes: 200 * GB }),
      expectedMigration: () => '20261021000041',
    })
    expect(h.status).toBe('degraded')
    expect(h.checks.find((c) => c.key === 'database')?.state).toBe('failed')
    expect(h.checks.find((c) => c.key === 'worker')?.state).toBe('unknown')
    expect(h.checks.find((c) => c.key === 'disk')?.state).toBe('ok')
    expect(JSON.stringify(h)).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/)
  })
})

describe('expectedMigration (P5.4)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'drishti-p54-'))
    dirs.push(d)
    return d
  }

  it('reads release.json written by update.ps1 first', () => {
    const d = temp()
    writeFileSync(path.join(d, 'release.json'), JSON.stringify({ buildId: 'b1', migration: '20261021000041' }))
    expect(expectedMigration(d, {})).toBe('20261021000041')
  })

  it('else DRISHTI_EXPECTED_MIGRATION, else the highest file in supabase/migrations, else null', () => {
    const d = temp()
    expect(expectedMigration(d, { DRISHTI_EXPECTED_MIGRATION: '20261021000040' })).toBe('20261021000040')
    mkdirSync(path.join(d, 'supabase', 'migrations'), { recursive: true })
    for (const f of ['20261021000001_a.sql', '20261021000041_p54_ops_audit.sql', '20261021000009_b.sql', 'notes.txt']) writeFileSync(path.join(d, 'supabase', 'migrations', f), '')
    expect(expectedMigration(d, {})).toBe('20261021000041')
    expect(expectedMigration(temp(), {})).toBeNull()
  })

  it('ignores a release.json or a variable that is not a migration number', () => {
    const d = temp()
    writeFileSync(path.join(d, 'release.json'), '{"migration":"drop table"}')
    expect(expectedMigration(d, { DRISHTI_EXPECTED_MIGRATION: 'x' })).toBeNull()
  })
})
