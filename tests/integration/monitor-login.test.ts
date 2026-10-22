import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { adminClient, cleanupOrg, createOrg } from '../setup/fixtures'

const admin = () => adminClient()

// The whole path: real data layer, real probes, fake NVR and fake camera endpoint on loopback.
describe('a wrong NVR password in the database', () => {
  let orgId: string
  let nvr: FakeNvr
  let rtsp: FakeRtsp
  let wrongStore: string
  let downStore: string
  let wrongCams: string[]
  let downCams: string[]
  let deps: Deps

  beforeAll(async () => {
    orgId = await createOrg()
    nvr = await startFakeNvr({ statuses: { 1: false, 2: true }, password: 'secret-pass' })
    rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: 'secret-pass' })
    const a = admin()
    const mk = async (code: string, ip: string) =>
      (await a.from('stores').insert({ org_id: orgId, code, name: code, nvr_ip: ip, rtsp_port: rtsp.port, http_port: nvr.port, nvr_username: 'viewer' }).select('id').single()).data!.id
    wrongStore = await mk('LG1', '127.0.0.1')
    downStore = await mk('LG2', '127.0.0.1')
    await a.rpc('nvr_store_credential', { p_store: wrongStore, p_secret: 'not-the-password' })
    await a.rpc('nvr_store_credential', { p_store: downStore, p_secret: 'not-the-password' })
    const cams = async (store: string) =>
      (await a.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: store, channel: n, name: `C${n}` }))).select('id, channel').order('channel')).data!.map((c) => c.id)
    wrongCams = await cams(wrongStore)
    downCams = await cams(downStore)
    deps = { db: new SupabaseMonitorDb(admin(), { orgId }), probes: realProbes, cfg: loadMonitorConfig({}), clock: () => new Date() }
  })

  afterAll(async () => {
    await nvr.close()
    await rtsp.close()
    await cleanupOrg(orgId)
  })

  it('creates no status and no outage for the cameras, however many rounds run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) await checkCameras(deps, undefined, [wrongStore])
    vi.restoreAllMocks()
    expect(nvr.requests.length).toBeGreaterThan(0)
    const states = await admin().from('check_state').select('target_id').in('target_id', wrongCams)
    const outages = await admin().from('outages').select('id').in('target_id', wrongCams)
    expect(states.data).toEqual([])
    expect(outages.data).toEqual([])
  })

  it('still marks the cameras of a store down at once when its NVR is known to be down, without needing the password', async () => {
    await deps.db.applyResults(orgId, [{ type: 'nvr', id: downStore, ok: false, at: new Date().toISOString() }], 1)
    await checkCameras(deps, undefined, [downStore])
    const outages = await admin().from('outages').select('target_id, cause').in('target_id', downCams)
    expect(outages.data).toHaveLength(2)
    expect(outages.data?.every((o) => o.cause === 'nvr_down')).toBe(true)
  })
})
