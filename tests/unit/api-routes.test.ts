import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    throw new Error('no database in a unit test')
  },
}))

import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

const saved = process.env.NEXT_PUBLIC_BUILD_ID
beforeEach(() => delete process.env.NEXT_PUBLIC_BUILD_ID)
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_BUILD_ID
  else process.env.NEXT_PUBLIC_BUILD_ID = saved
})

describe('health and version routes', () => {
  it('health reports degraded, with the database and the worker marked down, when the database cannot be reached', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'degraded', db: false, worker: { ok: false, heartbeatAgeSec: null } })
  })

  it('version reports the build id', async () => {
    process.env.NEXT_PUBLIC_BUILD_ID = 'abc123'
    expect(await (await version()).json()).toEqual({ build: 'abc123' })
  })

  it('version falls back to dev', async () => {
    expect(await (await version()).json()).toEqual({ build: 'dev' })
  })
})
