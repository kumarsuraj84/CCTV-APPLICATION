import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ADMINISTRATOR_SET, adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, cleanupOrg, createCamera, createCluster, createLocation, createOrg,
  createRecorder, createRegion, createUser, grant, mapCamera, ORG_SCOPE, type GrantScope, type TestUser,
} from '../setup/fixtures'

// P2-4 (WP-2.2, decision D-3, directive AC-14): the media session registry in the database. Every open video connection is a row; the
// gateway asks media_session_open when a socket arrives and media_sessions_still_valid for all open sockets every 15 s. These tests
// prove the SQL on the local stack through PostgREST with the service role (the only caller), and that every access change made by
// the screens marks the affected sessions at once (the deferred trigger on profiles), leaving everybody else's sessions alone.

const admin = () => adminClient()

type Open = { ok: boolean; reason: string | null; kind: string | null; stream: string | null; expires_at: string | null }

describe('media session registry (P2-4)', () => {
  let orgId: string, otherOrg: string
  let region: string, c1: string, c2: string, L1: string, L2: string, Lx: string
  let R1: string, R2: string, R3: string
  let cam1: string, cam2: string, cam3: string, cam4: string, foreignCam: string
  let actor: TestUser
  const people = new Map<string, TestUser>()
  const person = (name: string) => people.get(name)!

  async function create(u: TestUser, kind: string, cameras: string[], o: { streams?: (string | null)[]; connectSec?: number; maxSec?: number; org?: string } = {}) {
    const { data, error } = await admin().rpc('media_session_create', {
      p_org: o.org ?? orgId, p_user: u.id, p_kind: kind, p_cameras: cameras,
      p_streams: (o.streams ?? cameras.map((c) => (kind === 'live' ? `cam_${c}_sub` : kind === 'playback' ? `pb_${c}_1800000000` : null))) as string[],
      ...(o.connectSec ? { p_connect_sec: o.connectSec } : {}), ...(o.maxSec ? { p_max_sec: o.maxSec } : {}),
    })
    if (error) throw new Error(`media_session_create: ${error.message}`)
    return (data ?? []) as { camera_id: string; sid: string }[]
  }
  const live = async (u: TestUser, camera: string) => {
    const rows = await create(u, 'live', [camera])
    if (rows.length !== 1) throw new Error('no live session was made')
    return rows[0].sid
  }
  async function open(sid: string, u: TestUser, camera: string, kind = 'live', stream = `cam_${camera}_sub`): Promise<Open> {
    const { data, error } = await admin().rpc('media_session_open', { p_sid: sid, p_user: u.id, p_camera: camera, p_kind: kind, p_stream: stream })
    if (error) throw new Error(`media_session_open: ${error.message}`)
    return (Array.isArray(data) ? data[0] : data) as Open
  }
  async function stillValid(sids: string[]) {
    const { data, error } = await admin().rpc('media_sessions_still_valid', { p_sids: sids })
    if (error) throw new Error(`media_sessions_still_valid: ${error.message}`)
    return new Map(((data ?? []) as { sid: string; reason: string }[]).map((r) => [r.sid, r.reason]))
  }
  async function row(sid: string) {
    const { data, error } = await admin().from('media_sessions').select('*').eq('id', sid).single()
    if (error || !data) throw new Error(`read session: ${error?.message}`)
    return data
  }
  /** A live session that the gateway has opened (the usual state of a watched camera). */
  async function watching(u: TestUser, camera: string) {
    const sid = await live(u, camera)
    expect((await open(sid, u, camera)).ok).toBe(true)
    return sid
  }

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    region = await createRegion(orgId)
    c1 = await createCluster(orgId, region)
    c2 = await createCluster(orgId, region)
    L1 = await createLocation(orgId, { clusterId: c1 })
    L2 = await createLocation(orgId, { clusterId: null })
    Lx = await createLocation(otherOrg)
    R1 = await createRecorder(orgId, L1, { host: '10.77.1.1' })
    R2 = await createRecorder(orgId, L1, { host: '10.77.1.2' })
    R3 = await createRecorder(orgId, L2, { host: '10.77.2.1' })
    cam1 = await createCamera(orgId, { locationId: L1, recorderId: R1, channel: 1 })
    cam2 = await createCamera(orgId, { locationId: L1, recorderId: R1, channel: 2 })
    cam3 = await createCamera(orgId, { locationId: L1, recorderId: R2, channel: 1 })
    cam4 = await createCamera(orgId, { locationId: L2, recorderId: R3, channel: 1 })
    foreignCam = await createCamera(otherOrg, { locationId: Lx, recorderId: await createRecorder(otherOrg, Lx, { host: '10.77.9.1' }), channel: 1 })
    actor = await createUser(orgId, 'platform_owner')
    await grant(orgId, actor.id, ADMINISTRATOR_SET)
    const matrix: [string, string | readonly string[], GrantScope[], 'user' | 'admin'][] = [
      ['org', 'cctv.live', [ORG_SCOPE], 'user'],
      ['region', 'cctv.live', [atRegion(region)], 'user'],
      ['cluster', 'cctv.live', [atCluster(c1)], 'user'],
      ['location', 'cctv.live', [atLocation(L1)], 'user'],
      ['recorder', 'cctv.live', [atRecorder(R1)], 'user'],
      ['camera', 'cctv.live', [atCamera(cam1)], 'user'],
      ['two cameras', 'cctv.live', [atCamera(cam1), atCamera(cam2)], 'user'],
      ['playback only', 'cctv.playback', [atLocation(L1)], 'user'],
      ['exporter', ['cctv.export', 'cctv.playback'], [atLocation(L1)], 'admin'],
      ['export only', ['cctv.export'], [atLocation(L1)], 'admin'],
      ['nothing', [], [], 'user'],
      ['bystander', 'cctv.live', [ORG_SCOPE], 'user'],
    ]
    for (const [name, caps, scopes, role] of matrix) {
      const u = await createUser(orgId, role)
      if (scopes.length > 0 && caps.length > 0) await grant(orgId, u.id, caps, scopes)
      people.set(name, u)
    }
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  describe('has_capability_for_user equals has_capability_for asked as the person', () => {
    it('for every person, capability and target kind', async () => {
      const targets: [string, string][] = [
        ...[cam1, cam2, cam3, cam4].map((id) => ['camera', id] as [string, string]),
        ['location', L1], ['location', L2], ['recorder', R1], ['recorder', R2], ['recorder', R3], ['cluster', c1], ['cluster', c2], ['region', region],
        ['camera', foreignCam], ['camera', randomUUID()],
      ]
      let compared = 0
      let allowed = 0
      for (const [name, u] of people) {
        const asks = ['cctv.live', 'cctv.playback', 'cctv.export'].flatMap((cap) => targets.map(([kind, id]) => ({ cap, kind, id })))
        const answers = await Promise.all(asks.map(async ({ cap, kind, id }) => {
          const mine = await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: kind, p_id: id })
          const server = await admin().rpc('has_capability_for_user', { p_user: u.id, p_cap: cap, p_kind: kind, p_id: id })
          return { cap, kind, mine, server }
        }))
        for (const { cap, kind, mine, server } of answers) {
          expect(mine.error).toBeNull()
          expect(server.error).toBeNull()
          expect(server.data, `${name}: ${cap} ${kind}`).toBe(mine.data)
          compared++
          if (mine.data) allowed++
        }
      }
      expect(compared).toBe(people.size * 3 * targets.length)
      expect(allowed).toBeGreaterThan(40) // the matrix is not trivially "no" everywhere
    })

    it('is for the server only', async () => {
      const r = await person('org').client.rpc('has_capability_for_user', { p_user: person('org').id, p_cap: 'cctv.live', p_kind: 'camera', p_id: cam1 })
      expect(r.error).not.toBeNull()
    })

    // Review m-4: the twin check runs on every suite (not only when 0029 applied), so a later migration that changes
    // has_capability_for without its twin is caught here.
    it('the twin is still the twin of has_capability_for (checked in the database on every run)', async () => {
      const { data, error } = await admin().rpc('access_twin_violations')
      expect(error).toBeNull()
      expect(data).toEqual([])
      expect((await person('org').client.rpc('access_twin_violations')).error).not.toBeNull()
    })

    it('review m-4: also for IT capabilities on assets, ended and future grants, an archived cluster and another organisation’s grant', async () => {
      const asset = (await admin().from('assets').insert({ org_id: orgId, location_id: L2, type: 'switch', name: 'Switch', ip: '172.31.7.9' }).select('id').single()).data!.id
      const archivedCluster = await createCluster(orgId, region)
      const Lz = await createLocation(orgId, { clusterId: archivedCluster })
      const Rz = await createRecorder(orgId, Lz, { host: '10.77.11.1' })
      const camZ = await createCamera(orgId, { locationId: Lz, recorderId: Rz, channel: 1 })
      const itViewer = await createUser(orgId, 'user')
      await grant(orgId, itViewer.id, 'it.monitoring.view', atLocation(L2))
      const ended = await createUser(orgId, 'user')
      await grant(orgId, ended.id, 'cctv.live', ORG_SCOPE, { validFrom: new Date(Date.now() - 7_200_000).toISOString(), validUntil: new Date(Date.now() - 3_600_000).toISOString() })
      const future = await createUser(orgId, 'user')
      await grant(orgId, future.id, 'cctv.live', ORG_SCOPE, { validFrom: new Date(Date.now() + 3_600_000).toISOString() })
      const clusterHolder = await createUser(orgId, 'user')
      await grant(orgId, clusterHolder.id, ['cctv.live', 'it.monitoring.view'], atCluster(archivedCluster))
      const foreigner = await createUser(otherOrg, 'user')
      await grant(otherOrg, foreigner.id, ['cctv.live', 'it.monitoring.view'], ORG_SCOPE)
      // A cluster with a location in it cannot be archived (DR007): move the location out, then archive the empty cluster.
      expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: Lz, p_cluster: c1, p_actor: actor.id })).error).toBeNull()
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: archivedCluster, p_actor: actor.id })).error).toBeNull()
      const targets: [string, string][] = [['asset', asset], ['location', L2], ['camera', camZ], ['camera', cam4], ['cluster', archivedCluster], ['location', Lz], ['recorder', Rz]]
      let compared = 0
      for (const u of [itViewer, ended, future, clusterHolder, foreigner]) {
        for (const cap of ['cctv.live', 'it.monitoring.view']) {
          for (const [kind, id] of targets) {
            const mine = await u.client.rpc('has_capability_for', { p_cap: cap, p_kind: kind, p_id: id })
            const server = await admin().rpc('has_capability_for_user', { p_user: u.id, p_cap: cap, p_kind: kind, p_id: id })
            expect(mine.error).toBeNull()
            expect(server.data, `${cap} ${kind}`).toBe(mine.data)
            compared++
          }
        }
      }
      expect(compared).toBe(5 * 2 * targets.length)
      // The cases are what they claim to be.
      expect((await admin().rpc('has_capability_for_user', { p_user: itViewer.id, p_cap: 'it.monitoring.view', p_kind: 'asset', p_id: asset })).data).toBe(true)
      expect((await admin().rpc('has_capability_for_user', { p_user: ended.id, p_cap: 'cctv.live', p_kind: 'camera', p_id: cam4 })).data).toBe(false)
      expect((await admin().rpc('has_capability_for_user', { p_user: future.id, p_cap: 'cctv.live', p_kind: 'camera', p_id: cam4 })).data).toBe(false)
      expect((await admin().rpc('has_capability_for_user', { p_user: foreigner.id, p_cap: 'cctv.live', p_kind: 'camera', p_id: cam4 })).data).toBe(false)
    })
  })

  describe('media_session_create', () => {
    it('makes a session only for cameras the person may use for that kind, in the organisation', async () => {
      const made = await create(person('location'), 'live', [cam1, cam3, cam4, foreignCam, randomUUID()])
      expect(made.map((m) => m.camera_id).sort()).toEqual([cam1, cam3].sort())
      const r = await row(made[0].sid)
      expect(r).toMatchObject({ org_id: orgId, user_id: person('location').id, kind: 'live', capability: 'cctv.live', opened_at: null, closed_at: null, revoked_at: null })
      // The connect window is 90 seconds; the session lasts at most 30 minutes after it (the gateway's longest socket).
      const created = Date.parse(r.created_at)
      expect(Date.parse(r.connect_by) - created).toBeGreaterThanOrEqual(89_000)
      expect(Date.parse(r.connect_by) - created).toBeLessThanOrEqual(91_000)
      expect(Date.parse(r.expires_at) - Date.parse(r.connect_by)).toBe(1800_000)
      expect(await create(person('nothing'), 'live', [cam1])).toEqual([])
      expect(await create(person('playback only'), 'live', [cam1])).toEqual([])
      expect((await create(person('playback only'), 'playback', [cam1])).length).toBe(1)
    })

    it('fast playback (vod) needs cctv.export AND cctv.playback for the camera (P2-2 M-3, ruling E-1)', async () => {
      expect((await create(person('exporter'), 'vod', [cam1])).length).toBe(1)
      expect(await create(person('export only'), 'vod', [cam1])).toEqual([])
      expect(await create(person('location'), 'vod', [cam1])).toEqual([])
      expect((await row((await create(person('exporter'), 'vod', [cam1]))[0].sid)).capability).toBe('cctv.export')
    })

    it('makes nothing for a person who is not in the organisation, and refuses kinds it does not make', async () => {
      expect(await create(person('org'), 'live', [cam1], { org: otherOrg })).toEqual([])
      const bad = await admin().rpc('media_session_create', { p_org: orgId, p_user: person('org').id, p_kind: 'remote_control', p_cameras: [cam1] })
      expect(bad.error?.code).toBe('22023')
      const noStream = await admin().rpc('media_session_create', { p_org: orgId, p_user: person('org').id, p_kind: 'live', p_cameras: [cam1] })
      expect(noStream.error).not.toBeNull()
    })

    it('makes nothing for a camera whose NVR is switched off, or that is switched off itself', async () => {
      const loc = await createLocation(orgId)
      const off = await createRecorder(orgId, loc, { host: '10.77.3.1', monitoringOff: 'switched off for the test' })
      const camOff = await createCamera(orgId, { locationId: loc, recorderId: off, channel: 1 })
      const rec = await createRecorder(orgId, loc, { host: '10.77.3.2' })
      const camInactive = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, isActive: false })
      expect(await create(person('org'), 'live', [camOff, camInactive])).toEqual([])
    })
  })

  describe('media_session_open (the gateway, when a socket arrives)', () => {
    it('opens once for the person, camera, kind and stream of the session', async () => {
      const sid = await live(person('camera'), cam1)
      expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: true, reason: null, kind: 'live', stream: `cam_${cam1}_sub` })
      const r = await row(sid)
      expect(r.opened_at).not.toBeNull()
      expect(r.last_validated_at).not.toBeNull()
      // The same session id a second time (a copied token, a second socket) is refused.
      expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: false, reason: 'already_opened' })
    })

    it('refuses a session id of another person or camera (a forged sid) and leaves the real session usable', async () => {
      const sid = await live(person('camera'), cam1)
      expect(await open(sid, person('org'), cam1)).toMatchObject({ ok: false, reason: 'mismatch' })
      expect(await open(sid, person('camera'), cam2, 'live', `cam_${cam2}_sub`)).toMatchObject({ ok: false, reason: 'mismatch' })
      expect(await open(sid, person('camera'), cam1, 'playback')).toMatchObject({ ok: false, reason: 'mismatch' })
      expect(await open(sid, person('camera'), cam1, 'live', `cam_${cam1}_main`)).toMatchObject({ ok: false, reason: 'mismatch' })
      expect(await open(randomUUID(), person('camera'), cam1)).toMatchObject({ ok: false, reason: 'not_found' })
      expect((await row(sid)).revoked_at).toBeNull()
      expect((await open(sid, person('camera'), cam1)).ok).toBe(true)
    })

    it('refuses after the connect window', async () => {
      const [{ sid }] = await create(person('camera'), 'live', [cam1], { connectSec: 1 })
      await new Promise((r) => setTimeout(r, 1500))
      expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: false, reason: 'connect_window_passed' })
      expect((await row(sid)).revoke_reason).toBe('connect_window_passed')
    })

    it('a session made before access was taken away cannot be opened afterwards (AC-14, brief 6b)', async () => {
      const u = await createUser(orgId, 'user')
      const [g] = await grant(orgId, u.id, 'cctv.live', atCamera(cam2))
      const sid = await live(u, cam2)
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [g], p_reason: 'test: taken away' })).error).toBeNull()
      expect(await open(sid, u, cam2)).toMatchObject({ ok: false })
    })

    it('is for the server only', async () => {
      const sid = await live(person('camera'), cam1)
      const r = await person('camera').client.rpc('media_session_open', { p_sid: sid, p_user: person('camera').id, p_camera: cam1, p_kind: 'live', p_stream: `cam_${cam1}_sub` })
      expect(r.error).not.toBeNull()
      // Signed-in people cannot read the registry at all (it names who watches what).
      const read = await person('org').client.from('media_sessions').select('id')
      expect(read.error).not.toBeNull()
    })
  })

  describe('media_sessions_still_valid (one batched call for every open socket)', () => {
    it('answers only the invalid ones, with the reason, and stamps the valid ones', async () => {
      const a = await watching(person('camera'), cam1)
      const b = await watching(person('org'), cam4)
      const closed = await watching(person('org'), cam2)
      expect((await admin().rpc('media_session_close', { p_sid: closed })).error).toBeNull()
      const before = (await row(a)).last_validated_at!
      await new Promise((r) => setTimeout(r, 20))
      const missing = randomUUID()
      const answer = await stillValid([a, b, closed, missing, a])
      expect(Object.fromEntries(answer)).toEqual({ [closed]: 'closed', [missing]: 'not_found' })
      expect(Date.parse((await row(a)).last_validated_at!)).toBeGreaterThan(Date.parse(before))
      expect(await stillValid([])).toEqual(new Map())
    })

    it('a grant that ends (valid_until passes) makes the session invalid without anybody doing anything', async () => {
      const u = await createUser(orgId, 'user')
      await grant(orgId, u.id, 'cctv.live', atCamera(cam4), { validUntil: new Date(Date.now() + 3000).toISOString() })
      const sid = await watching(u, cam4)
      expect(await stillValid([sid])).toEqual(new Map())
      await new Promise((r) => setTimeout(r, 3500))
      expect(Object.fromEntries(await stillValid([sid]))).toEqual({ [sid]: 'access_changed' })
      expect((await row(sid)).revoke_reason).toBe('access_changed')
    })

    it('switching the NVR off makes its sessions invalid (nothing may keep contacting it)', async () => {
      const loc = await createLocation(orgId)
      const rec = await createRecorder(orgId, loc, { host: '10.77.4.1' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      const sid = await watching(person('org'), cam)
      const other = await watching(person('org'), cam4)
      expect((await admin().rpc('recorder_set_monitoring', { p_org: orgId, p_recorder: rec, p_enabled: false, p_reason: 'test: switched off', p_actor: actor.id })).error).toBeNull()
      expect(Object.fromEntries(await stillValid([sid, other]))).toEqual({ [sid]: 'not_available' })
    })

    it('refuses more than 5000 ids in one call and is for the server only', async () => {
      const many = Array.from({ length: 5001 }, () => randomUUID())
      expect((await admin().rpc('media_sessions_still_valid', { p_sids: many })).error?.code).toBe('22023')
      expect((await person('org').client.rpc('media_sessions_still_valid', { p_sids: [randomUUID()] })).error).not.toBeNull()
    })
  })

  describe('media_session_close and media_sessions_revoke_user', () => {
    it('closing is idempotent and a closed session cannot be opened', async () => {
      const sid = await live(person('org'), cam1)
      const first = await admin().rpc('media_session_close', { p_sid: sid })
      expect(first.error).toBeNull()
      expect(first.data).toBe(true)
      const at = (await row(sid)).closed_at
      expect(at).not.toBeNull()
      const again = await admin().rpc('media_session_close', { p_sid: sid })
      expect(again.error).toBeNull()
      expect((await row(sid)).closed_at).toBe(at)
      expect((await admin().rpc('media_session_close', { p_sid: randomUUID() })).data).toBe(false)
      expect(await open(sid, person('org'), cam1)).toMatchObject({ ok: false, reason: 'closed' })
    })

    it('revokes every open session of one person in the organisation, nobody else’s', async () => {
      const u = await createUser(orgId, 'user')
      await grant(orgId, u.id, 'cctv.live', ORG_SCOPE)
      const s1 = await watching(u, cam1)
      const s2 = await live(u, cam3) // made, not connected yet: revoked too (its token must not open later)
      const theirs = await watching(person('bystander'), cam1)
      const wrongOrg = await admin().rpc('media_sessions_revoke_user', { p_org: otherOrg, p_user: u.id, p_reason: 'test' })
      expect(wrongOrg.data).toBe(0)
      const r = await admin().rpc('media_sessions_revoke_user', { p_org: orgId, p_user: u.id, p_reason: 'test_reason' })
      expect(r.error).toBeNull()
      expect(r.data).toBe(2)
      expect(Object.fromEntries(await stillValid([s1, s2, theirs]))).toEqual({ [s1]: 'test_reason', [s2]: 'test_reason' })
    })
  })

  describe('every access change marks the affected sessions at once (deferred trigger on profiles)', () => {
    async function viewer(caps: string | readonly string[], scopes: GrantScope | GrantScope[]) {
      const u = await createUser(orgId, 'user')
      const ids = await grant(orgId, u.id, caps, scopes)
      return { u, ids }
    }
    const revoked = async (sid: string) => (await row(sid)).revoke_reason

    it('deactivation, password reset and role change revoke all of the person’s sessions', async () => {
      const a = await viewer('cctv.live', ORG_SCOPE)
      const b = await viewer('cctv.live', ORG_SCOPE)
      const c = await viewer('cctv.live', ORG_SCOPE)
      const sa = await watching(a.u, cam1)
      const sb = await watching(b.u, cam1)
      const sc = await watching(c.u, cam1)
      const other = await watching(person('bystander'), cam1)
      expect((await admin().rpc('set_person_active', { p_org: orgId, p_actor: actor.id, p_user: a.u.id, p_active: false })).error).toBeNull()
      expect(await revoked(sa)).toBe('deactivated')
      expect((await admin().from('profiles').update({ must_reset_password: true }).eq('id', b.u.id)).error).toBeNull()
      expect(await revoked(sb)).toBe('password_reset')
      expect((await admin().rpc('change_person_role', { p_org: orgId, p_actor: actor.id, p_user: c.u.id, p_role: 'operator' })).error).toBeNull()
      expect(await revoked(sc)).toBe('role_changed')
      expect(await revoked(other)).toBeNull()
    })

    it('a removed grant ends only the sessions it covered (the others of the same person stay)', async () => {
      const { u, ids } = await viewer('cctv.live', [atCamera(cam1), atCamera(cam4)])
      const s1 = await watching(u, cam1)
      const s4 = await watching(u, cam4)
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [ids[0]], p_reason: 'test: one camera less' })).error).toBeNull()
      expect(await revoked(s1)).toBe('access_changed')
      expect(await revoked(s4)).toBeNull()
    })

    it('removing a recorder-scope grant ends the sessions of that NVR’s cameras only', async () => {
      const { u, ids } = await viewer('cctv.live', [atRecorder(R1), atCamera(cam4)])
      const s1 = await watching(u, cam1)
      const s4 = await watching(u, cam4)
      const other = await watching(person('recorder'), cam1)
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [ids[0]], p_reason: 'test: NVR grant removed' })).error).toBeNull()
      expect(await revoked(s1)).toBe('access_changed')
      expect(await revoked(s4)).toBeNull()
      expect(await revoked(other)).toBeNull()
    })

    it('moving a location to another cluster ends the old cluster’s holders’ sessions, not the location holder’s', async () => {
      const loc = await createLocation(orgId, { clusterId: c1 })
      const rec = await createRecorder(orgId, loc, { host: '10.77.5.1' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      const { u: clusterHolder } = await viewer('cctv.live', atCluster(c1))
      const { u: locHolder } = await viewer('cctv.live', atLocation(loc))
      const sc = await watching(clusterHolder, cam)
      const sl = await watching(locHolder, cam)
      const elsewhere = await watching(clusterHolder, cam1) // still in cluster 1
      expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: loc, p_cluster: c2, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sc)).toBe('access_changed')
      expect(await revoked(sl)).toBeNull()
      expect(await revoked(elsewhere)).toBeNull()
    })

    it('moving a camera to another NVR ends the old NVR holders’ sessions, not the location holder’s', async () => {
      const loc = await createLocation(orgId)
      const ra = await createRecorder(orgId, loc, { host: '10.77.6.1' })
      const rb = await createRecorder(orgId, loc, { host: '10.77.6.2' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: ra, channel: 1 })
      const { u: nvrHolder } = await viewer('cctv.live', atRecorder(ra))
      const { u: locHolder } = await viewer('cctv.live', atLocation(loc))
      const sn = await watching(nvrHolder, cam)
      const sl = await watching(locHolder, cam)
      await mapCamera(orgId, cam, rb, 5)
      expect(await revoked(sn)).toBe('access_changed')
      expect(await revoked(sl)).toBeNull()
    })

    it('archiving a camera or a location ends its sessions; other locations are untouched', async () => {
      const loc = await createLocation(orgId)
      const rec = await createRecorder(orgId, loc, { host: '10.77.7.1' })
      const camA = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      const camB = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2 })
      const { u } = await viewer('cctv.live', ORG_SCOPE)
      const sa = await watching(u, camA)
      const sb = await watching(u, camB)
      const elsewhere = await watching(u, cam4)
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: camA, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sa)).not.toBeNull()
      expect(await revoked(sb)).toBeNull()
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'location', p_id: loc, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sb)).not.toBeNull()
      expect(await revoked(elsewhere)).toBeNull()
    })

    it('archiving an NVR or a cluster: the move that must come first ends their holders’ sessions; the location holder’s stay', async () => {
      // The archive screens refuse an NVR that still has cameras and a cluster that still has locations (DR004, DR007), so the
      // sessions of those holders end with the move before it. Archiving afterwards changes nothing for anybody else.
      const cluster = await createCluster(orgId, region)
      const loc = await createLocation(orgId, { clusterId: cluster })
      const recA = await createRecorder(orgId, loc, { host: '10.77.8.1' })
      const recB = await createRecorder(orgId, loc, { host: '10.77.8.2' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: recA, channel: 1 })
      const { u: nvrHolder } = await viewer('cctv.live', atRecorder(recA))
      const { u: clusterHolder } = await viewer('cctv.live', atCluster(cluster))
      const { u: locHolder } = await viewer('cctv.live', atLocation(loc))
      const sn = await watching(nvrHolder, cam)
      const sc = await watching(clusterHolder, cam)
      const sl = await watching(locHolder, cam)
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: recA, p_actor: actor.id })).error?.code).toBe('DR004')
      await mapCamera(orgId, cam, recB, 1)
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'recorder', p_id: recA, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sn)).toBe('access_changed')
      expect(await revoked(sc)).toBeNull()
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: cluster, p_actor: actor.id })).error?.code).toBe('DR007')
      expect((await admin().rpc('inventory_move_location', { p_org: orgId, p_location: loc, p_cluster: c2, p_actor: actor.id })).error).toBeNull()
      expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'cluster', p_id: cluster, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sc)).toBe('access_changed')
      expect(await revoked(sl)).toBeNull()
      expect(await stillValid([sl])).toEqual(new Map())
    })

    it('merging a duplicate camera ends the sessions of the duplicate', async () => {
      const loc = await createLocation(orgId)
      const rec = await createRecorder(orgId, loc, { host: '10.77.10.1' })
      const keep = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      const dup = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2 })
      const { u } = await viewer('cctv.live', atCamera(dup))
      const sd = await watching(u, dup)
      const theirs = await watching(person('bystander'), cam4)
      expect((await admin().rpc('camera_merge', { p_org: orgId, p_keep: keep, p_duplicate: dup, p_actor: actor.id })).error).toBeNull()
      expect(await revoked(sd)).not.toBeNull()
      expect(await revoked(theirs)).toBeNull()
    })
  })

  describe('review round 1', () => {
    it('m-1: a closed (not revoked) session reopens within its connect window, one socket at a time, at most 3 times', async () => {
      const sid = await watching(person('camera'), cam1)
      // A second copy while the first socket is open: refused.
      expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: false, reason: 'already_opened' })
      for (let i = 0; i < 2; i++) {
        expect((await admin().rpc('media_session_close', { p_sid: sid })).error).toBeNull()
        expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: true }) // the tile reconnects with the same token
        expect((await row(sid)).closed_at).toBeNull()
      }
      await admin().rpc('media_session_close', { p_sid: sid })
      expect(await open(sid, person('camera'), cam1)).toMatchObject({ ok: false, reason: 'closed' }) // third reopen = fourth open: refused
      // A forged reopen of somebody else's closed session is still a mismatch, and leaves it closed.
      const other = await watching(person('org'), cam4)
      await admin().rpc('media_session_close', { p_sid: other })
      expect(await open(other, person('camera'), cam4)).toMatchObject({ ok: false, reason: 'mismatch' })
      expect((await row(other)).closed_at).not.toBeNull()
    })

    it('m-1: a revoked session never reopens, and a closed one does not reopen after its window or once access is gone', async () => {
      const u = await createUser(orgId, 'user')
      const [g] = await grant(orgId, u.id, 'cctv.live', atCamera(cam2))
      const sid = await watching(u, cam2)
      await admin().rpc('media_session_close', { p_sid: sid })
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [g], p_reason: 'test: gone' })).error).toBeNull()
      expect(await open(sid, u, cam2)).toMatchObject({ ok: false, reason: 'access_changed' })
      const [{ sid: late }] = await create(person('org'), 'live', [cam4], { connectSec: 1 })
      expect((await open(late, person('org'), cam4)).ok).toBe(true)
      await admin().rpc('media_session_close', { p_sid: late })
      await new Promise((r) => setTimeout(r, 1300))
      expect(await open(late, person('org'), cam4)).toMatchObject({ ok: false, reason: 'closed' })
      const revoked = await watching(person('org'), cam4)
      await admin().rpc('media_sessions_revoke_user', { p_org: orgId, p_user: person('org').id, p_reason: 'test_revoked' })
      expect(await open(revoked, person('org'), cam4)).toMatchObject({ ok: false, reason: 'test_revoked' })
    })

    it('I-1 a: access changes re-check only OPENED sessions; a made-but-unused one is left alone and is checked when it is opened', async () => {
      const u = await createUser(orgId, 'user')
      const [g] = await grant(orgId, u.id, 'cctv.live', atCamera(cam3))
      const opened = await watching(u, cam3)
      const unused = await live(u, cam3)
      expect((await admin().rpc('revoke_grant', { p_org: orgId, p_user: u.id, p_grant_ids: [g], p_reason: 'test: gone' })).error).toBeNull()
      expect((await row(opened)).revoke_reason).toBe('access_changed')
      expect((await row(unused)).revoked_at).toBeNull() // not re-checked at commit (it was before the fix)
      expect(await open(unused, u, cam3)).toMatchObject({ ok: false, reason: 'access_changed' }) // opening checks it fully
    })

    it('I-1 a: a never-opened session whose connect window has passed counts as ended (connect_window_passed)', async () => {
      const [{ sid }] = await create(person('org'), 'live', [cam4], { connectSec: 1 })
      await new Promise((r) => setTimeout(r, 1300))
      expect(Object.fromEntries(await stillValid([sid]))).toEqual({ [sid]: 'connect_window_passed' })
    })

    it('I-1: making sessions clears the person’s own never-opened ones whose window ended more than 5 minutes ago', async () => {
      const u = await createUser(orgId, 'user')
      await grant(orgId, u.id, 'cctv.live', ORG_SCOPE)
      const stale = await live(u, cam4)
      // Age it by moving its window back (service-role tooling only; the table is not writable through the API).
      const { error } = await admin().rpc('media_sessions_age_test', { p_sid: stale, p_seconds: 600 })
      expect(error).toBeNull()
      await live(u, cam4)
      expect((await admin().from('media_sessions').select('id').eq('id', stale)).data).toEqual([])
    })

    it('m-5: moving a cluster to another region ends the old region holders’ sessions', async () => {
      const r2 = await createRegion(orgId)
      const cl = await createCluster(orgId, region)
      const loc = await createLocation(orgId, { clusterId: cl })
      const rec = await createRecorder(orgId, loc, { host: '10.77.12.1' })
      const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
      const regionHolder = await createUser(orgId, 'user')
      await grant(orgId, regionHolder.id, 'cctv.live', atRegion(region))
      const clusterHolder = await createUser(orgId, 'user')
      await grant(orgId, clusterHolder.id, 'cctv.live', atCluster(cl))
      const sr = await watching(regionHolder, cam)
      const sc = await watching(clusterHolder, cam)
      expect((await admin().rpc('inventory_move_cluster', { p_org: orgId, p_cluster: cl, p_region: r2, p_actor: actor.id })).error).toBeNull()
      expect((await row(sr)).revoke_reason).toBe('access_changed')
      expect((await row(sc)).revoked_at).toBeNull()
    })

    it('m-5: moving a camera to another location ends the old location holders’ sessions; a recorder with cameras cannot move', async () => {
      const la = await createLocation(orgId)
      const lb = await createLocation(orgId)
      const ra = await createRecorder(orgId, la, { host: '10.77.13.1' })
      const rb = await createRecorder(orgId, lb, { host: '10.77.13.2' })
      const cam = await createCamera(orgId, { locationId: la, recorderId: ra, channel: 1 })
      const aHolder = await createUser(orgId, 'user')
      await grant(orgId, aHolder.id, 'cctv.live', atLocation(la))
      const bHolder = await createUser(orgId, 'user')
      await grant(orgId, bHolder.id, 'cctv.live', atLocation(lb))
      const sa = await watching(aHolder, cam)
      // The NVR cannot be moved while a camera is mapped to it (DR006): nothing changes, the session stays.
      expect((await admin().from('assets').update({ location_id: lb }).eq('id', ra)).error).not.toBeNull()
      expect((await row(sa)).revoked_at).toBeNull()
      expect((await admin().from('cameras').update({ location_id: lb, recorder_id: rb, channel: 1 }).eq('id', cam)).error).toBeNull()
      expect((await row(sa)).revoke_reason).toBe('access_changed')
      expect((await open(await live(bHolder, cam), bHolder, cam)).ok).toBe(true)
    })
  })

  describe('retention and privileges', () => {
    it('prunes old finished and never-opened sessions of one organisation', async () => {
      const done = await watching(person('org'), cam4)
      await admin().rpc('media_session_close', { p_sid: done })
      const [{ sid: never }] = await create(person('org'), 'live', [cam4], { connectSec: 1 })
      const current = await watching(person('org'), cam4)
      await new Promise((r) => setTimeout(r, 1200))
      const r = await admin().rpc('media_sessions_prune', { p_keep: '0 seconds', p_unopened_keep: '0 seconds', p_org: orgId })
      expect(r.error).toBeNull()
      const left = new Set(((await admin().from('media_sessions').select('id').in('id', [done, never, current])).data ?? []).map((x) => x.id))
      expect(left).toEqual(new Set([current]))
      expect((await admin().rpc('media_sessions_prune', { p_keep: '-1 day' })).error?.code).toBe('22023')
    })

    it('every registry function is for the server only (SECURITY DEFINER, empty search_path); the internal ones for nobody', async () => {
      const v = await admin().rpc('privilege_violations')
      expect(v.data).toEqual([])
      const { data } = await admin().rpc('function_privileges')
      const by = new Map((data ?? []).map((f) => [f.name, f]))
      // P2-6 (D-14): server functions belong to the service key plus exactly the service roles that use them — the gateway only the
      // three registry calls, the video path its sessions, the web app the revocations, the worker the prune; never a signed-in person.
      const server: Record<string, string[]> = {
        has_capability_for_user: ['service_role'],
        media_session_create: ['media_service', 'service_role'],
        media_session_open: ['media_service', 'service_role', 'video_gateway'],
        media_sessions_still_valid: ['media_service', 'service_role', 'video_gateway'],
        media_session_close: ['media_service', 'service_role', 'video_gateway'],
        media_sessions_revoke_user: ['app_web', 'service_role'],
        media_sessions_revalidate: ['app_web', 'service_role'],
        media_sessions_prune: ['monitor_worker', 'service_role'],
        access_twin_violations: ['service_role'],
        media_sessions_age_test: ['service_role'],
      }
      for (const [n, grantees] of Object.entries(server)) {
        expect(by.get(n)?.grantees, n).toEqual(grantees)
        expect(by.get(n)?.security_definer, n).toBe(true)
        expect(by.get(n)?.search_path, n).toBe('')
      }
      for (const n of ['media_session_problem', 'media_session_target_problem', 'media_sessions_profile_changed', 'media_sessions_recheck_budget']) {
        expect(by.get(n)?.grantees, n).toEqual([])
        expect(by.get(n)?.search_path, n).toBe('')
      }
    })

    it('revalidating people keeps their valid sessions and ends the rest', async () => {
      const { data: before } = await admin().rpc('media_sessions_revalidate', { p_org: orgId, p_users: [person('org').id] })
      expect(typeof before).toBe('number')
      const sid = await watching(person('org'), cam1)
      expect((await admin().rpc('media_sessions_revalidate', { p_org: orgId, p_users: [person('org').id] })).data).toBe(0)
      expect((await row(sid)).revoked_at).toBeNull()
    })
  })
})
