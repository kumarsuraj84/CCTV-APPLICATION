// P5.5 item 1b: the metadata scale test at the size of the owner's estate, honestly separated from the media path
// (tests/load/media-path.load.test.ts).
//
//   npx vitest run tests/load/metadata-scale.load.test.ts                    CI mode: 60 s of 25 viewers
//   LOAD_MODE=full npx vitest run tests/load/metadata-scale.load.test.ts     full mode: 5 minutes of 25 viewers
//
// A synthetic `test-…` organisation (never the real estate; made and removed here, in the run's ledger): 6 regions of 5 clusters, 216
// locations (200 in clusters, 16 without), one NVR each, 4,637 cameras. The NVRs point at fake NVRs on loopback (tests/helpers/
// fake-servers.ts): 8 that answer (about 6 % of channels offline), 2 that never answer their web port (the 8 s NVR timeout, like an
// NVR whose web service hangs) and every 20th with nothing listening at all (down). Three parts:
//   1. 25 signed-in viewers (10 organisation-wide control-room operators with the IT view, 5 region, 5 cluster, 5 location viewers with
//      CCTV only) refresh, in a closed loop with 1 s think time, what their screens read: the Live landing tree, Home (dashboard and
//      roll-ups), the Locations list, one location page with its camera states, and a cluster wall. Through PostgREST as the person,
//      exactly the queries the pages run (lib/queries/*). The real pages refresh every 60 s, so this is far more than 25 real people.
//   2. EXPLAIN (ANALYZE, BUFFERS) of the key views and functions as an organisation-wide viewer and as a cluster viewer, in a rolled-back
//      transaction (docs/drishti/evidence/p5/load-metadata-explain.txt).
//   3. Two monitoring rounds of the worker's own code (MonitorRunner) in this process, scoped to this organisation with a test lease and no
//      write to the shared worker row: the round duration with the production settings (10 NVRs at a time, 8 s NVR timeout).
// Results: docs/drishti/evidence/p5/load-metadata-<mode>.json.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCapabilities } from '@/lib/auth/capabilities'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { realProbes } from '@/lib/monitor/probes'
import { MonitorRunner } from '@/lib/monitor/runner'
import { SupabaseMonitorDb } from '@/lib/monitor/supabase-db'
import { loadHomeRollups } from '@/lib/queries/home-rollups'
import { getVisibleStore, listVisibleStores } from '@/lib/queries/inventory'
import { getLiveScope } from '@/lib/queries/live'
import { loadLiveLanding } from '@/lib/queries/live-landing'
import { getDashboard, getStates, listStoreStatus } from '@/lib/queries/status'
import { closedPort, startFakeNvr, startFakeRtsp, type FakeNvr, type FakeRtsp } from '../helpers/fake-servers'
import { adminClient, atCluster, atLocation, atRegion, cleanupOrg, createOrg, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'
import { testFence } from '../setup/lease'
import { loadMode, machine, round, summary } from './stats'

const MODE = loadMode()
const VIEW_MS = (MODE === 'full' ? 300 : 60) * 1000
const THINK_MS = 1000
const LOCATIONS = 216
const CAMERAS = 4637
const VIEWERS = 25
const OUT = path.resolve(__dirname, '../../docs/drishti/evidence/p5')
const admin = () => adminClient()

async function insertAll(table: 'locations' | 'cameras', rows: Record<string, unknown>[]): Promise<{ id: string }[]> {
  const out: { id: string }[] = []
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await admin().from(table).insert(rows.slice(i, i + 500) as never).select('id')
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...((data ?? []) as { id: string }[]))
  }
  return out
}

describe(`metadata at the size of the estate (${MODE} mode: ${LOCATIONS} locations, ${CAMERAS} cameras, ${VIEWERS} viewers)`, () => {
  let orgId: string
  let regionIds: string[] = []
  let clusterIds: string[] = []
  let locationIds: string[] = []
  const recorders: string[] = []
  const viewers: { kind: string; u: TestUser; sample: string }[] = []
  const fakes: { nvr: FakeNvr[]; slow: FakeNvr[]; rtsp: FakeRtsp[] } = { nvr: [], slow: [], rtsp: [] }
  const result: Record<string, unknown> = { mode: MODE, machine: machine() }

  beforeAll(async () => {
    const statuses: Record<number, boolean> = {}
    for (let ch = 1; ch <= 30; ch++) statuses[ch] = ch % 17 !== 0
    for (let i = 0; i < 8; i++) fakes.nvr.push(await startFakeNvr({ statuses, channels: Object.keys(statuses).map((c) => ({ channel: Number(c), name: `Channel ${c}` })) }))
    for (let i = 0; i < 2; i++) fakes.slow.push(await startFakeNvr({ mode: 'slow' }))
    for (let i = 0; i < 10; i++) fakes.rtsp.push(await startFakeRtsp('refuse'))
    const deadHttp = await closedPort()
    const deadRtsp = await closedPort()

    orgId = await createOrg()
    const t = performance.now()
    regionIds = ((await admin().from('regions').insert(Array.from({ length: 6 }, (_, i) => ({ org_id: orgId, code: `MR${i}`, name: `Scale region ${i + 1}` }))).select('id')).data ?? []).map((r) => r.id)
    clusterIds = ((await admin().from('clusters').insert(Array.from({ length: 30 }, (_, i) => ({ org_id: orgId, region_id: regionIds[i % 6], code: `MC${i}`, name: `Scale cluster ${i + 1}` }))).select('id')).data ?? []).map((c) => c.id)
    locationIds = (await insertAll('locations', Array.from({ length: LOCATIONS }, (_, i) => ({
      org_id: orgId, code: `ML${String(i).padStart(3, '0')}`, name: `Scale location ${i + 1}`, city: `City ${i % 40}`, kind: 'store', cluster_id: i < 200 ? clusterIds[i % 30] : null,
    })))).map((l) => l.id)
    for (let i = 0; i < LOCATIONS; i++) {
      // Every 20th NVR is down (nothing listens), every 20th from the 10th never answers its web port, the rest answer.
      const down = i % 20 === 0
      const slow = i % 20 === 10
      const http = down ? deadHttp : slow ? fakes.slow[i % 2].port : fakes.nvr[i % 8].port
      const rtsp = down ? deadRtsp : fakes.rtsp[i % 10].port
      const { data, error } = await admin().rpc('recorder_save', {
        p_org: orgId, p_location: locationIds[i], p_recorder: null as unknown as string, p_host: '127.0.0.1', p_http_port: http, p_rtsp_port: rtsp,
        p_username: 'viewer', p_expected_channels: 0, p_name: `NVR ${i + 1}`,
      })
      if (error) throw new Error(`recorder_save: ${error.message}`)
      recorders.push(data as string)
      const cred = await admin().rpc('recorder_store_credential', { p_recorder: data as string, p_secret: 'secret-pass' })
      if (cred.error) throw new Error(`credential: ${cred.error.message}`)
    }
    const cams: Record<string, unknown>[] = []
    for (let i = 0; i < CAMERAS; i++) {
      const l = i % LOCATIONS
      cams.push({ org_id: orgId, location_id: locationIds[l], recorder_id: recorders[l], channel: Math.floor(i / LOCATIONS) + 1, name: `Camera ${i + 1}`, is_active: true })
    }
    await insertAll('cameras', cams)
    expect((await admin().rpc('inventory_refresh_statistics')).error).toBeNull()
    for (let v = 0; v < VIEWERS; v++) {
      const kind = v < 10 ? 'organisation (control room, IT view)' : v < 15 ? 'region' : v < 20 ? 'cluster' : 'location (CCTV only)'
      const u = await createUser(orgId, v < 10 ? 'operator' : 'user')
      if (v < 10) await grant(orgId, u.id, ['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'], ORG_SCOPE)
      else if (v < 15) await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atRegion(regionIds[v % 6]))
      else if (v < 20) await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atCluster(clusterIds[v]))
      else await grant(orgId, u.id, ['cctv.live', 'cctv.playback'], atLocation(locationIds[v * 7]))
      // The location page each viewer opens: one they can see (their cluster's / region's first location, or their own).
      const sample = v < 10 ? locationIds[v * 13] : v < 15 ? locationIds[clusterIds.indexOf(clusterIds[v % 6])] : v < 20 ? locationIds[v] : locationIds[v * 7]
      viewers.push({ kind, u, sample })
    }
    result.setupSec = round((performance.now() - t) / 1000, 0)
  }, 900_000)

  afterAll(async () => {
    for (const f of [...fakes.nvr, ...fakes.slow, ...fakes.rtsp]) await f.close()
    await cleanupOrg(orgId)
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, `load-metadata-${MODE}.json`), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ metadata_load: result }))
  }, 900_000)

  it('the synthetic estate has the size of the real one', async () => {
    const count = async (t: 'locations' | 'cameras' | 'recorders') => (await admin().from(t).select('id', { count: 'exact', head: true }).eq('org_id', orgId)).count
    expect([await count('locations'), await count('recorders'), await count('cameras')]).toEqual([LOCATIONS, LOCATIONS, CAMERAS])
  })

  it('the worker\'s monitoring round over 216 NVRs and 4,637 cameras with fake NVRs (production settings)', async () => {
    class ScopedDb extends SupabaseMonitorDb {
      override async markRound(): Promise<void> {} // the shared worker row (Home "last checked") is not touched
    }
    const cfg = loadMonitorConfig({})
    const runner = new MonitorRunner({ db: new ScopedDb(admin(), { orgId, fence: await testFence() }), probes: realProbes, cfg, clock: () => new Date() })
    const rounds: { devicesSec: number | null; camerasSec: number | null }[] = []
    for (let i = 0; i < 2; i++) {
      let t = performance.now()
      await runner.runDevices()
      const devicesSec = round((performance.now() - t) / 1000, 1)
      t = performance.now()
      await runner.runCameras()
      rounds.push({ devicesSec, camerasSec: round((performance.now() - t) / 1000, 1) })
    }
    const states = async (type: string, status: string) =>
      (await admin().from('check_state').select('target_id', { count: 'exact', head: true }).eq('org_id', orgId).eq('target_type', type).eq('status', status)).count ?? 0
    const nvrsDown = await states('recorder', 'down')
    const camerasUp = await states('camera', 'up')
    const camerasDown = await states('camera', 'down')
    result.workerRound = {
      settings: { recorderConcurrency: cfg.recorderConcurrency, rtspPerRecorder: cfg.rtspPerRecorder, nvrTimeoutMs: cfg.nvrTimeoutMs, tcpTimeoutMs: cfg.tcpTimeoutMs, failThreshold: cfg.failThreshold },
      fakes: { answering: 8, neverAnswering: 2, recordersDown: Math.ceil(LOCATIONS / 20), recordersHanging: Math.floor((LOCATIONS - 10) / 20) + 1 },
      rounds, after: { recordersDown: nvrsDown, camerasUp, camerasDown },
      checksPerSecond: rounds[1].camerasSec ? round(CAMERAS / rounds[1].camerasSec, 0) : null,
    }
    expect(nvrsDown).toBe(Math.ceil(LOCATIONS / 20))
    expect(camerasUp + camerasDown).toBeGreaterThan(CAMERAS * 0.9)
    // The cameras round must fit well inside the 300 s camera interval (CAMERA_CHECK_SEC) at this size.
    expect(rounds[1].camerasSec!).toBeLessThan(300)
  }, 900_000)
  it('25 viewers refreshing the tree, Live landing, Home, Locations, a location page and a cluster wall: p95 per screen under 1 s', async () => {
    const times: Record<string, number[]> = { live_landing: [], home: [], locations_list: [], location_page: [], cluster_wall: [], summary: [] }
    const errors: string[] = []
    const end = performance.now() + VIEW_MS
    let cycles = 0
    const timed = async (name: string, fn: () => Promise<unknown>) => {
      const t = performance.now()
      try {
        await fn()
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
      times[name].push(performance.now() - t)
    }
    await Promise.all(viewers.map(async (v, i) => {
      await new Promise((r) => setTimeout(r, (i * THINK_MS) / VIEWERS)) // spread the first requests over a second
      while (performance.now() < end) {
        const c = v.u.client
        let caps = await readCapabilities(c)
        await timed('summary', async () => (caps = await readCapabilities(c)))
        await timed('live_landing', () => loadLiveLanding(c, caps, {}))
        await timed('home', () => Promise.all([getDashboard(c), loadHomeRollups(c, caps)]))
        await timed('locations_list', () => Promise.all([listVisibleStores(c), listStoreStatus(c)]))
        await timed('location_page', async () => {
          const store = await getVisibleStore(c, v.sample)
          if (!store) throw new Error('location not visible')
          await getStates(c, 'camera', store.cameras.map((x) => x.id))
        })
        await timed('cluster_wall', () => getLiveScope(c, { cluster: clusterIds[i % 30] }, 'cctv.live'))
        cycles++
        await new Promise((r) => setTimeout(r, THINK_MS))
      }
    }))
    const screens = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, summary(v)]))
    result.viewers = { count: VIEWERS, mix: [...new Set(viewers.map((v) => v.kind))], durationSec: VIEW_MS / 1000, thinkMs: THINK_MS, cycles, errors: errors.length, screensMs: screens }
    expect(errors).toEqual([])
    for (const [k, s] of Object.entries(screens)) expect(s.p95!, k).toBeLessThan(1000)
  }, 900_000)

  it('EXPLAIN (ANALYZE, BUFFERS) of the key views and functions as an organisation-wide viewer and as a cluster viewer (rolled back)', () => {
    const who = [viewers[0], viewers[15]]
    const cams = '(SELECT array_agg(id) FROM (SELECT id FROM public.cameras ORDER BY id LIMIT 25) x)'
    const statements = [
      ['location_status (Locations list, Home)', 'SELECT * FROM public.location_status'],
      ["status_rollups('cctv.live') (Live tree, Home cards)", "SELECT * FROM public.status_rollups('cctv.live')"],
      ['recorder_status (NVR states, IT view)', 'SELECT * FROM public.recorder_status'],
      ['cameras under row security (any CCTV right)', 'SELECT id, location_id, name FROM public.cameras'],
      ['my_access_summary() (every request)', 'SELECT * FROM public.my_access_summary()'],
      ["cameras_with_capability('cctv.live', 25 ids) (opening a wall)", `SELECT public.cameras_with_capability('cctv.live', ${cams})`],
    ]
    let sql = '\\pset pager off\n'
    for (const v of who) {
      sql += `BEGIN;\nSET LOCAL ROLE authenticated;\nSELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: v.u.id, role: 'authenticated', aal: 'aal1' })}', true);\n`
      for (const [label, q] of statements) sql += `\\echo '--- ${v.kind}: ${label.replace(/'/g, '')} ---'\nEXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) ${q};\n`
      sql += 'ROLLBACK;\n'
    }
    const r = spawnSync('docker', ['exec', '-i', 'supabase_db_cctv_hub', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    // Ids of synthetic people and rows are not secrets, but they mean nothing outside this run: they are replaced.
    const text = r.stdout.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, 'load-metadata-explain.txt'), `# EXPLAIN (ANALYZE, BUFFERS) — synthetic estate of ${LOCATIONS} locations, ${CAMERAS} cameras (${new Date().toISOString()})\n${text}`)
    const exec = [...text.matchAll(/Execution Time: ([\d.]+) ms/g)].map((m) => Number(m[1]))
    expect(exec).toHaveLength(statements.length * who.length)
    result.explainExecutionMs = Object.fromEntries(who.flatMap((v, wi) => statements.map(([label], si) => [`${v.kind}: ${label}`, exec[wi * statements.length + si]])))
  }, 180_000)

})
