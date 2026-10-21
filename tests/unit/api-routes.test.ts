import { describe, expect, it } from 'vitest'
import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

describe('health and version routes', () => {
  it('health says ok', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('version reports the build id', async () => {
    process.env.NEXT_PUBLIC_BUILD_ID = 'abc123'
    const res = await version()
    expect(await res.json()).toEqual({ build: 'abc123' })
  })

  it('version falls back to dev', async () => {
    delete process.env.NEXT_PUBLIC_BUILD_ID
    const res = await version()
    expect(await res.json()).toEqual({ build: 'dev' })
  })
})
