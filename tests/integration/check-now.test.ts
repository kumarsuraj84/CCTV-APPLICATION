import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requestCheckNow } from '@/lib/monitor/check-now'
import { adminClient, atAsset, atCamera, atLocation, cleanupOrg, createOrg, createSite, createUser, grant, ORG_SCOPE, READ_EVERYTHING, type TestUser } from '../setup/fixtures'

const state = async () => (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!

// P2-2 (brief item 5; INITIAL-AUDIT §4.10 item 7): "Check now" needs it.monitoring.operate for the organisation or for at least one
// whole location, asked as the person (capability_store_ids). The role does not matter any more (the interim canRunChecks is gone):
// an operator, an administrator or a viewer without the capability is refused, and anyone holding it may ask.
describe('check now', () => {
  let orgId: string
  let saved: Awaited<ReturnType<typeof state>>
  let store: string, camera: string, device: string
  let operateOrg: TestUser, operateStore: TestUser
  beforeAll(async () => {
    saved = await state()
    orgId = await createOrg()
    store = (await createSite(orgId, { code: 'CN', name: 'CN', host: '127.0.0.1', username: 'u' })).locationId
    camera = (await adminClient().from('cameras').insert({ org_id: orgId, location_id: store, channel: 1, name: 'c' }).select('id').single()).data!.id
    device = (await adminClient().from('assets').insert({ org_id: orgId, location_id: store, type: 'server', name: 'd', ip: '127.0.0.1' }).select('id').single()).data!.id
    operateOrg = await createUser(orgId, 'user')
    operateStore = await createUser(orgId, 'operator')
    await grant(orgId, operateOrg.id, 'it.monitoring.operate', ORG_SCOPE)
    await grant(orgId, operateStore.id, 'it.monitoring.operate', atLocation(store))
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
    await cleanupOrg(orgId)
  })
  const deps = (u: TestUser) => ({ admin: adminClient(), rls: u.client })
  const actor = (u: TestUser, role: 'user' | 'operator' | 'manager' | 'admin' | 'platform_owner' = 'user') => ({ id: u.id, orgId, role })
  const quiet = () => adminClient().from('worker_state').update({ last_heartbeat: null, run_started_at: null, run_finished_at: null, check_requested_at: null }).eq('id', 1)

  it('people without it.monitoring.operate covering a location are refused, whatever their role, and leave no trace', async () => {
    await quiet()
    const people: [TestUser, 'user' | 'operator' | 'manager' | 'admin' | 'platform_owner'][] = []
    for (const role of ['user', 'operator', 'manager', 'admin', 'platform_owner'] as const) people.push([await createUser(orgId, role), role])
    // A different capability, or the right one only for one asset or camera, is not enough.
    const readers = await createUser(orgId, 'operator')
    await grant(orgId, readers.id, [...READ_EVERYTHING, 'admin.inventory', 'admin.users'])
    const assetOnly = await createUser(orgId, 'operator')
    await grant(orgId, assetOnly.id, 'it.monitoring.operate', atAsset(device))
    const camOnly = await createUser(orgId, 'operator')
    await grant(orgId, camOnly.id, 'cctv.live', atCamera(camera))
    people.push([readers, 'operator'], [assetOnly, 'operator'], [camOnly, 'operator'])
    for (const [u, role] of people) {
      expect(await requestCheckNow(deps(u), actor(u, role)), role).toEqual({ ok: false, error: 'You are not allowed to start a check.' })
    }
    expect((await state()).check_requested_at).toBeNull()
    // (P2-5b: the fixture's recorder_save writes its own "recorder_created" row; no check-now row may exist.)
    expect((await adminClient().from('admin_audit_log').select('id').eq('org_id', orgId).neq('action', 'recorder_created')).data).toEqual([])
  })

  it('a revoked or expired grant no longer allows it', async () => {
    await quiet()
    const p = await createUser(orgId, 'operator')
    const [g] = await grant(orgId, p.id, 'it.monitoring.operate', atLocation(store))
    await adminClient().rpc('revoke_grant', { p_org: orgId, p_user: p.id, p_grant_ids: [g], p_reason: 'test' })
    expect((await requestCheckNow(deps(p), actor(p))).ok).toBe(false)
    const q = await createUser(orgId, 'operator')
    await grant(orgId, q.id, 'it.monitoring.operate', atLocation(store), { validFrom: '2020-01-01T00:00:00Z', validUntil: '2020-01-02T00:00:00Z' })
    expect((await requestCheckNow(deps(q), actor(q))).ok).toBe(false)
    expect((await state()).check_requested_at).toBeNull()
  })

  it('it.monitoring.operate for one location is enough (a viewer role too); the request and an audit entry with the capability are written', async () => {
    await quiet()
    const before = (await state()).check_requested_at
    const res = await requestCheckNow(deps(operateStore), actor(operateStore, 'operator'))
    expect(res.ok).toBe(true)
    const after = (await state()).check_requested_at
    expect(after).not.toBe(before)
    expect(Date.now() - new Date(after!).getTime()).toBeLessThan(10_000)
    const audit = await adminClient().from('admin_audit_log').select('action, actor_id, detail').eq('org_id', orgId).eq('actor_id', operateStore.id)
    expect(audit.data).toEqual([{ action: 'check_requested', actor_id: operateStore.id, detail: { capability: 'it.monitoring.operate' } }])
  })

  it('organisation-wide it.monitoring.operate is enough too', async () => {
    await quiet()
    const r = await requestCheckNow(deps(operateOrg), actor(operateOrg))
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('alreadyOnTheWay')
  })

  it('ignores a new request only while one is waiting, and only when the worker is alive', async () => {
    const asked = new Date(Date.now() - 20_000).toISOString()
    // Waiting: asked, and the last run began (and ended) before the request.
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 120_000).toISOString(), run_finished_at: new Date(Date.now() - 100_000).toISOString() })
      .eq('id', 1)
    const u = await createUser(orgId, 'user')
    await grant(orgId, u.id, 'it.monitoring.operate', ORG_SCOPE)
    expect(await requestCheckNow(deps(u), actor(u))).toEqual({ ok: true, alreadyOnTheWay: true })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(asked)
    // Nothing of this was recorded as a new request.
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', u.id)).data).toEqual([])
  })

  it('accepts a request while a run is only running, so that the runner repeats it afterwards', async () => {
    const asked = new Date(Date.now() - 20_000).toISOString()
    // Running: a run began after the earlier request and has not finished.
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 5_000).toISOString(), run_finished_at: null })
      .eq('id', 1)
    const u = await createUser(orgId, 'user')
    await grant(orgId, u.id, 'it.monitoring.operate', ORG_SCOPE)
    expect(await requestCheckNow(deps(u), actor(u))).toEqual({ ok: true })
    const s = await state()
    expect(new Date(s.check_requested_at!).getTime()).toBeGreaterThan(new Date(s.run_started_at!).getTime()) // the runner sees "asked after the run began"
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', u.id)).data).toEqual([{ action: 'check_requested' }])
    // Pressed again while that second request is waiting: ignored.
    expect(await requestCheckNow(deps(u), actor(u))).toEqual({ ok: true, alreadyOnTheWay: true })
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', u.id)).data).toHaveLength(1)
  })

  it('accepts a new request once the last run finished a while ago', async () => {
    const asked = new Date(Date.now() - 120_000).toISOString()
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: asked, run_started_at: new Date(Date.now() - 100_000).toISOString(), run_finished_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', 1)
    expect(await requestCheckNow(deps(operateOrg), actor(operateOrg))).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })

  it('refuses a request for 30 seconds after a run finished, by the clock it is given', async () => {
    const finished = new Date('2026-01-01T00:00:10.000Z')
    const row = { last_heartbeat: finished.toISOString(), check_requested_at: '2026-01-01T00:00:00.000Z', run_started_at: '2026-01-01T00:00:05.000Z', run_finished_at: finished.toISOString() }
    const u = await createUser(orgId, 'operator')
    await grant(orgId, u.id, 'it.monitoring.operate', atLocation(store))
    await adminClient().from('worker_state').update(row).eq('id', 1)
    const refused = await requestCheckNow(deps(u), actor(u, 'operator'), () => finished.getTime() + 10_000)
    expect(refused).toEqual({ ok: false, error: 'A check just finished. Try again in a moment.' })
    expect(new Date((await state()).check_requested_at!).toISOString()).toBe(row.check_requested_at) // nothing was written
    expect((await adminClient().from('admin_audit_log').select('action').eq('org_id', orgId).eq('actor_id', u.id)).data).toEqual([])
    // Just inside and just outside the limit.
    expect((await requestCheckNow(deps(u), actor(u, 'operator'), () => finished.getTime() + 29_999)).ok).toBe(false)
    expect((await requestCheckNow(deps(u), actor(u, 'operator'), () => finished.getTime() + 30_000)).ok).toBe(true)
  })

  it('does not apply the cooldown to a run that is still open', async () => {
    await adminClient()
      .from('worker_state')
      .update({ last_heartbeat: new Date().toISOString(), check_requested_at: new Date(Date.now() - 20_000).toISOString(), run_started_at: new Date(Date.now() - 2_000).toISOString(), run_finished_at: new Date(Date.now() - 3_000).toISOString() })
      .eq('id', 1)
    // The recorded finish belongs to an earlier run (it is before the start), so this run is open and not in cooldown.
    expect((await requestCheckNow(deps(operateOrg), actor(operateOrg))).ok).toBe(true)
  })

  it('records a new request when the worker is not running, even if an old one is still waiting', async () => {
    const asked = new Date(Date.now() - 3600_000).toISOString()
    await adminClient().from('worker_state').update({ last_heartbeat: new Date(Date.now() - 600_000).toISOString(), check_requested_at: asked, run_started_at: null, run_finished_at: null }).eq('id', 1)
    expect(await requestCheckNow(deps(operateOrg), actor(operateOrg))).toEqual({ ok: true })
    expect(new Date((await state()).check_requested_at!).getTime()).toBeGreaterThan(new Date(asked).getTime())
  })

  // Restored in P2-2 fix round 1 (it was dropped by mistake when this file moved to capabilities); now with a person holding
  // it.monitoring.operate for the organisation, through their own client.
  describe('check now is stamped by the database clock', () => {
    it('asks the database to stamp the request and never writes the time from the web server', async () => {
      await quiet()
      const real = adminClient()
      const calls: string[] = []
      const watched = new Proxy(real, {
        get(target, prop) {
          if (prop === 'rpc') return (name: string, ...rest: unknown[]) => { calls.push(`rpc:${name}`); return (target.rpc as (...a: unknown[]) => unknown)(name, ...rest) }
          if (prop === 'from') {
            return (table: string) => {
              const builder = target.from(table as 'worker_state')
              return new Proxy(builder, {
                get(b, p) {
                  const v = Reflect.get(b, p)
                  if (p === 'update' && table === 'worker_state') calls.push('update:worker_state')
                  return typeof v === 'function' ? v.bind(b) : v
                },
              })
            }
          }
          const v = Reflect.get(target, prop)
          return typeof v === 'function' ? v.bind(target) : v
        },
      }) as typeof real
      // The web server's clock is an hour out; the stamp must not depend on it.
      const res = await requestCheckNow({ ...deps(operateOrg), admin: watched }, actor(operateOrg), () => Date.now() - 3600_000)
      expect(res.ok).toBe(true)
      expect(calls).toContain('rpc:monitor_request_check')
      expect(calls).not.toContain('update:worker_state')
      expect(Math.abs(Date.now() - new Date((await state()).check_requested_at!).getTime())).toBeLessThan(10_000)
    })
  })
})
