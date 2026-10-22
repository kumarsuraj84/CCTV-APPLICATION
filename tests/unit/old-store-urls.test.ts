import { describe, expect, it } from 'vitest'
import { compile, match } from 'next/dist/compiled/path-to-regexp'
import nextConfig from '../../next.config'
import { pickLocationParam } from '@/lib/queries/location-param'

// T-1 (ruling T-1): "/stores" is now "/locations" and "/admin/stores" is now "/admin/locations". The old addresses (bookmarks, e-mailed
// links, the browser history) keep working through permanent redirects that keep the id and the query string. The rules are read from
// next.config.ts and applied the way Next.js applies them (path pattern, `has` query matching, query passed through).

type Rule = { source: string; destination: string; permanent?: boolean; has?: { type: string; key: string; value?: string }[] }
const ID = '3f2b8a52-6f0e-4c3a-9d41-0d7a4c5e9b11'

async function follow(url: string): Promise<{ status: number; to: string } | null> {
  const rules = (await nextConfig.redirects!()) as Rule[]
  const u = new URL(url, 'http://localhost')
  for (const rule of rules) {
    const m = match(rule.source)(u.pathname)
    if (!m) continue
    const params: Record<string, string> = { ...(m.params as Record<string, string>) }
    let ok = true
    for (const h of rule.has ?? []) {
      const got = u.searchParams.get(h.key)
      if (h.type !== 'query' || got === null) { ok = false; break }
      if (h.value !== undefined) {
        const r = new RegExp(`^${h.value}$`).exec(got)
        if (!r) { ok = false; break }
        Object.assign(params, r.groups ?? {})
      }
    }
    if (!ok) continue
    const dest = new URL(compile(rule.destination)(params), 'http://localhost')
    // Next.js passes the request's query on to the destination.
    u.searchParams.forEach((v, k) => { if (!dest.searchParams.has(k)) dest.searchParams.append(k, v) })
    return { status: rule.permanent ? 308 : 307, to: dest.pathname + dest.search }
  }
  return null
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

  it('no rule is temporary', async () => {
    const rules = (await nextConfig.redirects!()) as Rule[]
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.filter((r) => !r.permanent)).toEqual([])
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
