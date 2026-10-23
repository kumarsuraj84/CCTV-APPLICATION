import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurrentProfile } from '@/lib/auth/profile'
import type { DetailedHealth } from '@/lib/ops/health'

// P5.4 brief item 3: the AUTHENTICATED detailed variant of the health answer is for super administrators only, after their sign-in is
// complete (two-step code where it is required, own password). Everybody else gets the same 404 as for an address that does not exist.

const m = vi.hoisted(() => ({ profile: null as CurrentProfile | null, reads: 0 }))
vi.mock('@/lib/auth/profile', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/profile')>()),
  getCurrentProfile: async () => m.profile,
}))
vi.mock('@/lib/ops/health-server', () => ({
  readDetailedHealth: async (): Promise<DetailedHealth> => {
    m.reads += 1
    return { status: 'ok', build: 'b1', checkedAt: '2026-10-23T06:00:00.000Z', checks: [{ key: 'database', label: 'Database', state: 'ok', summary: 'Answering (3 ms).', facts: [] }] }
  },
}))

import { GET } from '@/app/api/health/detail/route'

const session = { aal2: true, hasFactor: true, mfaEnforced: true, privileged: true } as unknown as CurrentProfile['session']
const person = (o: Partial<CurrentProfile>): CurrentProfile => ({
  id: 'u1', org_id: 'o1', email: 'a@example.test', full_name: 'A', role: 'platform_owner', is_active: true, must_reset_password: false, store_id: null,
  capabilities: { failed: false, grants: {} }, session, ...o,
})

beforeEach(() => {
  m.profile = null
  m.reads = 0
})

describe('GET /api/health/detail (P5.4)', () => {
  it('a super administrator gets every check, never cached', async () => {
    m.profile = person({})
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ status: 'ok', build: 'b1', checks: [{ key: 'database', state: 'ok' }] })
  })

  it('nobody signed in, an administrator, a viewer: 404, and the checks are not even gathered', async () => {
    for (const p of [null, person({ role: 'admin' }), person({ role: 'user' }), person({ role: 'manager' })]) {
      m.profile = p
      const res = await GET()
      expect(res.status, p?.role ?? 'nobody').toBe(404)
      expect(await res.json()).toEqual({ error: 'Not found.' })
    }
    expect(m.reads).toBe(0)
  })

  it('a super administrator who still owes the two-step code, or must choose a password, gets 404 too', async () => {
    m.profile = person({ session: { ...session!, aal2: false } as CurrentProfile['session'] })
    expect((await GET()).status).toBe(404)
    m.profile = person({ must_reset_password: true })
    expect((await GET()).status).toBe(404)
    m.profile = person({ session: null })
    expect((await GET()).status).toBe(404)
    expect(m.reads).toBe(0)
  })
})
