import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HealthChecks } from '@/components/admin/HealthChecks'
import { assessHealth } from '@/lib/ops/health'

// P5.4 brief item 3: the Health page shows every check with a word and an icon (never colour alone), its plain summary and facts; the
// worker's clock skew warning, which P2-7 computed but no page showed, is on it.

const NOW = new Date('2026-10-23T06:00:00.000Z')
const base = () =>
  assessHealth({
    build: 'b-20261023-0600-abc1234', now: NOW,
    db: { ok: true, latencyMs: 8, status: { db_time: NOW.toISOString(), migration: { level: '20261021000041', applied: 41 }, vault: { ok: true }, housekeeping: [{ task: 'media_sessions_prune', last_run_at: new Date(NOW.getTime() - 120_000).toISOString(), removed: 3, db_role: 'monitor_worker' }, { task: 'backup', last_run_at: new Date(NOW.getTime() - 3_600_000).toISOString(), removed: 0, db_role: 'backup.ps1' }] } },
    worker: {
      ok: true, heartbeatAgeSec: 2, requestedAt: null, runStartedAt: null, runFinishedAt: null, lastDevicesRoundAt: null, lastCamerasRoundAt: null, running: false,
      progressDone: 0, progressTotal: 0, clockSkewSec: 75, clockSkewWarning: true,
      lease: { name: 'monitor', holder: 'h', token: 3, held: true, acquiredAt: NOW.toISOString(), renewedAt: NOW.toISOString(), leaseUntil: NOW.toISOString(), renewedAgeSec: 1, holderInfo: { host: 'SRV-1', pid: 1 } },
    },
    gateway: { ok: false },
    expectedMigration: '20261021000041',
    disk: { path: 'C:\\Drishti\\data', freeBytes: 200 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
  })

describe('Health page checks (P5.4)', () => {
  it('lists every check with a state word, its summary and its facts', () => {
    const html = renderToStaticMarkup(<HealthChecks health={base()} />)
    for (const label of ['Database', 'Vault (saved NVR logins)', 'Video gateway', 'Monitoring worker', 'Clocks', 'Database version', 'Free disk space', 'Clean-up of unused video sessions']) {
      expect(html, label).toContain(label)
    }
    expect(html).toContain('Problem') // the gateway
    expect(html).toContain('Needs attention') // the clock
    expect(html).toContain('OK')
    expect(html).toContain('Not answering: live video and playback cannot start.')
    expect(html).toContain('1 problem, 1 to look at')
    expect(html).toContain('b-20261023-0600-abc1234')
  })

  it("shows the worker's clock skew warning (computed since P2-7, rendered nowhere before)", () => {
    const html = renderToStaticMarkup(<HealthChecks health={base()} />)
    expect(html).toContain('The worker&#x27;s clock is 75 seconds ahead of the database&#x27;s. Keep the server on time sync.')
    expect(html).toContain('75 seconds ahead')
  })

  it('every state has a word next to its icon (not colour alone)', () => {
    const html = renderToStaticMarkup(<HealthChecks health={base()} />)
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(9)
    expect(html).not.toMatch(/token|password|secret/i)
  })
})
