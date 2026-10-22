import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/types'
import { importStores } from '@/lib/import/apply'
import { parseStoresCsv } from '@/lib/import/stores-csv'
import { resolveCameraRoutes } from '@/lib/inventory/recorders'
import { createStore, updateStore } from '@/lib/inventory/stores'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import type { Database } from '@/types/database'
import {
  adminClient, atLocation, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, mapCamera, withRecorders, type TestUser,
} from '../setup/fixtures'

const admin = () => adminClient()
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

/**
 * The service-role client with some calls made to fail: an RPC by name, or every insert into a table. Everything else is the real
 * client. (Used to prove what a half-done save leaves behind.)
 */
function failing(o: { rpc?: string; insertInto?: string }): SupabaseClient<Database> {
  const real = admin()
  const boom = { data: null, error: { message: 'injected failure', code: 'XX000', details: '', hint: '' } }
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'rpc') {
        return (name: string, args: Record<string, unknown>) => (name === o.rpc ? Promise.resolve(boom) : target.rpc(name as never, args as never))
      }
      if (prop === 'from') {
        return (table: string) => {
          const q = target.from(table as never)
          if (table !== o.insertInto) return q
          return new Proxy(q, {
            get(t, p) {
              if (p === 'insert') return () => ({ select: () => ({ single: () => Promise.resolve(boom) }), then: (r: (v: unknown) => unknown) => Promise.resolve(boom).then(r) })
              const v = Reflect.get(t, p)
              return typeof v === 'function' ? v.bind(t) : v
            },
          })
        }
      }
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  }) as SupabaseClient<Database>
}

// P2-5b review round 1 (.superpowers/sdd/drishti/p2-5b-review.md): one test (or more) per finding, written before the fix.
describe('P2-5b review round 1', () => {
  let orgId: string
  let actor: Actor
  let me: TestUser

  const camerasAt = async (loc: string) =>
    (await admin().from('cameras').select('id, name, channel, recorder_id, archived_at').eq('location_id', loc).order('channel').order('id')).data!
  const primaryOf = async (loc: string) => (await admin().rpc('recorder_primary_of', { p_location: loc })).data as string
  const jobsFor = async (recorderId: string) => (await new SupabaseMonitorDb(admin(), { orgId }).loadRecorderJobs([recorderId])).map((j) => j.id)

  beforeAll(async () => {
    orgId = await createOrg()
    me = await createUser(orgId, 'admin')
    actor = { id: me.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  // ═══ I-3 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it('I-3: an archived camera does not come back as a new "Camera N" when the store is saved again or the CSV is imported again', async () => {
    const made = await createStore(admin(), actor, { code: 'PH1', name: 'Placeholders', ip: '192.0.2.150', nvr_user: 'viewer', nvr_password: 'Secret-P1', channels: 3 })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const before = await camerasAt(made.storeId)
    expect(before.map((c) => [c.channel, c.name])).toEqual([[1, 'Camera 1'], [2, 'Camera 2'], [3, 'Camera 3']])
    const third = before[2].id
    expect((await admin().rpc('inventory_archive', { p_org: orgId, p_kind: 'camera', p_id: third })).error).toBeNull()
    expect((await updateStore(admin(), actor, made.storeId, { name: 'Placeholders', ip: '192.0.2.150', nvr_user: 'viewer', channels: 3 })).ok).toBe(true)
    const res = await importStores(admin(), actor, parseStoresCsv('code,name,ip,user,password,channels\nPH1,Placeholders,192.0.2.150,viewer,Secret-P1,3\n').rows)
    expect(res.errors).toEqual([])
    const after = await camerasAt(made.storeId)
    expect(after.filter((c) => c.archived_at === null).map((c) => [c.channel, c.name])).toEqual([[1, 'Camera 1'], [2, 'Camera 2']])
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort()) // nothing new
  })

  it('I-3: a camera moved to another NVR does not leave a new "Camera N" behind on its old channel; more channels still get cameras', async () => {
    const made = await createStore(admin(), actor, { code: 'PH2', name: 'Moved', ip: '192.0.2.151', nvr_user: 'viewer', nvr_password: 'Secret-P2', channels: 2 })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const second = await createRecorder(orgId, made.storeId, { name: 'Second', host: '192.0.2.152' })
    const [c1, c2] = await camerasAt(made.storeId)
    await mapCamera(orgId, c2.id, second, 1)
    expect((await updateStore(admin(), actor, made.storeId, { name: 'Moved', ip: '192.0.2.151', nvr_user: 'viewer', channels: 2 })).ok).toBe(true)
    const primary = await primaryOf(made.storeId)
    const rows = (await camerasAt(made.storeId)).map((c) => [c.id, c.recorder_id, c.channel])
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([[c1.id, primary, 1], [c2.id, second, 1]]))
    // A channel the NVR never had a camera on (the count went up) still gets one.
    expect((await updateStore(admin(), actor, made.storeId, { name: 'Moved', ip: '192.0.2.151', nvr_user: 'viewer', channels: 3 })).ok).toBe(true)
    const now = await camerasAt(made.storeId)
    expect(now.filter((c) => c.recorder_id === primary).map((c) => [c.channel, c.name])).toEqual([[1, 'Camera 1'], [3, 'Camera 3']])
  })

  // ═══ I-4 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it('I-4: an NVR saved while its store is switched off is monitored, watched and played back once the store is switched on', async () => {
    const made = await createStore(admin(), actor, { code: 'OFF1', name: 'Later', ip: '192.0.2.160', nvr_user: 'viewer', nvr_password: 'Secret-O1', channels: 1, is_active: false })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    const rec = await primaryOf(made.storeId)
    expect((await admin().from('assets').select('enabled').eq('id', rec).single()).data?.enabled).toBe(true)
    expect(await jobsFor(rec)).toEqual([]) // the store is off: no job
    expect((await updateStore(admin(), actor, made.storeId, { name: 'Later', ip: '192.0.2.160', nvr_user: 'viewer', channels: 1, is_active: true })).ok).toBe(true)
    expect(await jobsFor(rec)).toEqual([rec])
    const [cam] = await camerasAt(made.storeId)
    expect((await resolveCameraRoutes(admin(), orgId, [cam.id])).get(cam.id)?.kind).toBe('ok')
  })

  it('I-4: switching a store on re-enables its NVRs left switched off by the old rule (asset enabled = store active)', async () => {
    const loc = await createLocation(orgId, { code: 'OFF2' })
    const rec = await createRecorder(orgId, loc, { host: '192.0.2.161' })
    // As the old recorder_save (or the 5a migration) left an NVR of a store that was off.
    expect((await admin().from('locations').update({ is_active: false }).eq('id', loc)).error).toBeNull()
    expect((await admin().from('assets').update({ enabled: false }).eq('id', rec)).error).toBeNull()
    expect((await admin().from('locations').update({ is_active: true }).eq('id', loc)).error).toBeNull()
    expect((await admin().from('assets').select('enabled').eq('id', rec).single()).data?.enabled).toBe(true)
    expect(await jobsFor(rec)).toEqual([rec])
    // An NVR saved again (the form, the CSV) is switched on too.
    expect((await admin().from('assets').update({ enabled: false }).eq('id', rec)).error).toBeNull()
    expect((await admin().rpc('recorder_save', { p_org: orgId, p_location: loc, p_recorder: rec, p_host: '192.0.2.161', p_http_port: 80, p_rtsp_port: 554, p_username: 'viewer' })).error).toBeNull()
    expect((await admin().from('assets').select('enabled').eq('id', rec).single()).data?.enabled).toBe(true)
  })

  // ═══ M-2 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it('M-2: a second NVR of the same store with the same address is refused; the address of another store\'s NVR is saved with a warning', async () => {
    const loc = await createLocation(orgId, { code: 'DUP1' })
    await createRecorder(orgId, loc, { host: '192.0.2.170', httpPort: 80 })
    const same = await admin().rpc('recorder_save', { p_org: orgId, p_location: loc, p_recorder: null as unknown as string, p_host: '192.0.2.170', p_http_port: 80, p_rtsp_port: 554, p_username: 'viewer' })
    expect(same.error?.code).toBe('DR010')
    const made = await createStore(admin(), actor, { code: 'DUP2', name: 'Typo', ip: '192.0.2.170', nvr_user: 'viewer', nvr_password: 'Secret-D2', channels: 0 })
    expect(made).toMatchObject({ ok: true, warning: 'This NVR address is also used by the NVR of another location. Check that it is right.' })
    const res = await importStores(admin(), actor, parseStoresCsv('code,name,ip,user,password,channels\nDUP3,Typo again,192.0.2.170,viewer,Secret-D3,0\n').rows)
    expect(res.errors).toEqual([])
    expect(res.warnings).toEqual([{ line: 2, message: 'This NVR address is also used by the NVR of another location. Check that it is right.' }])
  })

  // ═══ M-6 / M-7 / I-5 (CSV row whose NVR save fails) ═════════════════════════════════════════════════════════════════════════
  it('I-5 / M-6: a CSV row whose NVR cannot be saved leaves nothing behind (new store archived, existing store unchanged) and says so plainly', async () => {
    const res = await importStores(failing({ rpc: 'recorder_save' }), actor, parseStoresCsv('code,name,ip,user,password,channels\nCSVF,Fails,192.0.2.180,viewer,Secret-F,2\n').rows)
    expect(res).toMatchObject({ created: 0, updated: 0, errors: [{ line: 2, message: 'This row could not be saved.' }] })
    expect((await admin().from('locations').select('id').eq('org_id', orgId).eq('code', 'CSVF').is('archived_at', null)).data).toEqual([])
    expect(JSON.stringify(res)).not.toContain('injected')
    // An existing store: its own fields are not changed when its NVR cannot be saved.
    const ok = await importStores(admin(), actor, parseStoresCsv('code,name,ip,user,password,channels\nCSVE,Before,192.0.2.181,viewer,Secret-E,0\n').rows)
    expect(ok.errors).toEqual([])
    const again = await importStores(failing({ rpc: 'recorder_save' }), actor, parseStoresCsv('code,name,city,ip,user,password,channels\nCSVE,After,Pune,192.0.2.182,viewer,Secret-E,0\n').rows)
    expect(again.errors).toEqual([{ line: 2, message: 'This row could not be saved.' }])
    expect((await admin().from('locations').select('name, city').eq('org_id', orgId).eq('code', 'CSVE').single()).data).toEqual({ name: 'Before', city: null })
  })

  it('M-6: when only the cameras could not be made, the CSV row says exactly that (the store and its NVR were saved)', async () => {
    const res = await importStores(failing({ insertInto: 'cameras' }), actor, parseStoresCsv('code,name,ip,user,password,channels\nCAMF,No cameras,192.0.2.183,viewer,Secret-C,2\n').rows)
    expect(res.errors).toEqual([{ line: 2, message: 'The location was saved, but its cameras could not be created. Open the location and save it again.' }])
    expect(res.created).toBe(1)
  })

  it('M-7: an NVR is never created without a password (the form and the CSV, for a store that has no NVR yet)', async () => {
    const loc = await createLocation(orgId, { code: 'NOPW', name: 'No NVR yet' })
    expect(await updateStore(admin(), actor, loc, { name: 'No NVR yet', ip: '192.0.2.190', nvr_user: 'viewer', channels: 2 })).toEqual({ ok: false, error: 'Enter the NVR password.' })
    const res = await importStores(admin(), actor, parseStoresCsv('code,name,ip,user,channels\nNOPW,No NVR yet,192.0.2.190,viewer,2\n').rows)
    expect(res.errors).toEqual([{ line: 2, message: 'This location has no NVR yet: give the password of its NVR.' }])
    expect((await admin().from('recorders').select('id').eq('location_id', loc)).data).toEqual([])
    expect((await admin().from('cameras').select('id').eq('location_id', loc)).data).toEqual([])
  })

  // ═══ M-3 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it('M-3: a late camera result from the camera\'s previous NVR is ignored; one from its current NVR counts', async () => {
    const loc = await createLocation(orgId, { code: 'LATE' })
    const r1 = await createRecorder(orgId, loc, { name: 'One', host: '192.0.2.200' })
    const r2 = await createRecorder(orgId, loc, { name: 'Two', host: '192.0.2.201' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: r1, channel: 1 })
    await mapCamera(orgId, cam, r2, 1)
    const apply = (recorder: string) => admin().rpc('monitor_apply_results', {
      p_org: orgId, p_results: [{ type: 'camera', id: cam, recorder, ok: false, at: ago(1), method: 'nvr_down', cause: 'nvr_down' }], p_threshold: 1,
    })
    expect((await apply(r1)).error).toBeNull()
    expect((await admin().from('check_state').select('id').eq('target_id', cam)).data).toEqual([])
    expect((await admin().from('outages').select('id').eq('target_id', cam)).data).toEqual([])
    expect((await apply(r2)).error).toBeNull()
    expect((await admin().from('check_state').select('status').eq('target_id', cam).single()).data?.status).toBe('down')
  })

  // P2-6 (addendum): the recorder is REQUIRED in a camera result. A result that does not name it is ignored, like one naming another NVR.
  it('P2-6: a camera result without its recorder is ignored; the same result naming it counts', async () => {
    const loc = await createLocation(orgId, { code: 'NOREC' })
    const rec = await createRecorder(orgId, loc, { host: '192.0.2.202' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
    const result = { type: 'camera', id: cam, ok: false, at: ago(1) }
    expect((await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [result], p_threshold: 1 })).error).toBeNull()
    expect((await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [{ ...result, recorder: null }], p_threshold: 1 })).error).toBeNull()
    expect((await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [{ ...result, recorder: 42 }], p_threshold: 1 })).error).toBeNull()
    expect((await admin().from('check_state').select('id').eq('target_id', cam)).data).toEqual([])
    expect((await admin().from('outages').select('id').eq('target_id', cam)).data).toEqual([])
    expect((await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [{ ...result, recorder: rec.toUpperCase() }], p_threshold: 1 })).error).toBeNull()
    expect((await admin().from('check_state').select('status').eq('target_id', cam).single()).data?.status).toBe('down')
  })

  // ═══ M-5 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  it('M-5: switching an NVR\'s asset off stops the monitoring of its cameras too (open outages closed, state forgotten)', async () => {
    const loc = await createLocation(orgId, { code: 'DIS' })
    const rec = await createRecorder(orgId, loc, { host: '192.0.2.210' })
    const cam = await createCamera(orgId, { locationId: loc, recorderId: rec, channel: 1 })
    await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: await withRecorders([{ type: 'camera', id: cam, ok: false, at: ago(5) }]), p_threshold: 1 })
    expect((await admin().from('outages').select('id').eq('target_id', cam).is('ended_at', null)).data).toHaveLength(1)
    expect((await admin().from('assets').update({ enabled: false }).eq('id', rec)).error).toBeNull()
    expect((await admin().from('outages').select('id').eq('target_id', cam).is('ended_at', null)).data).toEqual([])
    expect((await admin().from('check_state').select('id').eq('target_id', cam)).data).toEqual([])
  })

  // ═══ I-5: a recorder moved between locations ════════════════════════════════════════════════════════════════════════════════
  // A recorder is moved by moving its asset (recorders (id, location_id) follows the asset: ON UPDATE CASCADE); updating the recorder row
  // alone is refused by that key.
  it('I-5: an NVR with cameras cannot move to another store; one without cameras moves whole (its asset, status and IT view follow)', async () => {
    const from = await createLocation(orgId, { code: 'MVA' })
    const to = await createLocation(orgId, { code: 'MVB' })
    const busy = await createRecorder(orgId, from, { name: 'Busy', host: '192.0.2.220' })
    await createCamera(orgId, { locationId: from, recorderId: busy, channel: 1 })
    expect((await admin().from('assets').update({ location_id: to }).eq('id', busy)).error?.code).toBe('DR006')
    expect((await admin().from('recorders').select('location_id').eq('id', busy).single()).data?.location_id).toBe(from)
    const empty = await createRecorder(orgId, from, { name: 'Empty', host: '192.0.2.221' })
    await admin().rpc('monitor_apply_results', { p_org: orgId, p_results: [{ type: 'recorder', id: empty, ok: true, at: ago(1) }], p_threshold: 1 })
    const itFrom = await createUser(orgId, 'user')
    const itTo = await createUser(orgId, 'user')
    await grant(orgId, itFrom.id, 'it.monitoring.view', atLocation(from))
    await grant(orgId, itTo.id, 'it.monitoring.view', atLocation(to))
    expect((await itFrom.client.from('recorder_status').select('recorder_id').eq('recorder_id', empty)).data).toHaveLength(1)
    expect((await admin().from('assets').update({ location_id: to }).eq('id', empty)).error).toBeNull()
    expect((await admin().from('recorders').select('location_id').eq('id', empty).single()).data?.location_id).toBe(to)
    expect((await itFrom.client.from('recorder_status').select('recorder_id').eq('recorder_id', empty)).data).toEqual([])
    expect((await itTo.client.from('recorder_status').select('recorder_id, location_id, status').eq('recorder_id', empty).single()).data).toEqual({ recorder_id: empty, location_id: to, status: 'up' })
    const count = async (u: TestUser, loc: string) => (await u.client.from('location_status').select('recorders_total').eq('location_id', loc).single()).data?.recorders_total
    expect(await count(itFrom, from)).toBe(1)
    expect(await count(itTo, to)).toBe(1)
    expect((await new SupabaseMonitorDb(admin(), { orgId }).loadNvrs()).find((j) => j.id === empty)?.location_id).toBe(to)
  })
})
