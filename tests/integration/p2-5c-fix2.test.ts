// P2-5c-1 fix round 2 (Part A of .superpowers/sdd/drishti/p2-5c-2-review.md), against the local database with fake NVRs on loopback
// only. Real NVRs are never contacted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { applyProposals, previewProposals } from '@/lib/inventory/hierarchy'
import { previewMerge, searchCameras } from '@/lib/inventory/mapping'
import { testRecorderConnection } from '@/lib/inventory/recorder-admin'
import { discoverRecorderCameras } from '@/lib/monitor/discovery'
import { MSG_LOGIN_BACKOFF, MSG_LOGIN_PAUSED } from '@/lib/monitor/login-backoff'
import { startFakeNvr, type FakeNvr } from '../helpers/fake-servers'
import {
  adminClient, atCamera, atCluster, atLocation, atRecorder, atRegion, cleanupOrg, createCamera, createCluster, createLocation, createOrg, createRecorder, createRegion,
  createUser, grant, ORG_SCOPE, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const day = 86_400_000
/** A grant that ran from three days ago until yesterday. */
const ENDED = { validFrom: new Date(Date.now() - 3 * day).toISOString(), validUntil: new Date(Date.now() - day).toISOString() }

describe('P2-5c-1 fix round 2', () => {
  let orgId: string
  let me: TestUser
  let actor: Actor
  const c = (u: TestUser = me) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, ['admin.inventory', 'cctv.live', 'cctv.playback'])
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('A-N1 / A-N2: the preview names the ids it describes, says whether the duplicate is linked, and counts only people who really lose the video', async () => {
    const r1 = await createRegion(orgId, { code: 'FYR' })
    const cl = await createCluster(orgId, r1, { code: 'FYC' })
    const loc = await createLocation(orgId, { code: 'FYN2', clusterId: cl })
    const a = await createRecorder(orgId, loc, { name: 'Ground', host: '127.0.0.1', httpPort: 9520 })
    const b = await createRecorder(orgId, loc, { name: 'NVR, channel 9 wing', host: '127.0.0.1', httpPort: 9521, rtspPort: 9621 })
    const keep = await createCamera(orgId, { locationId: loc, recorderId: a, channel: 1, name: 'Cash office' })
    const dup = await createCamera(orgId, { locationId: loc, recorderId: b, channel: 2, name: 'Cash office (new)' })
    const only = await createUser(orgId, 'user') // a grant on the duplicate and nothing else: loses it
    await grant(orgId, only.id, ['cctv.live', 'cctv.playback'], atCamera(dup))
    const partly = await createUser(orgId, 'user') // live also through the location, playback only on the camera: loses playback
    await grant(orgId, partly.id, ['cctv.live', 'cctv.playback'], atCamera(dup))
    await grant(orgId, partly.id, 'cctv.live', atLocation(loc))
    const kept: string[] = []
    for (const scope of [atLocation(loc), atCluster(cl), atRegion(r1), atRecorder(b), atCamera(keep), ORG_SCOPE]) {
      const p = await createUser(orgId, 'user')
      await grant(orgId, p.id, 'cctv.live', atCamera(dup))
      await grant(orgId, p.id, 'cctv.live', scope)
      kept.push(p.id)
    }
    const old = await createUser(orgId, 'user') // an ended grant is not access
    await grant(orgId, old.id, 'cctv.live', atCamera(dup), ENDED)
    expect(await previewMerge(c(), actor, { keepId: keep.toUpperCase(), duplicateId: dup })).toEqual({
      ok: true, keepId: keep, duplicateId: dup, keepName: 'Cash office', duplicateName: 'Cash office (new)', duplicatePlace: 'FYN2 · NVR, channel 9 wing, channel 2',
      duplicateLinked: true, peopleLosing: 2,
    })
    const unlinked = await createCamera(orgId, { locationId: loc, recorderId: null, channel: 5, name: 'Spare' })
    expect(await previewMerge(c(), actor, { keepId: keep, duplicateId: unlinked })).toMatchObject({ ok: true, duplicatePlace: 'FYN2 · not linked', duplicateLinked: false, peopleLosing: 0 })
  })

  // Final fix X round 2 (review M-10; ruling NB-10, which replaces the "whatever login" part of A-N3): one refused login per saved
  // password and window; three refusals of one saved login (with "Try again") pause the NVR; a corrected password is tried at once.
  it('A-N3: each saved password is tried once; three refusals of one login pause the NVR; a corrected password works at once', async () => {
    const nvr: FakeNvr = await startFakeNvr({ channels: [{ channel: 1, name: 'A' }], statuses: { 1: true } })
    try {
      const loc = await createLocation(orgId, { code: 'FYN3' })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: nvr.port, secret: 'wrong-1' })
      const store = async (secret: string) => expect((await admin().rpc('recorder_store_credential', { p_recorder: rec, p_secret: secret })).error).toBeNull()
      const again = async () => expect((await admin().rpc('nvr_login_try_again' as never, { p_org: orgId, p_recorder: rec, p_actor: me.id } as never)).error).toBeNull()
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_BACKOFF })
      await again()
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      await again()
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: 'The NVR refused the user name or password.' })
      await again()
      const refusedLogins = nvr.authorizations.length
      expect(refusedLogins).toBe(3)
      expect(await testRecorderConnection(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_PAUSED })
      expect(await discoverRecorderCameras(c(), actor, rec)).toEqual({ ok: false, error: MSG_LOGIN_PAUSED })
      expect(nvr.authorizations.length).toBe(refusedLogins)
      await store('secret-pass') // the corrected password lifts the pause and is tried at once
      expect(await testRecorderConnection(c(), actor, rec)).toMatchObject({ ok: true })
    } finally {
      await nvr.close()
    }
  })

  describe('M-1 (partly fixed): zone → cluster proposals', () => {
    it('applying is all or nothing: one bad row and nothing is created or moved', async () => {
      const good = await createLocation(orgId, { code: 'FYM1A' })
      const missing = '00000000-0000-4000-8000-00000000dead'
      expect(await applyProposals(c(), actor, [
        { locationId: good, clusterCode: 'FYATC', regionCode: 'FYATR' },
        { locationId: missing, clusterCode: 'FYATC', regionCode: 'FYATR' },
      ])).toEqual({ ok: false, error: 'Location not found.' })
      expect((await admin().from('locations').select('cluster_id').eq('id', good).single()).data?.cluster_id).toBeNull()
      expect((await admin().from('clusters').select('id').eq('org_id', orgId).eq('code', 'FYATC')).data).toEqual([])
      expect((await admin().from('regions').select('id').eq('org_id', orgId).eq('code', 'FYATR')).data).toEqual([])
    })

    it('the same location ticked twice is refused before anything happens', async () => {
      const loc = await createLocation(orgId, { code: 'FYM1D' })
      const twice = [{ locationId: loc, clusterCode: 'FYD1', regionCode: null }, { locationId: loc, clusterCode: 'FYD2', regionCode: null }]
      expect(await applyProposals(c(), actor, twice)).toEqual({ ok: false, error: 'Each location can be applied once.' })
      expect(await previewProposals(c(), actor, twice)).toEqual({ ok: false, error: 'Each location can be applied once.' })
    })

    it('the preview is one database question for any number of rows, exact for a new cluster in an existing region, and ignores ended grants', async () => {
      const region = await createRegion(orgId, { code: 'FYPR' })
      const existing = await createCluster(orgId, region, { code: 'FYPC' })
      const l1 = await createLocation(orgId, { code: 'FYP1' })
      const l2 = await createLocation(orgId, { code: 'FYP2' })
      const l3 = await createLocation(orgId, { code: 'FYP3' })
      for (const l of [l1, l2, l3]) await createCamera(orgId, { locationId: l, recorderId: await createRecorder(orgId, l, { host: '127.0.0.1', httpPort: 9530 }), channel: 1 })
      const regionHolder = await createUser(orgId, 'user') // gains l2 and l3 (new cluster FYPN in region FYPR) and l1 (existing cluster)
      await grant(orgId, regionHolder.id, 'cctv.live', atRegion(region))
      const already = await createUser(orgId, 'user') // holds the region AND l3 already: gains only l1 and l2
      await grant(orgId, already.id, 'cctv.live', [atRegion(region), atLocation(l3)])
      const ended = await createUser(orgId, 'user') // an ended region grant gains nothing
      await grant(orgId, ended.id, 'cctv.live', atRegion(region), ENDED)
      let rpcs = 0
      const counting = new Proxy(admin(), { get: (t, p) => (p === 'rpc' ? (...a: Parameters<typeof t.rpc>) => { rpcs++; return t.rpc(...a) } : Reflect.get(t, p)) })
      const p = await previewProposals({ admin: counting, rls: me.client }, actor, [
        { locationId: l1, clusterCode: 'FYPC', regionCode: 'FYPR' },
        { locationId: l2, clusterCode: 'FYPN', regionCode: 'FYPR' },
        { locationId: l3, clusterCode: 'FYPN', regionCode: 'FYPR' },
      ])
      expect(p.ok && [...p.people].sort((x, y) => x.userId.localeCompare(y.userId))).toEqual([
        { userId: regionHolder.id, name: 'Test User', capability: 'cctv.live', before: 0, after: 3 },
        { userId: already.id, name: 'Test User', capability: 'cctv.live', before: 1, after: 3 },
      ].sort((x, y) => x.userId.localeCompare(y.userId)))
      expect(p).toMatchObject({ ok: true, affected: 2, newClusters: ['FYPN'], newRegions: [], regionMismatches: [] })
      expect(rpcs).toBe(1)
      void existing
    })
  })

  it('M-2 note: a "*" in the camera search is a plain character, not a wildcard', async () => {
    const loc = await createLocation(orgId, { code: 'FYM2' })
    const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 9540 })
    await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1, name: 'Gate A*B' })
    await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 2, name: 'Gate AxxB' })
    const r = await searchCameras(c(), actor, 'a*b')
    expect(r.ok && r.cameras.map((x) => x.label)).toEqual(['Gate A*B (FYM2 · NVR, channel 1)'])
  })
})
