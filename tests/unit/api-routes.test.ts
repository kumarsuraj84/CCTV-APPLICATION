import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// What the admin client does in this test: by default there is no database.
const admin = vi.hoisted(() => ({
  create: (): unknown => {
    throw new Error('no database in a unit test')
  },
  calls: 0,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    admin.calls += 1
    return admin.create()
  },
}))

import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

/** A client whose worker_state row holds the given heartbeat. */
const clientWithHeartbeat = (lastHeartbeat: string | null) => ({
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { last_heartbeat: lastHeartbeat }, error: null }) }) }) }),
})

const saved = process.env.NEXT_PUBLIC_BUILD_ID
let testClock = Date.now()
beforeEach(() => {
  delete process.env.NEXT_PUBLIC_BUILD_ID
  // Each test starts well after the previous one, so the short-lived health cache is empty.
  vi.useFakeTimers({ toFake: ['Date'] })
  testClock += 60_000
  vi.setSystemTime(testClock)
  admin.calls = 0
  admin.create = () => {
    throw new Error('no database in a unit test')
  }
})
afterEach(() => {
  vi.useRealTimers()
  if (saved === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID
  else process.env.NEXT_PUBLIC_BUILD_ID = saved
})

describe('health and version routes', () => {
  it('health reports degraded, with the database and the worker marked down, when the database cannot be reached', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'degraded', db: false, worker: { ok: false, heartbeatAgeSec: null } })
  })

  it('health reports ok, with the age of the worker heartbeat, when the database answers and the worker is beating', async () => {
    admin.create = () => clientWithHeartbeat(new Date(Date.now() - 4000).toISOString())
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: true, worker: { ok: true, heartbeatAgeSec: 4 } })
  })

  it('health is degraded, with the database up, when the worker has stopped beating', async () => {
    admin.create = () => clientWithHeartbeat(new Date(Date.now() - 120_000).toISOString())
    expect(await (await health()).json()).toEqual({ status: 'degraded', db: true, worker: { ok: false, heartbeatAgeSec: 120 } })
  })

  it('health is never cached by browsers or proxies', async () => {
    expect((await health()).headers.get('cache-control')).toBe('no-store')
  })

  it('health asks the database at most once every two seconds', async () => {
    admin.create = () => clientWithHeartbeat(new Date(Date.now() - 4000).toISOString())
    await health()
    await health()
    await health()
    expect(admin.calls).toBe(1)
    testClock += 2500
    vi.setSystemTime(testClock)
    await health()
    expect(admin.calls).toBe(2)
  })

  it('health says nothing about why it is degraded', async () => {
    admin.create = () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2')
    }
    const text = JSON.stringify(await (await health()).json())
    expect(text).not.toMatch(/ECONNREFUSED|hunter2|10\.1\.2\.3/)
  })

  it('health logs why it is degraded, with secrets masked, at most once a minute', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      admin.create = () => {
        throw new Error('connect failed password=hunter2 Bearer abc.def-ghi')
      }
      await health()
      testClock += 3000 // past the 2 second cache: the database is asked again, but the log stays quiet
      vi.setSystemTime(testClock)
      await health()
      expect(admin.calls).toBe(2)
      expect(log).toHaveBeenCalledTimes(1)
      const line = String(log.mock.calls[0][0])
      expect(line).toContain('health_degraded')
      expect(line).not.toMatch(/hunter2|abc.def-ghi/)
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
