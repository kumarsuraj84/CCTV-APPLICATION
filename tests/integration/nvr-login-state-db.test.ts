import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createCamera, createCluster, createOrg, createRegion, createSite, createUser, grant, type TestUser } from '../setup/fixtures'
import { serviceClient } from '../setup/service-keys'

// Final fix X (release 1 review C I-1, I-2, I-4; rulings NB-1..NB-4): the shared NVR login state in the database. The same scenarios as
// tests/unit/nvr-login-policy.test.ts (lib/nvr/login-policy.ts), against nvr_login_gate / nvr_login_report; time passes through the
// test-only nvr_login_state_age_test (test organisations only).

const admin = () => adminClient()
type Gate = { recorder_id: string; decision: string; version: string | null; until: string | null; baselined: boolean; level: number; claimed: boolean }
const worker = () => serviceClient('monitor_worker')
const media = () => serviceClient('media_service')

async function gate(id: string, o: { claim?: boolean; fresh?: number | null; path?: string; client?: ReturnType<typeof worker> } = {}): Promise<Gate> {
  const { data, error } = await (o.client ?? worker()).rpc('nvr_login_gate' as never, { p_recorders: [id], p_path: o.path ?? 'monitoring', p_claim: o.claim ?? true, ...(o.fresh ? { p_fresh_sec: o.fresh } : {}) } as never)
  if (error) throw new Error(error.message)
  return (data as unknown as Gate[])[0]
}
async function report(id: string, version: string, outcome: 'ok' | 'refused' | 'unknown', client = worker()) {
  const { data, error } = await client.rpc('nvr_login_report' as never, { p_recorder: id, p_version: version, p_outcome: outcome, p_path: 'monitoring' } as never)
  if (error) throw new Error(error.message)
  return (data as unknown as { applied: boolean; outcome: string | null; level: number; until: string | null }[])[0]
}
const age = async (id: string, seconds: number) => {
  const { error } = await admin().rpc('nvr_login_state_age_test' as never, { p_recorder: id, p_seconds: seconds } as never)
  if (error) throw new Error(error.message)
}
const minutesLeft = (until: string | null) => Math.round((Date.parse(until ?? '') - Date.now()) / 60_000)

describe('the shared NVR login state (nvr_login_gate / nvr_login_report)', () => {
  let orgId: string
  let actor: TestUser
  let viewer: TestUser
  const sites: string[] = []
  const site = async (o: { secret?: string } = { secret: 'pw-1' }) => {
    const s = await createSite(orgId, { host: '127.0.0.1', secret: o.secret, cameras: 1 })
    sites.push(s.recorderId)
    return s
  }

  beforeAll(async () => {
    orgId = await createOrg()
    actor = await createUser(orgId, 'admin')
    await grant(orgId, actor.id, 'admin.inventory')
    viewer = await createUser(orgId, 'user')
  })
  afterAll(() => cleanupOrg(orgId))

  it('a login never proven: exactly one attempt; the others (worker or web) wait for its answer', async () => {
    const { recorderId: r } = await site()
    const first = await gate(r)
    expect(first).toMatchObject({ decision: 'probe', claimed: true, baselined: false, level: 0 })
    expect(first.version).toMatch(/^[0-9a-f]{32}$/)
    expect(await gate(r, { client: media(), path: 'live' })).toMatchObject({ decision: 'wait', claimed: false })
    expect((await report(r, first.version!, 'ok')).applied).toBe(true)
    expect(await gate(r, { client: media(), path: 'live' })).toMatchObject({ decision: 'go', baselined: true })
  })

  it('a refused login: 15 minutes for everyone, then one attempt, then 30 minutes; it survives any process (it is in the database)', async () => {
    const { recorderId: r } = await site()
    const g = await gate(r)
    const rep = await report(r, g.version!, 'refused')
    expect(rep).toMatchObject({ applied: true, outcome: 'refused', level: 1 })
    expect(minutesLeft(rep.until)).toBe(15)
    expect(await gate(r, { client: media(), path: 'discovery' })).toMatchObject({ decision: 'refused', level: 1 })
    await age(r, 15 * 60)
    expect(await gate(r)).toMatchObject({ decision: 'probe', claimed: true })
    expect(await gate(r, { client: media(), path: 'live' })).toMatchObject({ decision: 'wait' })
    const second = await report(r, g.version!, 'refused')
    expect(second.level).toBe(2)
    expect(minutesLeft(second.until)).toBe(30)
  })

  it('the window doubles up to 6 hours', async () => {
    const { recorderId: r } = await site()
    const v = (await gate(r)).version!
    const minutes: number[] = []
    for (let i = 0; i < 7; i++) {
      const rep = await report(r, v, 'refused')
      minutes.push(minutesLeft(rep.until))
      await age(r, 6 * 3600)
      // Only two refusals stay within any 30 minutes here, so the pause never starts; the next attempt is due.
      await gate(r)
    }
    expect(minutes).toEqual([15, 30, 60, 120, 240, 360, 360])
  })

  it('a new saved password starts again at once; re-saving the same password does not', async () => {
    const { recorderId: r } = await site()
    const g = await gate(r)
    await report(r, g.version!, 'refused')
    await admin().rpc('recorder_store_credential', { p_recorder: r, p_secret: 'pw-1' })
    expect(await gate(r)).toMatchObject({ decision: 'refused', version: g.version })
    await admin().rpc('recorder_store_credential', { p_recorder: r, p_secret: 'pw-2' })
    const after = await gate(r)
    expect(after).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
    expect(after.version).not.toBe(g.version)
    // A late report about the old password changes nothing.
    expect((await report(r, g.version!, 'refused')).applied).toBe(false)
  })

  it('three refused logins of one saved login within 30 minutes pause the NVR; a new saved password lifts the pause (round 2, NB-10)', async () => {
    const { recorderId: r } = await site()
    const web = serviceClient('app_web')
    for (let i = 0; i < 3; i++) {
      const g = await gate(r)
      await report(r, g.version!, 'refused')
      await web.rpc('nvr_login_try_again' as never, { p_org: orgId, p_recorder: r, p_actor: actor.id } as never)
    }
    const paused = await gate(r)
    expect(paused.decision).toBe('paused')
    expect(minutesLeft(paused.until)).toBe(30)
    await admin().rpc('recorder_store_credential', { p_recorder: r, p_secret: 'corrected-1' })
    const fresh = await gate(r)
    expect(fresh).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
    const again = await report(r, fresh.version!, 'refused')
    expect(minutesLeft(again.until)).toBe(15)
  })

  it('round 2 (review M-9): ten callers asking at the same moment: exactly one holds the attempt', async () => {
    const { recorderId: r } = await site()
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => gate(r, { client: i % 2 ? media() : worker(), path: i % 2 ? 'live' : 'monitoring' })))
    expect(answers.filter((a) => a.claimed)).toHaveLength(1)
    expect(answers.filter((a) => a.decision === 'wait')).toHaveLength(9)
  })

  it('an NVR without a saved password is never tried', async () => {
    const { recorderId: r } = await site({})
    expect(await gate(r)).toMatchObject({ decision: 'no_password', version: null, claimed: false })
  })

  it('"unknown" (a timeout) gives the attempt back; an attempt nobody reports expires after a minute', async () => {
    const { recorderId: r } = await site()
    const g = await gate(r)
    await report(r, g.version!, 'unknown')
    expect(await gate(r)).toMatchObject({ decision: 'probe', claimed: true })
    await age(r, 61)
    expect(await gate(r)).toMatchObject({ decision: 'probe', claimed: true })
  })

  it('a proven login older than the caller\'s limit needs a new proof (live: 10 minutes)', async () => {
    const { recorderId: r } = await site()
    await report(r, (await gate(r)).version!, 'ok')
    await age(r, 11 * 60)
    expect(await gate(r, { client: media(), path: 'live', fresh: 600 })).toMatchObject({ decision: 'probe', claimed: true })
    expect(await gate(r, { path: 'monitoring' })).toMatchObject({ decision: 'go' })
  })

  it('"Try again": administrators only, audited; it ends the window but not the 3-in-30-minutes pause', async () => {
    const { recorderId: r } = await site()
    await report(r, (await gate(r)).version!, 'refused')
    const web = serviceClient('app_web')
    const refused = await web.rpc('nvr_login_try_again' as never, { p_org: orgId, p_recorder: r, p_actor: viewer.id } as never)
    expect(refused.error?.code).toBe('42501')
    const done = await web.rpc('nvr_login_try_again' as never, { p_org: orgId, p_recorder: r, p_actor: actor.id } as never)
    expect(done.error).toBeNull()
    expect(await gate(r)).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
    const audit = await admin().from('admin_audit_log').select('action, actor_id').eq('org_id', orgId).eq('entity_id', r).eq('action', 'nvr_login_try_again')
    expect(audit.data).toEqual([{ action: 'nvr_login_try_again', actor_id: actor.id }])
  })

  it('nobody writes the state directly; the web app reads it; the gateway may not call the gate', async () => {
    const { recorderId: r } = await site()
    await gate(r)
    for (const role of ['app_web', 'media_service', 'monitor_worker'] as const) {
      const c = serviceClient(role)
      expect((await c.from('nvr_login_state' as never).update({ level: 9 } as never).eq('recorder_id', r)).error?.code, role).toBe('42501')
    }
    expect((await serviceClient('app_web').from('nvr_login_state' as never).select('recorder_id').eq('recorder_id', r)).data).toEqual([{ recorder_id: r }])
    expect((await serviceClient('video_gateway').rpc('nvr_login_gate' as never, { p_recorders: [r], p_path: 'gateway' } as never)).error?.code).toBe('42501')
    expect((await serviceClient('app_web').rpc('nvr_login_gate' as never, { p_recorders: [r], p_path: 'live' } as never)).error?.code).toBe('42501')
    const { data } = await admin().rpc('privilege_violations')
    expect(data).toEqual([])
  })

  it('the gateway: refused while the login stands refused (also after the window, until a probe proves it); a go2rtc refusal counts', async () => {
    const s = await site()
    const r = s.recorderId
    await grant(orgId, actor.id, 'cctv.live')
    const made = await admin().rpc('media_session_create', { p_org: orgId, p_user: actor.id, p_kind: 'live', p_cameras: s.cameraIds, p_streams: [`cam_${s.cameraIds[0]}_sub`] })
    const sid = (made.data as { sid: string }[])[0].sid
    const gw = serviceClient('video_gateway')
    const opened = await gw.rpc('media_session_open', { p_sid: sid, p_user: actor.id, p_camera: s.cameraIds[0], p_kind: 'live', p_stream: `cam_${s.cameraIds[0]}_sub` })
    expect((opened.data as { ok: boolean }[])[0].ok).toBe(true)
    const check = async () => ((await gw.rpc('media_session_login_check' as never, { p_sid: sid } as never)).data as unknown as { decision: string }[])[0].decision
    expect(await check()).toBe('go') // never tried: the web server's probe comes first, the gateway does not judge it
    expect((await gw.rpc('media_session_login_refused' as never, { p_sid: sid } as never)).data).toBe(true)
    expect(await check()).toBe('refused')
    expect(await gate(r)).toMatchObject({ decision: 'refused', level: 1 })
    await age(r, 16 * 60)
    expect(await check()).toBe('refused')
    const probe = await gate(r, { client: media(), path: 'live', fresh: 600 })
    expect(probe).toMatchObject({ decision: 'probe', claimed: true })
    await report(r, probe.version!, 'ok', media())
    expect(await check()).toBe('go')
    expect(((await gw.rpc('media_session_login_check' as never, { p_sid: randomUUID() } as never)).data as unknown as { decision: string }[])[0].decision).toBe('no_session')
  })

  it('round 2 (review M-8; NB-12): two identical unexplained go2rtc failures without video in between count as a refused login', async () => {
    const s = await site()
    await grant(orgId, actor.id, 'cctv.live')
    const made = await admin().rpc('media_session_create', { p_org: orgId, p_user: actor.id, p_kind: 'live', p_cameras: s.cameraIds, p_streams: [`cam_${s.cameraIds[0]}_sub`] })
    const sid = (made.data as { sid: string }[])[0].sid
    const gw = serviceClient('video_gateway')
    await gw.rpc('media_session_open', { p_sid: sid, p_user: actor.id, p_camera: s.cameraIds[0], p_kind: 'live', p_stream: `cam_${s.cameraIds[0]}_sub` })
    const say = async (kind: string, hash?: string) =>
      (await gw.rpc('media_session_login_report' as never, { p_sid: sid, p_kind: kind, ...(hash ? { p_hash: hash } : {}) } as never)).data as unknown as string
    const h1 = 'a'.repeat(64)
    const h2 = 'b'.repeat(64)
    expect(await say('unexplained', h1)).toBe('counted')
    expect(await say('video')).toBe('cleared') // a picture played: the failure is explained by something else
    expect(await say('unexplained', h1)).toBe('counted')
    expect(await say('unexplained', h2)).toBe('counted') // a different failure starts again
    expect(await say('unexplained', h2)).toBe('refused')
    expect(await gate(s.recorderId)).toMatchObject({ decision: 'refused', level: 1 })
    const st = await admin().from('nvr_login_state' as never).select('last_refused_path').eq('recorder_id', s.recorderId).single()
    expect(st.data).toEqual({ last_refused_path: 'gateway' })
    expect((await gw.rpc('media_session_login_report' as never, { p_sid: sid, p_kind: 'other' } as never)).error?.code).toBe('22023')
  })

  it('the rollout: monitoring switched on or off for a region, a cluster, a location or the organisation, each NVR audited', async () => {
    const region = await createRegion(orgId)
    const cluster = await createCluster(orgId, region)
    const a = await createSite(orgId, { clusterId: cluster, cameras: 0 })
    const b = await createSite(orgId, { clusterId: cluster, cameras: 0 })
    const c = await createSite(orgId, { cameras: 0 })
    await createCamera(orgId, { locationId: c.locationId, recorderId: c.recorderId, channel: 1 })
    const web = serviceClient('app_web')
    const bulk = (scope: string, id: string | null, enabled: boolean, who = actor.id) =>
      web.rpc('recorder_set_monitoring_bulk' as never, { p_org: orgId, p_scope: scope, p_scope_id: id, p_enabled: enabled, p_reason: 'Pilot rollout', p_actor: who } as never)
    expect((await bulk('region', region, false, viewer.id)).error?.code).toBe('42501')
    expect((await bulk('region', region, false)).data).toEqual({ matched: 2, changed: 2 })
    const on = async (id: string) => (await admin().from('recorders').select('monitoring_enabled').eq('id', id).single()).data?.monitoring_enabled
    expect([await on(a.recorderId), await on(b.recorderId), await on(c.recorderId)]).toEqual([false, false, true])
    expect((await bulk('cluster', cluster, false)).data).toEqual({ matched: 2, changed: 0 })
    expect((await bulk('location', a.locationId, true)).data).toEqual({ matched: 1, changed: 1 })
    expect(await on(a.recorderId)).toBe(true)
    const all = (await bulk('organization', null, false)).data as unknown as { matched: number; changed: number }
    expect(all.changed).toBeGreaterThanOrEqual(2)
    expect(await on(c.recorderId)).toBe(false)
    expect((await bulk('location', randomUUID(), true)).error?.code).toBe('P0002')
    const audit = await admin().from('admin_audit_log').select('action').eq('org_id', orgId).in('action', ['recorders_monitoring_disabled', 'recorder_monitoring_disabled'])
    expect((audit.data ?? []).filter((x) => x.action === 'recorders_monitoring_disabled').length).toBe(3)
    expect((audit.data ?? []).filter((x) => x.action === 'recorder_monitoring_disabled').length).toBeGreaterThanOrEqual(4)
    // A switched-off NVR keeps no stale state for the gate either: it is simply not asked (recorder_credential_read refuses it).
    void sites
  })
})
