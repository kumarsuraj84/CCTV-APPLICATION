import { beforeEach, describe, expect, it, vi } from 'vitest'

// P2-5c-2: the Server Actions of the import, "find cameras for all" and the status poll check the caller FIRST (requireAdministration:
// signed in, active, password chosen, administrative role, admin.inventory for the organisation) — before any client is made or any
// service runs — and return plain results (never throw to the client for a refusal of the service).

const m = vi.hoisted(() => ({ asked: [] as string[], refuse: false, clients: 0, calls: [] as string[], scheduled: 0 }))

vi.mock('@/lib/auth/profile', () => ({
  requireAdministration: async (cap: string) => {
    m.asked.push(cap)
    if (m.refuse) throw new Error('REDIRECT:/home')
    return { id: 'u1', org_id: 'o1', role: 'admin' }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/server', () => ({ after: (fn: () => unknown) => { m.scheduled++; void fn } }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => (m.clients++, { tag: 'admin' }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => (m.clients++, { tag: 'rls' }) }))
vi.mock('@/lib/streams/local-go2rtc', () => ({ localGo2rtc: () => ({ tag: 'go2rtc' }) }))
// P2-6 (D-11): the counts are shared (lib/rate-limit-shared.ts); these tests are about the gates, so nobody is ever over a limit.
vi.mock('@/lib/rate-limit-shared', async (orig) => ({ ...(await orig<typeof import('@/lib/rate-limit-shared')>()), refusalFor: async () => null, adminRefusalFor: async () => null }))
vi.mock('@/lib/import/locations-import', () => ({
  checkLocationImport: async (_c: unknown, _a: unknown, text: string, o: { skipBadRows: boolean; keepNames: boolean }) => (m.calls.push(`check:${text}:${o.skipBadRows}:${o.keepNames}`), { ok: false, error: 'x' }),
  applyLocationImport: async (_c: unknown, _a: unknown, text: string, o: { skipBadRows: boolean; keepNames: boolean; archive: boolean; fingerprint: string }) =>
    (m.calls.push(`apply:${text}:${o.skipBadRows}:${o.keepNames}:${o.archive}:${o.fingerprint}`), { ok: false, error: 'x' }),
}))
vi.mock('@/lib/inventory/discover-all', () => ({
  startDiscoverAll: async (_c: unknown, _a: unknown, d: { schedule: (w: () => Promise<unknown>) => void }) => (d.schedule(async () => {}), m.calls.push('start'), { ok: true, runId: 'r1', total: 3 }),
  discoverAllStatus: async (_c: unknown, _a: unknown, id: string) => (m.calls.push(`status:${id}`), { ok: false, error: 'x' }),
  stopDiscoverAll: async (_c: unknown, _a: unknown, id: string) => (m.calls.push(`stop:${id}`), { ok: true }),
}))

beforeEach(() => {
  m.asked = []
  m.refuse = false
  m.clients = 0
  m.calls = []
  m.scheduled = 0
})

const file = (text: string) => {
  const fd = new FormData()
  fd.set('file', new File([text], 'locations.csv', { type: 'text/csv' }))
  return fd
}

describe('P2-5c-2 actions: the caller is checked first', () => {
  it('every action asks for admin.inventory before any client is made, and stops there when refused', async () => {
    const imp = await import('@/lib/actions/admin/import-locations')
    const all = await import('@/lib/actions/admin/discover-all')
    const actions: (() => Promise<unknown>)[] = [
      () => imp.checkLocationImportAction(file('code\nA1\n')),
      () => imp.applyLocationImportAction(file('code\nA1\n')),
      () => all.startDiscoverAllAction(),
      () => all.discoverAllStatusAction('r1'),
      () => all.stopDiscoverAllAction('r1'), // review B-M10
    ]
    for (const run of actions) {
      m.refuse = true
      m.asked = []
      m.clients = 0
      await expect(run()).rejects.toThrow('REDIRECT:/home')
      expect(m.asked).toEqual(['admin.inventory'])
      expect(m.clients).toBe(0)
    }
    expect(m.calls).toEqual([])
  })

  it('the import actions pass the file text and the choices through and return plain results', async () => {
    const imp = await import('@/lib/actions/admin/import-locations')
    const fd = file('code\nA1\n')
    fd.set('skip_bad_rows', 'on')
    fd.set('keep_names', 'on') // review B-M1
    expect(await imp.checkLocationImportAction(fd)).toEqual({ ok: false, error: 'x' })
    fd.set('archive', 'on')
    fd.set('fingerprint', 'f'.repeat(64))
    expect(await imp.applyLocationImportAction(fd)).toEqual({ ok: false, error: 'x' })
    expect(m.calls).toEqual(['check:code\nA1\n:true:true', `apply:code\nA1\n:true:true:true:${'f'.repeat(64)}`])
  })

  it('without a file, or with a file over 5 MB, the import answers plainly and calls nothing', async () => {
    const imp = await import('@/lib/actions/admin/import-locations')
    expect(await imp.checkLocationImportAction(new FormData())).toEqual({ ok: false, error: 'Choose a CSV file smaller than 5 MB.' })
    expect(await imp.applyLocationImportAction(file('x'.repeat(5 * 1024 * 1024 + 1)))).toEqual({ ok: false, error: 'Choose a CSV file smaller than 5 MB.' })
    expect(m.calls).toEqual([])
  })

  it('"find cameras for all" hands the run to after() so the answer comes back at once', async () => {
    const all = await import('@/lib/actions/admin/discover-all')
    expect(await all.startDiscoverAllAction()).toEqual({ ok: true, runId: 'r1', total: 3 })
    expect(m.scheduled).toBe(1)
    expect(await all.discoverAllStatusAction('r1')).toEqual({ ok: false, error: 'x' })
  })
})
