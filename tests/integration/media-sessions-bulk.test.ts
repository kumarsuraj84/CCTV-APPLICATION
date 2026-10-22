import { afterAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'

// P2-4 review I-1 (c): the re-check at commit must stay cheap for a bulk change. The size of the estate import with archiving: one
// transaction archives 216 locations (each archive raises the access version of every organisation-wide holder, so ~25 holders × 216
// events), while 25 administrators each have 36 open video sessions (a 6 × 6 wall) and a backlog of never-opened ones (the wall's
// renewals). After the fix only opened sessions are re-checked, once per person per transaction, within a budget. The measured commit
// time is printed (bulk_commit_ms); the before/after comparison on the same shape is in the P2-4 report (psql, rolled back).

const admin = () => adminClient()
const ADMINS = 25
const LOCATIONS = 216
const WALL = 36

describe('the re-check at commit of a bulk access change is bounded (review I-1)', () => {
  let orgId: string

  afterAll(async () => {
    await cleanupOrg(orgId)
  })

  it('archiving 216 locations in one import while 25 administrators watch 36 cameras each', async () => {
    orgId = await createOrg()
    const owner = await createUser(orgId, 'platform_owner')
    // The wall's cameras sit in a location that stays; one more camera sits in a location that is archived.
    const wallLoc = await createLocation(orgId)
    const wallRecA = await createRecorder(orgId, wallLoc, { host: '10.201.0.1' })
    const wallRecB = await createRecorder(orgId, wallLoc, { host: '10.201.0.2' })
    const wall: string[] = []
    for (let ch = 1; ch <= WALL / 2; ch++) {
      wall.push(await createCamera(orgId, { locationId: wallLoc, recorderId: wallRecA, channel: ch }))
      wall.push(await createCamera(orgId, { locationId: wallLoc, recorderId: wallRecB, channel: ch }))
    }
    const doomed: string[] = []
    let doomedCamera = ''
    for (let i = 0; i < LOCATIONS; i += 12) {
      await Promise.all(Array.from({ length: Math.min(12, LOCATIONS - i) }, async (_, j) => {
        const n = i + j
        const loc = await createLocation(orgId)
        const rec = await createRecorder(orgId, loc, { host: `10.202.${Math.floor(n / 200)}.${(n % 200) + 1}` })
        const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
        doomed.push(loc)
        if (n === 0) doomedCamera = cam
      }))
    }
    const admins: TestUser[] = []
    for (let i = 0; i < ADMINS; i++) {
      const u = await createUser(orgId, 'admin')
      await grant(orgId, u.id, 'cctv.live', ORG_SCOPE)
      admins.push(u)
    }
    // 36 open sessions each, plus 108 made and never opened (three renewals of the wall).
    const openSids: string[] = []
    await Promise.all(admins.map(async (u) => {
      const { data, error } = await admin().rpc('media_session_create', { p_org: orgId, p_user: u.id, p_kind: 'live', p_cameras: wall, p_streams: wall.map((c) => `cam_${c}_sub`) })
      if (error) throw new Error(error.message)
      for (const r of data ?? []) {
        const o = await admin().rpc('media_session_open', { p_sid: r.sid, p_user: u.id, p_camera: r.camera_id, p_kind: 'live', p_stream: `cam_${r.camera_id}_sub` })
        expect((o.data as { ok: boolean }[])[0].ok).toBe(true)
        openSids.push(r.sid)
      }
      for (let k = 0; k < 3; k++) {
        const more = await admin().rpc('media_session_create', { p_org: orgId, p_user: u.id, p_kind: 'live', p_cameras: wall, p_streams: wall.map((c) => `cam_${c}_sub`) })
        if (more.error) throw new Error(more.error.message)
      }
    }))
    expect(openSids).toHaveLength(ADMINS * WALL)
    // One administrator also watches a camera of a location that is archived: that session must end.
    const [{ sid: doomedSid }] = ((await admin().rpc('media_session_create', { p_org: orgId, p_user: admins[0].id, p_kind: 'live', p_cameras: [doomedCamera], p_streams: [`cam_${doomedCamera}_sub`] })).data ?? []) as { sid: string }[]
    await admin().rpc('media_session_open', { p_sid: doomedSid, p_user: admins[0].id, p_camera: doomedCamera, p_kind: 'live', p_stream: `cam_${doomedCamera}_sub` })

    const plan = { archive: doomed.map((id) => ({ kind: 'location', id })) }
    const t0 = performance.now()
    const res = await admin().rpc('inventory_import_apply', { p_org: orgId, p_actor: owner.id, p_plan: plan })
    const ms = performance.now() - t0
    expect(res.error).toBeNull()
    expect((res.data as { archived_locations: number }).archived_locations).toBe(LOCATIONS)
    console.log(JSON.stringify({ bulk_commit_ms: { archived_locations: LOCATIONS, admins: ADMINS, open_sessions_each: WALL, never_opened_each: 108, transaction_ms: Math.round(ms) } }))
    expect(ms).toBeLessThan(20_000)

    // The re-check still did its job: the archived camera's session ended; every wall session stays.
    const { data: doomedRow } = await admin().from('media_sessions').select('revoke_reason').eq('id', doomedSid).single()
    expect(doomedRow?.revoke_reason).not.toBeNull()
    let revokedWall = 0
    for (let i = 0; i < openSids.length; i += 200) {
      const { count } = await admin().from('media_sessions').select('id', { count: 'exact', head: true }).in('id', openSids.slice(i, i + 200)).not('revoked_at', 'is', null)
      revokedWall += count ?? 0
    }
    expect(revokedWall).toBe(0)
  }, 300_000)
})
