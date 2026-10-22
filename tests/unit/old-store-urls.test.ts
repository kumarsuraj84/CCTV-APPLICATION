import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
import nextConfig from '../../next.config'
import { pickLocationParam } from '@/lib/queries/location-param'
import { REDIRECT_CSP } from '@/lib/web/csp'

// T-1 (ruling T-1): "/stores" is now "/locations" and "/admin/stores" is now "/admin/locations". The old addresses (bookmarks, e-mailed
// links, the browser history) keep working through permanent redirects that keep the id and the query string.
// P3-1: the redirects moved from next.config.ts into proxy.ts (lib/web/legacy-redirects.ts), because Next.js answers a next.config
// redirect with no security headers at all (seen on the built server). The same claims are checked against the real proxy now; the
// answer also carries the Content Security Policy.

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))
const { proxy } = await import('@/proxy')
const ID = '3f2b8a52-6f0e-4c3a-9d41-0d7a4c5e9b11'

async function follow(url: string): Promise<{ status: number; to: string } | null> {
  const res = await proxy(new NextRequest(new URL(url, 'http://localhost')))
  const location = res.headers.get('location')
  // Not an old address: the proxy goes on (or, signed out, sends to sign in, which is not one of these redirects).
  if (res.status !== 308 || !location) return null
  expect(res.headers.get('content-security-policy')).toBe(REDIRECT_CSP)
  const dest = new URL(location, 'http://localhost')
  return { status: res.status, to: dest.pathname + dest.search }
}

describe('the old store addresses redirect permanently', () => {
  it('/stores goes to /locations, keeping the query', async () => {
    expect(await follow('/stores')).toEqual({ status: 308, to: '/locations' })
    expect(await follow('/stores?q=Patna&x=1')).toEqual({ status: 308, to: '/locations?q=Patna&x=1' })
  })

  it('/stores/<id> goes to /locations/<id>, keeping the id and the query', async () => {
    expect(await follow(`/stores/${ID}`)).toEqual({ status: 308, to: `/locations/${ID}` })
    expect(await follow(`/stores/${ID}?tab=cameras`)).toEqual({ status: 308, to: `/locations/${ID}?tab=cameras` })
  })

  it('/admin/stores goes to /admin/locations, keeping the query', async () => {
    expect(await follow('/admin/stores')).toEqual({ status: 308, to: '/admin/locations' })
    expect(await follow('/admin/stores?q=x')).toEqual({ status: 308, to: '/admin/locations?q=x' })
  })

  it('the old edit link /admin/stores?edit=<id> opens that location on its administration page', async () => {
    const r = await follow(`/admin/stores?edit=${ID}`)
    expect(r?.status).toBe(308)
    expect(r?.to.startsWith(`/admin/locations/${ID}`)).toBe(true)
    // An edit value that is not an id is not trusted into a path.
    expect((await follow('/admin/stores?edit=../../x'))?.to.startsWith('/admin/locations')).toBe(true)
    expect((await follow('/admin/stores?edit=../../x'))?.to.startsWith('/admin/locations/..')).toBe(false)
  })

  it('the new addresses and the Wi-Fi inventory are not redirected', async () => {
    for (const url of ['/locations', `/locations/${ID}`, '/locations/wifi', '/admin/locations', `/admin/locations/${ID}`, '/live?location=' + ID]) expect(await follow(url), url).toBeNull()
  })

  it('no rule is temporary, and none is left in next.config (where the answer would carry no security headers)', async () => {
    for (const url of ['/stores', `/stores/${ID}`, '/admin/stores', `/admin/stores?edit=${ID}`]) expect((await follow(url))?.status, url).toBe(308)
    expect(nextConfig.redirects).toBeUndefined()
  })
})

describe('?store=<id> still works on Live, Playback and the group page; links say ?location=<id>', () => {
  it('accepts both names and prefers the new one', () => {
    expect(pickLocationParam({ location: 'a', store: 'b' })).toBe('a')
    expect(pickLocationParam({ store: 'b' })).toBe('b')
    expect(pickLocationParam({ location: 'a' })).toBe('a')
    expect(pickLocationParam({})).toBe('')
    expect(pickLocationParam({ location: ['x', 'y'] })).toBe('x')
    expect(pickLocationParam({ location: '', store: 'b' })).toBe('b')
  })
})
