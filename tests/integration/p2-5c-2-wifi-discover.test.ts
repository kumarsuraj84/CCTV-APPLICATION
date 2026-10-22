// P2-5c-2 brief items 2 and 4: "Find cameras for all locations" (bounded, read-only, the shared discovery core with its login back-off)
// and the Wi-Fi inventory view (wifi.inventory.view; the capability matrix readable by its holders). Local stack only; every NVR answer
// is given in-process (no socket), every address is TEST-NET or loopback, every organisation is a `test-…` one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { discoverAllConcurrency, discoverAllStatus, MSG_RUN_ACTIVE, MSG_RUN_NOT_FOUND, MSG_STOPPED, startDiscoverAll, stopDiscoverAll } from '@/lib/inventory/discover-all'
import { MSG_LOGIN_BACKOFF } from '@/lib/monitor/login-backoff'
import { NvrError } from '@/lib/nvr/client'
import { MSG_WIFI_DENIED, wifiInventory } from '@/lib/wifi/inventory'
import {
  adminClient, atAsset, atLocation, cleanupOrg, createAsset, createCamera, createLocation, createOrg, createRecorder, createUser, grant, READ_EVERYTHING,
  type TestUser,
} from '../setup/fixtures'
import { createClient } from '@supabase/supabase-js'

const admin = () => adminClient()
const DENIED = 'Only administrators can change locations, NVRs and assets.'
type Channel = { channel: number; name: string; ip: string | null }
/** An NVR answer given directly (no network), per NVR address; counts the contacts and how many are in flight at once. */
function fakeNvrs(byHost: Record<string, Channel[] | Error>, o: { delayMs?: number } = {}) {
  const seen = { contacts: 0, inFlight: 0, maxInFlight: 0, hosts: [] as string[] }
  const nvr = (ep: { host: string }) => ({
    channelStatus: async () => new Map<number, boolean>(),
    channels: async () => {
      seen.contacts++
      seen.hosts.push(ep.host)
      seen.inFlight++
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
      try {
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
        const a = byHost[ep.host]
        if (a instanceof Error) throw a
        if (!a) throw new NvrError('unreachable', 'no answer')
        return a
      } finally {
        seen.inFlight--
      }
    },
  })
  return { nvr, seen }
}
/** Runs the scheduled work at once and lets the test await it (the screen hands it to Next's `after`). */
function collect() {
  const jobs: Promise<unknown>[] = []
  return { schedule: (fn: () => Promise<unknown>) => void jobs.push(fn()), settled: () => Promise.all(jobs) }
}

describe('P2-5c-2 find cameras for all locations', () => {
  let orgId: string
  let otherOrg: string
  let me: TestUser
  let actor: Actor
  const c = (u: TestUser = me) => ({ admin: admin(), rls: u.client })

  beforeAll(async () => {
    orgId = await createOrg()
    otherOrg = await createOrg()
    me = await createUser(orgId, 'admin')
    await grant(orgId, me.id, ['admin.inventory'])
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(async () => {
    await cleanupOrg(orgId)
    await cleanupOrg(otherOrg)
  })

  it('the concurrency comes from DISCOVER_ALL_CONCURRENCY: 4 by default, 1 to 8', () => {
    expect(discoverAllConcurrency({})).toBe(4)
    expect(discoverAllConcurrency({ DISCOVER_ALL_CONCURRENCY: '2' })).toBe(2)
    expect(discoverAllConcurrency({ DISCOVER_ALL_CONCURRENCY: '50' })).toBe(8)
    expect(discoverAllConcurrency({ DISCOVER_ALL_CONCURRENCY: '0' })).toBe(1)
    expect(discoverAllConcurrency({ DISCOVER_ALL_CONCURRENCY: 'many' })).toBe(4)
  })

  it('checks the caller first: no NVR is read or contacted for an administrator without admin.inventory', async () => {
    const plain = await createUser(orgId, 'admin')
    await grant(orgId, plain.id, READ_EVERYTHING)
    const { nvr, seen } = fakeNvrs({})
    const j = collect()
    expect(await startDiscoverAll(c(plain), { id: plain.id, orgId, role: 'admin' }, { nvr, schedule: j.schedule })).toEqual({ ok: false, error: DENIED })
    await j.settled()
    expect(seen.contacts).toBe(0)
  })

  it('asks every switched-on NVR once (read-only), skips switched-off ones and locations without contact, and lists each result', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const l1 = await createLocation(o, { code: 'DA1' })
      const r1 = await createRecorder(o, l1, { host: '192.0.2.101', secret: 'pass-1' })
      const old = await createCamera(o, { locationId: l1, recorderId: r1, channel: 1, name: 'Door' })
      // A camera made by hand, never mapped, with the name the NVR reports on channel 2: listed for reconciliation, not duplicated.
      await createRecorder(o, l1, { host: '192.0.2.102', secret: 'pass-2', monitoringOff: 'Owner asked to leave it alone' })
      const l2 = await createLocation(o, { code: 'DA2', isActive: false })
      await createRecorder(o, l2, { host: '192.0.2.103', secret: 'pass-3' })
      const l3 = await createLocation(o, { code: 'DA3' })
      const r3 = await createRecorder(o, l3, { host: '192.0.2.104', secret: 'pass-4' })
      const r4 = await createRecorder(o, l3, { host: '192.0.2.105', secret: 'pass-5' })
      const loose = await createCamera(o, { locationId: l3, recorderId: null, channel: 9, name: 'Stock room' })
      const { nvr, seen } = fakeNvrs({
        '192.0.2.101': [{ channel: 1, name: 'Door', ip: null }, { channel: 2, name: 'Till', ip: null }],
        '192.0.2.104': [{ channel: 1, name: 'Stock room', ip: null }],
        '192.0.2.105': new NvrError('timeout', 'slow'),
      })
      const j = collect()
      const started = await startDiscoverAll({ admin: admin(), rls: u.client }, a, { nvr, schedule: j.schedule, concurrency: 2 })
      if (!started.ok) throw new Error(started.error)
      expect(started.total).toBe(5)
      await j.settled()
      const s = await discoverAllStatus({ admin: admin(), rls: u.client }, a, started.runId)
      if (!s.ok) throw new Error(s.error)
      expect(s.run).toMatchObject({ total: 5, done: 5, concurrency: 2 })
      expect(s.run.finishedAt).not.toBeNull()
      expect(seen.contacts).toBe(3)
      expect(seen.hosts.sort()).toEqual(['192.0.2.101', '192.0.2.104', '192.0.2.105'])
      const byCode = s.run.items.map((i) => [i.code, i.outcome]).sort()
      expect(byCode).toEqual([['DA1', 'done'], ['DA1', 'skipped'], ['DA2', 'skipped'], ['DA3', 'done'], ['DA3', 'failed']])
      expect(s.run.items.find((i) => i.recorderId === r4)).toMatchObject({ outcome: 'failed', message: 'The NVR took too long to answer.' })
      expect(s.run.items.find((i) => i.recorderId === r1)).toMatchObject({ outcome: 'done', cameras: 2, created: 1, toReconcile: 0 })
      expect(s.run.items.find((i) => i.recorderId === r3)).toMatchObject({ outcome: 'done', created: 0, toReconcile: 1 })
      expect(s.run.summary).toMatchObject({ asked: 3, done: 2, failed: 1, skipped: 2, created: 1, toReconcile: 1 })
      // The old camera kept its identity; the unmatched one is on the reconciliation list (discovery_findings), nothing duplicated.
      expect((await admin().from('cameras').select('id').eq('location_id', l1).eq('channel', 1).is('archived_at', null)).data).toEqual([{ id: old }])
      const { data: findings } = await admin().from('discovery_findings').select('kind, camera_id, recorder_id').eq('org_id', o).is('resolved_at', null)
      expect(findings).toEqual([{ kind: 'possible_move', camera_id: loose, recorder_id: r3 }])
      expect((await admin().from('cameras').select('id').eq('location_id', l3).is('archived_at', null)).data).toHaveLength(1)
      // Once more: the same identities, no new camera.
      const j2 = collect()
      const again = await startDiscoverAll({ admin: admin(), rls: u.client }, a, { nvr, schedule: j2.schedule })
      if (!again.ok) throw new Error(again.error)
      await j2.settled()
      const s2 = await discoverAllStatus({ admin: admin(), rls: u.client }, a, again.runId)
      expect(s2.ok && s2.run.summary.created).toBe(0)
      // Door, Till (made by the first run) and the camera made by hand: still three.
      expect((await admin().from('cameras').select('id').eq('org_id', o).is('archived_at', null)).data).toHaveLength(3)
    } finally {
      await cleanupOrg(o)
    }
  })

  it('never asks more NVRs at once than the bound', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const answers: Record<string, Channel[]> = {}
      for (let i = 0; i < 6; i++) {
        const l = await createLocation(o, { code: `BND${i}` })
        await createRecorder(o, l, { host: `192.0.2.${120 + i}`, secret: 'pass' })
        answers[`192.0.2.${120 + i}`] = [{ channel: 1, name: 'Door', ip: null }]
      }
      const { nvr, seen } = fakeNvrs(answers, { delayMs: 40 })
      const j = collect()
      const started = await startDiscoverAll({ admin: admin(), rls: u.client }, a, { nvr, schedule: j.schedule, concurrency: 2 })
      if (!started.ok) throw new Error(started.error)
      await j.settled()
      expect(seen.contacts).toBe(6)
      expect(seen.maxInFlight).toBeLessThanOrEqual(2)
    } finally {
      await cleanupOrg(o)
    }
  })

  it('one run at a time per organisation; the status of another organisation\'s run is not found; progress counts up', async () => {
    const l = await createLocation(orgId, { code: 'ONE1' })
    await createRecorder(orgId, l, { host: '192.0.2.140', secret: 'pass' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const nvr = () => ({ channelStatus: async () => new Map<number, boolean>(), channels: async () => (await gate, [{ channel: 1, name: 'Door', ip: null }]) })
    const j = collect()
    const first = await startDiscoverAll(c(), actor, { nvr, schedule: j.schedule })
    if (!first.ok) throw new Error(first.error)
    expect(await startDiscoverAll(c(), actor, { nvr, schedule: j.schedule })).toEqual({ ok: false, error: MSG_RUN_ACTIVE })
    const during = await discoverAllStatus(c(), actor, first.runId)
    expect(during.ok && during.run.done).toBe(0)
    expect(during.ok && during.run.finishedAt).toBeNull()
    const stranger = await createUser(otherOrg, 'admin')
    await grant(otherOrg, stranger.id, 'admin.inventory')
    expect(await discoverAllStatus(c(stranger), { id: stranger.id, orgId: otherOrg, role: 'admin' }, first.runId)).toEqual({ ok: false, error: MSG_RUN_NOT_FOUND })
    release()
    await j.settled()
    const after = await discoverAllStatus(c(), actor, first.runId)
    expect(after.ok && after.run.done).toBe(after.ok ? after.run.total : -1)
  })

  it('review B-M9: two starts at the same moment make one run (the second is refused before anything is read)', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const l = await createLocation(o, { code: 'RACE1' })
      await createRecorder(o, l, { host: '192.0.2.160', secret: 'pass' })
      const { nvr, seen } = fakeNvrs({ '192.0.2.160': [{ channel: 1, name: 'Door', ip: null }] })
      const j = collect()
      const cl = { admin: admin(), rls: u.client }
      const [x, y] = await Promise.all([startDiscoverAll(cl, a, { nvr, schedule: j.schedule }), startDiscoverAll(cl, a, { nvr, schedule: j.schedule })])
      await j.settled()
      expect([x.ok, y.ok].sort()).toEqual([false, true])
      expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, error: MSG_RUN_ACTIVE })
      expect(seen.contacts).toBe(1)
    } finally {
      await cleanupOrg(o)
    }
  })

  it('review B-M10: "Stop" ends a run between NVRs; the NVRs not asked yet are listed as skipped, never contacted', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const answers: Record<string, Channel[]> = {}
      for (let i = 0; i < 4; i++) {
        const l = await createLocation(o, { code: `STP${i}` })
        await createRecorder(o, l, { host: `192.0.2.${170 + i}`, secret: 'pass' })
        answers[`192.0.2.${170 + i}`] = [{ channel: 1, name: 'Door', ip: null }]
      }
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let asked = 0
      const nvr = (ep: { host: string }) => ({ channelStatus: async () => new Map<number, boolean>(), channels: async () => { asked++; await gate; return answers[ep.host] } })
      const j = collect()
      const cl = { admin: admin(), rls: u.client }
      const started = await startDiscoverAll(cl, a, { nvr, schedule: j.schedule, concurrency: 1 })
      if (!started.ok) throw new Error(started.error)
      await new Promise((r) => setTimeout(r, 300))
      expect(await stopDiscoverAll(cl, a, started.runId)).toEqual({ ok: true })
      release()
      await j.settled()
      const s = await discoverAllStatus(cl, a, started.runId)
      if (!s.ok) throw new Error(s.error)
      expect(asked).toBe(1)
      expect(s.run.stopped).toBe(true)
      expect(s.run.items.filter((i) => i.outcome === 'skipped').map((i) => i.message)).toEqual(Array(3).fill(MSG_STOPPED))
      expect(await stopDiscoverAll(cl, { id: u.id, orgId: orgId, role: 'admin' }, started.runId)).toEqual({ ok: false, error: MSG_RUN_NOT_FOUND })
    } finally {
      await cleanupOrg(o)
    }
  })

  it('inherits the shared login back-off (review I-3): an NVR that refused the login is not asked again by the next run', async () => {
    const o = await createOrg()
    try {
      const u = await createUser(o, 'admin')
      await grant(o, u.id, 'admin.inventory')
      const a: Actor = { id: u.id, orgId: o, role: 'admin' }
      const l = await createLocation(o, { code: 'BOF1' })
      const r = await createRecorder(o, l, { host: '192.0.2.150', secret: 'wrong-pass' })
      const { nvr, seen } = fakeNvrs({ '192.0.2.150': new NvrError('auth', 'refused') })
      const j = collect()
      const one = await startDiscoverAll({ admin: admin(), rls: u.client }, a, { nvr, schedule: j.schedule })
      if (!one.ok) throw new Error(one.error)
      await j.settled()
      expect(seen.contacts).toBe(1)
      const j2 = collect()
      const two = await startDiscoverAll({ admin: admin(), rls: u.client }, a, { nvr, schedule: j2.schedule })
      if (!two.ok) throw new Error(two.error)
      await j2.settled()
      expect(seen.contacts).toBe(1)
      const s = await discoverAllStatus({ admin: admin(), rls: u.client }, a, two.runId)
      expect(s.ok && s.run.items.find((i) => i.recorderId === r)).toMatchObject({ outcome: 'failed', message: MSG_LOGIN_BACKOFF })
    } finally {
      await cleanupOrg(o)
    }
  })
})

describe('P2-5c-2 Wi-Fi inventory (wifi.inventory.view)', () => {
  let orgId: string
  let locA: string
  let locB: string
  let apA: string
  let swA: string
  let apB: string
  let roleOnly: string
  let wifiAtA: TestUser
  let viewer: TestUser
  let itPerson: TestUser

  beforeAll(async () => {
    orgId = await createOrg()
    locA = await createLocation(orgId, { code: 'WFA' })
    locB = await createLocation(orgId, { code: 'WFB' })
    apA = await createAsset(orgId, { locationId: locA, type: 'access_point', name: 'Shop floor AP', ip: '192.0.2.200' })
    await admin().from('assets').update({ vendor: 'NETGEAR', model: 'WAX615', firmware: '10.5.1', management_mode: 'standalone', serial: 'SN-TEST-1', credential_ref: 'wifi:test-ref' }).eq('id', apA)
    swA = await createAsset(orgId, { locationId: locA, type: 'switch', name: 'Rack switch', ip: '192.0.2.201' })
    await createAsset(orgId, { locationId: locA, type: 'server', name: 'Billing server', ip: '192.0.2.202' })
    roleOnly = await createAsset(orgId, { locationId: locA, type: 'other', name: 'Mesh node', ip: '192.0.2.203' })
    await admin().from('assets').update({ role: 'access_point' }).eq('id', roleOnly)
    apB = await createAsset(orgId, { locationId: locB, type: 'access_point', name: 'Other AP', ip: '192.0.2.204' })
    // Reachability from monitoring: the switch answered a moment ago; the AP is down.
    const now = new Date().toISOString()
    const states = await admin().from('check_state').insert([
      { org_id: orgId, target_type: 'device', target_id: swA, status: 'up', last_checked_at: now, last_up_at: now, down_since: null, consecutive_failures: 0 },
      { org_id: orgId, target_type: 'device', target_id: apA, status: 'down', last_checked_at: now, last_up_at: null, down_since: now, consecutive_failures: 3 },
    ])
    expect(states.error).toBeNull()
    wifiAtA = await createUser(orgId, 'user')
    await grant(orgId, wifiAtA.id, 'wifi.inventory.view', atLocation(locA))
    viewer = await createUser(orgId, 'user')
    await grant(orgId, viewer.id, ['cctv.live'])
    itPerson = await createUser(orgId, 'user')
    await grant(orgId, itPerson.id, ['it.inventory.view'], atAsset(apB))
  })
  afterAll(() => cleanupOrg(orgId))

  it('shows the access points, routers and switches of the places the person holds wifi.inventory.view for, with capabilities and reachability', async () => {
    const r = await wifiInventory(wifiAtA.client)
    if (!r.ok) throw new Error(r.error)
    expect(r.items.map((i) => i.name).sort()).toEqual(['Mesh node', 'Rack switch', 'Shop floor AP'])
    const ap = r.items.find((i) => i.id === apA)!
    expect(ap).toMatchObject({ locationCode: 'WFA', kind: 'Wi-Fi access point', vendor: 'NETGEAR', model: 'WAX615', firmware: '10.5.1', managementMode: 'standalone', reachability: 'Not reachable', profile: 'Not assigned' })
    expect(JSON.stringify(ap)).not.toContain('wifi:test-ref')
    // From the documented matrix: WAX615 standalone SSID/security is unverified, and nothing is lab-validated.
    expect(ap.capabilities.find((x) => x.operation === 'ssid_security')).toMatchObject({ support: 'unverified' })
    expect(ap.capabilities.every((x) => x.labValidated === false)).toBe(true)
    expect(r.items.find((i) => i.id === swA)).toMatchObject({ reachability: 'Reachable', capabilities: [] })
    expect(r.items.find((i) => i.id === roleOnly)).toMatchObject({ reachability: 'Not checked yet' })
  })

  it('anyone without wifi.inventory.view is refused; the matrix and the list stay closed to them (rows, not errors, for signed-in people)', async () => {
    expect(await wifiInventory(viewer.client)).toEqual({ ok: false, error: MSG_WIFI_DENIED })
    expect(await wifiInventory(itPerson.client)).toEqual({ ok: false, error: MSG_WIFI_DENIED })
    // P2-5c-2 brief item 4 replaces "device_capabilities is server-only" (P2-5a): signed-in people read it only with wifi.inventory.view.
    expect((await viewer.client.from('device_capabilities').select('id')).data).toEqual([])
    expect((await itPerson.client.from('device_capabilities').select('id')).data).toEqual([])
    expect(((await wifiAtA.client.from('device_capabilities').select('id')).data ?? []).length).toBe(65)
    expect((await viewer.client.rpc('wifi_inventory')).data).toEqual([])
    // Review B-M14: no row AND no error (an error would also give "no rows").
    const it_ = await itPerson.client.rpc('wifi_inventory')
    expect(it_.error).toBeNull()
    expect(it_.data).toEqual([])
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
    expect((await anon.from('device_capabilities').select('id').limit(1)).error?.code).toBe('42501')
    expect((await anon.rpc('wifi_inventory')).error?.code).toBe('42501')
    // Nobody signed in writes the matrix.
    expect((await wifiAtA.client.from('device_capabilities').update({ support: 'supported' }).eq('model', 'WAX615').select('id')).error?.code).toBe('42501')
  })
})
