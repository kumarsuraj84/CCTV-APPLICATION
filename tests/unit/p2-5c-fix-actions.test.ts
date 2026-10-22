import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemoryLimiter } from '../helpers/limiter-store'

// P2-6 (D-11): the shared rate limiter counts in memory here (never the database).
beforeEach(() => useMemoryLimiter())

// P2-5c-1 review M-13 / I-1: the message after a move pairs "access follows at once" with the true statement about open video
// (P2-4: the session registry stops it within a minute).
// P3-1 review I-3: changes go through the fresh-sign-in guard; this administrator signed in just now.
vi.mock('@/lib/auth/profile', () => ({ requireAdministration: async () => ({ id: 'u1', org_id: 'o1', role: 'admin', session: { lastAuthAt: Math.floor(Date.now() / 1000) } }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/inventory/hierarchy', () => ({ moveNode: async () => ({ ok: true, from: null, to: 'c1' }) }))

describe('move action message', () => {
  it('says that access follows at once and that open video of affected people stops within a minute', async () => {
    const { moveNodeAction } = await import('@/lib/actions/admin/locations')
    expect(await moveNodeAction({ kind: 'location', id: '00000000-0000-4000-8000-000000000001', to: null }))
      .toEqual({ ok: true, message: 'Moved. Access follows the new place at once. Open video for affected people stops within a minute.' })
  })
})
