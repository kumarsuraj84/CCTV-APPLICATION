import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkCameras, type Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { adminClient, cleanupOrg, createOrg, createSite } from '../setup/fixtures'
import { testFence } from '../setup/lease'

const admin = () => adminClient()

// The whole path: real data layer, real probes, fake NVR and fake camera endpoint on loopback.
describe('a wrong NVR password in the database', () => {
  let orgId: string
  let nvr: FakeNvr
  let rtsp: FakeRtsp
  let wrongRecorder: string
  let downRecorder: string
  let wrongCams: string[]
  let downCams: string[]
  let deps: Deps

  beforeAll(async () => {
    orgId = await createOrg()
    nvr = await startFakeNvr({ statuses: { 1: false, 2: true }, password: 'secret-pass' })
    rtsp = await startFakeRtsp('needs-auth', 0, { username: 'viewer', password: 'secret-pass' })
    // P2-5b: two recorders (at two locations) on the same fake NVR, each with its own saved login.
    const mk = (code: string) => createSite(orgId, { code, host: '127.0.0.1', rtspPort: rtsp.port, httpPort: nvr.port, username: 'viewer', secret: 'not-the-password', cameras: 2 })
    const wrong = await mk('LG1')
    const down = await mk('LG2')
    wrongRecorder = wrong.recorderId
    downRecorder = down.recorderId
    wrongCams = wrong.cameraIds
    downCams = down.cameraIds
    // P2-7: the writes carry this file's test lease.
    deps = { db: new SupabaseMonitorDb(admin(), { orgId, fence: await testFence() }), probes: realProbes, cfg: loadMonitorConfig({}), clock: () => new Date() }
  })

  afterAll(async () => {
    await nvr.close()
    await rtsp.close()
    await cleanupOrg(orgId)
  })

  it('creates no status and no outage for the cameras, however many rounds run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) await checkCameras(deps, undefined, [wrongRecorder])
    vi.restoreAllMocks()
    expect(nvr.requests.length).toBeGreaterThan(0)
    expect(nvr.authorizations).toHaveLength(1) // final fix X: one refused login in three rounds
    expect(rtsp.requests).toHaveLength(0)
    const states = await admin().from('check_state').select('target_id').in('target_id', wrongCams)
    const outages = await admin().from('outages').select('id').in('target_id', wrongCams)
    expect(states.data).toEqual([])
    expect(outages.data).toEqual([])
  })

  it('final fix X (review C I-1): one refused login only, no RTSP, and a restarted worker (a new data layer, a new lease) does not ask again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const before = nvr.authorizations.length
    const rtspBefore = rtsp.requests.length
    const restarted: Deps = { ...deps, db: new SupabaseMonitorDb(admin(), { orgId, fence: await testFence() }) }
    for (let i = 0; i < 3; i++) await checkCameras(restarted, undefined, [wrongRecorder])
    vi.restoreAllMocks()
    expect(nvr.authorizations.length).toBe(before)
    expect(rtsp.requests.length).toBe(rtspBefore)
    const st = await admin().from('nvr_login_state' as never).select('outcome, level, last_refused_path').eq('recorder_id', wrongRecorder).single()
    expect(st.data).toEqual({ outcome: 'refused', level: 1, last_refused_path: 'monitoring' })
  })

  it('still marks the cameras of a recorder down at once when that NVR is known to be down, without needing the password', async () => {
    await deps.db.applyResults(orgId, [{ type: 'recorder', id: downRecorder, ok: false, at: new Date().toISOString() }], 1)
    await checkCameras(deps, undefined, [downRecorder])
    const outages = await admin().from('outages').select('target_id, cause').in('target_id', downCams)
    expect(outages.data).toHaveLength(2)
    expect(outages.data?.every((o) => o.cause === 'nvr_down')).toBe(true)
  })
})
