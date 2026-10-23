import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetailedHealth } from '@/lib/ops/health'

// P5.4 brief item 3 replaces the public answer of P2 ({ status, db, worker }): /api/health is now the PUBLIC MINIMAL variant — the
// status word only — and is worked out from every check of the detailed health (database, Vault, gateway, worker, migrations, disk,
// clean-up; lib/ops/health.ts). The details are for super administrators only (/api/health/detail, the Health page).

const h = vi.hoisted(() => ({
  read: async (): Promise<DetailedHealth> => {
    throw new Error('no database in a unit test')
  },
  calls: 0,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('no database in a unit test')
  },
}))
vi.mock('@/lib/ops/health-server', async (orig) => ({
  ...(await orig<typeof import('@/lib/ops/health-server')>()),
  readDetailedHealth: () => {
    h.calls += 1
    return h.read()
  },
}))

import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

const detailed = (status: 'ok' | 'degraded', failed: string[] = []): DetailedHealth => ({
  status, build: 'b1', checkedAt: new Date().toISOString(),
  checks: [
    { key: 'database', label: 'Database', state: failed.includes('database') ? 'failed' : 'ok', summary: 'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2', facts: [] },
    { key: 'gateway', label: 'Video gateway', state: failed.includes('gateway') ? 'failed' : 'ok', summary: 'x', facts: [['Open video connections', '4']] },
  ],
})

const saved = process.env.NEXT_PUBLIC_BUILD_ID
let testClock = Date.now()
beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BUILD_ID
  // Each test starts well after the previous one, so the short-lived health cache is empty.
  vi.useFakeTimers({ toFake: ['Date'] })
  testClock += 120_000
  vi.setSystemTime(testClock)
  h.calls = 0
  h.read = async () => {
    throw new Error('no database in a unit test')
  }
})
afterEach(() => {
  vi.useRealTimers()
  if (saved === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID
  else process.env.NEXT_PUBLIC_BUILD_ID = saved
})

describe('health and version routes', () => {
  it('health is the status word only: ok when every check is ok', async () => {
    h.read = async () => detailed('ok')
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('health is degraded when a check failed, and says nothing about which or why', async () => {
    h.read = async () => detailed('degraded', ['database'])
    const body = await (await health()).json()
    expect(body).toEqual({ status: 'degraded' })
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3|database|gateway/)
  })

  it('health is degraded, not an error, when the health could not be gathered at all', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'degraded' })
  })

  it('health is never cached by browsers or proxies', async () => {
    expect((await health()).headers.get('cache-control')).toBe('no-store')
  })

  it('health gathers the checks at most once every two seconds', async () => {
    h.read = async () => detailed('ok')
    await health()
    await health()
    await health()
    expect(h.calls).toBe(1)
    testClock += 2500
    vi.setSystemTime(testClock)
    await health()
    expect(h.calls).toBe(2)
  })

  it('health logs the names of the failed checks (never their text) at most once a minute', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      h.read = async () => detailed('degraded', ['database', 'gateway'])
      await health()
      testClock += 3000 // past the 2 second cache: the checks are gathered again, but the log stays quiet
      vi.setSystemTime(testClock)
      await health()
      expect(h.calls).toBe(2)
      expect(log).toHaveBeenCalledTimes(1)
      const line = String(log.mock.calls[0][0])
      expect(line).toContain('health_degraded')
      expect(line).toContain('database')
      expect(line).not.toMatch(/hunter2|ECONNREFUSED/)
      testClock += 61_000
      vi.setSystemTime(testClock)
      await health()
      expect(log).toHaveBeenCalledTimes(2)
    } finally {
      log.mockRestore()
    }
  })

  it('version reports the build id', async () => {
    process.env.NEXT_PUBLIC_BUILD_ID = 'abc123'
    expect(await (await version()).json()).toEqual({ build: 'abc123' })
  })

  it('version falls back to dev', async () => {
    expect(await (await version()).json()).toEqual({ build: 'dev' })
  })
})
