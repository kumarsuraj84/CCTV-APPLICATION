import { beforeEach, describe, expect, it, vi } from 'vitest'

// P4-L1 fix round 2 (re-review N-1, N-6): POST /api/live/release, what a Live page sends when it is left (pagehide, hidden, route change;
// fetch with keepalive): the live tokens it holds. Their unused media sessions are revoked (lib/streams/open.ts releaseStreams, the
// database's media_sessions_release_live): never an open socket, never another window's or person's token, nothing is opened. Signed-in
// people only, same-origin JSON only, small bodies only.

const h = vi.hoisted(() => ({
  profile: null as null | { id: string; org_id: string },
  calls: [] as { actor: { id: string; orgId: string }; tokens: unknown }[],
  answer: { ok: true, released: 3 } as { ok: true; released: number } | { ok: false; error: string },
}))

vi.mock('@/lib/auth/profile', () => ({ getCurrentProfile: async () => h.profile }))
vi.mock('@/lib/supabase/service-clients', () => ({ createMediaClient: () => ({ media: true }) }))
vi.mock('@/lib/streams/open', async (orig) => ({
  ...(await orig<typeof import('@/lib/streams/open')>()),
  releaseStreams: async (_deps: unknown, actor: { id: string; orgId: string }, tokens: unknown) => {
    h.calls.push({ actor, tokens })
    return h.answer
  },
}))

import { POST } from '@/app/api/live/release/route'

const body = { tokens: ['t-one', 't-two'] }
const req = (o: { body?: unknown; type?: string; site?: string | null; origin?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': o.type ?? 'application/json', host: 'drishti.test' }
  if (o.site !== null) headers['sec-fetch-site'] = o.site ?? 'same-origin'
  if (o.origin) headers.origin = o.origin
  return new Request('http://drishti.test/api/live/release', { method: 'POST', headers, body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body ?? body) })
}

beforeEach(() => {
  h.profile = { id: 'u-1', org_id: 'o-1' }
  h.calls = []
  h.answer = { ok: true, released: 3 }
})

describe('POST /api/live/release (fix round 2, N-1 / N-6)', () => {
  it('hands the page\'s tokens to the release, for the signed-in person', async () => {
    const res = await POST(req())
    expect(res.status).toBe(204)
    expect(h.calls).toEqual([{ actor: { id: 'u-1', orgId: 'o-1' }, tokens: ['t-one', 't-two'] }])
  })

  it('signed out: 401, nothing released', async () => {
    h.profile = null
    expect((await POST(req())).status).toBe(401)
    expect(h.calls).toEqual([])
  })

  it('only same-origin JSON: another site, a form post, junk or a large body is refused before anything is asked', async () => {
    expect((await POST(req({ site: 'cross-site' }))).status).toBe(403)
    expect((await POST(req({ site: null, origin: 'https://evil.example' }))).status).toBe(403)
    expect((await POST(req({ type: 'application/x-www-form-urlencoded', body: 'tokens=x' }))).status).toBe(415)
    expect((await POST(req({ body: '{not json' }))).status).toBe(400)
    expect((await POST(req({ body: { tokens: 'one' } }))).status).toBe(400)
    expect((await POST(req({ body: 'x'.repeat(40_000) }))).status).toBe(413)
    expect(h.calls).toEqual([])
  })

  it('without Sec-Fetch-Site, the same origin is accepted', async () => {
    expect((await POST(req({ site: null, origin: 'http://drishti.test' }))).status).toBe(204)
  })

  it('a release that cannot be done is said plainly (the tokens then run out on their own)', async () => {
    h.answer = { ok: false, error: 'Could not open the video. Please try again.' }
    const res = await POST(req())
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
