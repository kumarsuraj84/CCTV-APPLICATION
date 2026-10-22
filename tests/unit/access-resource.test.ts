import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cameraFor, camerasFor, coversSomeLocation, locationFor, assetFor, MSG_ACCESS_CHECK_FAILED } from '@/lib/auth/resource'

// P2-2: every decision about one camera, location or asset is made by the database's scope-specific functions through the person's own
// client. These tests pin which function is asked, with what, and that a failed check never counts as allowed.

type Call = { fn: string; args: Record<string, unknown> }
function fakeRls(answer: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code: string } | null }) {
  const calls: Call[] = []
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      const r = answer(fn, args)
      const p = Promise.resolve(r) as Promise<typeof r> & { limit: (n: number) => Promise<typeof r> }
      p.limit = () => Promise.resolve(r)
      return p
    },
  }
  return { client: client as never, calls }
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('camerasFor', () => {
  it('asks cameras_with_capability with the capability and the ids, lower-cased and without repeats or non-ids', async () => {
    const f = fakeRls((_fn, a) => ({ data: (a.p_ids as string[]).slice(0, 1), error: null }))
    const r = await camerasFor(f.client, 'cctv.live', [id(1).toUpperCase(), id(1), 'nope', id(2)])
    expect(r).toEqual({ ok: true, ids: [id(1)] })
    expect(f.calls).toEqual([{ fn: 'cameras_with_capability', args: { p_cap: 'cctv.live', p_ids: [id(1), id(2)] } }])
  })

  it('asks nothing for an empty list and answers with nothing', async () => {
    const f = fakeRls(() => ({ data: [], error: null }))
    expect(await camerasFor(f.client, 'cctv.playback', [])).toEqual({ ok: true, ids: [] })
    expect(f.calls).toEqual([])
  })

  it('asks in pieces of at most 1000 ids (the most rows one answer carries) and keeps the order asked for', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => id(i))
    const f = fakeRls((_fn, a) => ({ data: [...(a.p_ids as string[])].reverse(), error: null }))
    const r = await camerasFor(f.client, 'cctv.live', ids)
    expect(f.calls.map((c) => (c.args.p_ids as string[]).length)).toEqual([1000, 1000, 500])
    expect(r.ok && r.ids).toEqual(ids)
  })

  it('a failed check is a plain failure, never "allowed"', async () => {
    const f = fakeRls(() => ({ data: null, error: { code: '57014' } }))
    expect(await camerasFor(f.client, 'cctv.live', [id(1)])).toEqual({ ok: false, error: MSG_ACCESS_CHECK_FAILED })
  })
})

describe('cameraFor, locationFor, assetFor', () => {
  it('use has_capability_for with the right kind', async () => {
    const f = fakeRls(() => ({ data: true, error: null }))
    expect(await cameraFor(f.client, 'cctv.export', id(1))).toEqual({ ok: true, allowed: true })
    expect(await locationFor(f.client, 'admin.inventory', id(2))).toEqual({ ok: true, allowed: true })
    expect(await assetFor(f.client, 'it.monitoring.view', id(3))).toEqual({ ok: true, allowed: true })
    expect(f.calls).toEqual([
      { fn: 'has_capability_for', args: { p_cap: 'cctv.export', p_kind: 'camera', p_id: id(1) } },
      { fn: 'has_capability_for', args: { p_cap: 'admin.inventory', p_kind: 'location', p_id: id(2) } },
      { fn: 'has_capability_for', args: { p_cap: 'it.monitoring.view', p_kind: 'asset', p_id: id(3) } },
    ])
  })

  it('anything but true is "not allowed"; a malformed id is "not allowed" without asking', async () => {
    const f = fakeRls(() => ({ data: 'true', error: null }))
    expect(await cameraFor(f.client, 'cctv.live', id(1))).toEqual({ ok: true, allowed: false })
    expect(await cameraFor(f.client, 'cctv.live', 'x; drop')).toEqual({ ok: true, allowed: false })
    expect(f.calls).toHaveLength(1)
  })

  it('a failed check is a plain failure', async () => {
    const f = fakeRls(() => ({ data: null, error: { code: 'XX000' } }))
    expect(await locationFor(f.client, 'admin.inventory', id(1))).toEqual({ ok: false, error: MSG_ACCESS_CHECK_FAILED })
  })
})

describe('coversSomeLocation', () => {
  it('asks capability_store_ids (whole locations, or the organisation) and is true when one comes back', async () => {
    const yes = fakeRls(() => ({ data: [id(9)], error: null }))
    expect(await coversSomeLocation(yes.client, 'it.monitoring.operate')).toEqual({ ok: true, allowed: true })
    expect(yes.calls).toEqual([{ fn: 'capability_store_ids', args: { p_cap: 'it.monitoring.operate' } }])
    const no = fakeRls(() => ({ data: [], error: null }))
    expect(await coversSomeLocation(no.client, 'it.monitoring.operate')).toEqual({ ok: true, allowed: false })
  })
})

describe('the module never uses the any-scope or the reporting functions', () => {
  it('has no call of has_capability(…), report_effective_* or access_session_capabilities', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/auth/resource.ts', 'utf8')
    expect(src).not.toMatch(/['"]has_capability['"]/)
    expect(src).not.toMatch(/report_effective|access_session_capabilities|access_effective/)
  })
})
