// P5.5 item 1a: the media-path load test, honestly separated from metadata scale (tests/load/metadata-scale.load.test.ts).
//
//   npx vitest run tests/load/media-path.load.test.ts                    CI mode: 10 s ramp, 60 s hold
//   LOAD_MODE=full npx vitest run tests/load/media-path.load.test.ts     full mode: 60 s ramp, 10-minute hold
//   LOAD_SUB / LOAD_MAIN / LOAD_VIEWERS / LOAD_HOPS override the targets (default 100 sub-streams, 20 main streams, 10 viewers, 1 proxy hop)
//
// What runs: a synthetic `test-…` organisation (made and removed here, in the run's ledger) with one camera per stream; viewers made as
// signed-in people with cctv.live; each viewer asks for its wall the application's way (openStreams: capability check, media sessions in
// the real local database, 90 s tokens) and connects one WebSocket per tile to the REAL gateway, which runs in its own process (CPU and
// memory measured apart) with the production registry client and check interval (15 s). Behind it a fake go2rtc video endpoint on
// loopback sends filler "fragments" at camera-like bitrates (sub 512 kbit/s at 15 fps, main 2 Mbit/s at 25 fps, a 5x key frame every 2 s).
// Every socket carries the X-Forwarded-For address Caddy would add for its viewer (one address per viewer), as in production behind the
// one TLS address. Half-way through the hold one viewer loses access: their sockets must close with 4403 within 20 s while the others go on.
//
// Measured: session start (the wall's request → first video fragment), its parts, failures, dropped sessions, stalls (> 3 s without a
// fragment), the gateway's CPU and memory, its event-loop delay, the registry calls (open per socket, still-valid per check) and the cost
// of one token check. Results: docs/drishti/evidence/p5/load-media-<mode>.json. NOT measured: real NVR or camera bandwidth, real go2rtc
// remuxing, real WAN/VPN links, H.265, browsers decoding video (see docs/drishti/evidence/p5/load-test.md).
import { fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { openStreams } from '@/lib/streams/open'
import { createMediaClient } from '@/lib/supabase/service-clients'
import { startFakeGo2rtc, type FakeGo2rtc } from '../helpers/fake-go2rtc'
import { adminClient, cleanupOrg, createCamera, createLocation, createOrg, createRecorder, createUser, grant, ORG_SCOPE, type TestUser } from '../setup/fixtures'
import { startFakeMediaUpstream, type FakeMediaUpstream } from './fake-media-upstream'
import { intEnv, loadMode, machine, round, summary } from './stats'

const MODE = loadMode()
const RAMP_MS = (MODE === 'full' ? 60 : 10) * 1000
const HOLD_MS = (MODE === 'full' ? 600 : 60) * 1000
const SUB = intEnv('LOAD_SUB', 100)
const MAIN = intEnv('LOAD_MAIN', 20)
const VIEWERS = intEnv('LOAD_VIEWERS', 10)
const HOPS = process.env.LOAD_HOPS === '0' ? 0 : 1
const SECRET = 'media-load-test-secret-0123456789abcdef'
const APP = 'http://app.test:3212'
const STALL_MS = 3000
const PROFILES = { sub: { kbps: 512, fps: 15 }, main: { kbps: 2048, fps: 25 } }
const OUT = path.resolve(__dirname, '../../docs/drishti/evidence/p5')

type Tile = {
  viewer: number; camera: string; kind: 'sub' | 'main'; requestedAt: number; tokenAt: number; createdAt: number; openAt?: number; firstAt?: number; lastAt?: number
  bytes: number; frames: number; closed?: { code: number; reason: string; at: number }; failed?: string; stalls: number; ws?: WebSocket
}

describe(`media path under load (${MODE} mode: ${SUB} sub + ${MAIN} main streams, ${VIEWERS} viewers)`, () => {
  let orgId: string
  const cameras: string[] = []
  const viewers: { u: TestUser; grantIds: string[]; ip: string; sub: string[]; main: string[] }[] = []
  let api: FakeGo2rtc
  let upstream: FakeMediaUpstream
  let child: ChildProcess
  let gatewayPort = 0
  const samples: { at: number; cpuPctOfOneCore: number; rssMb: number; heapUsedMb: number; openSessions: number; loopDelayP99Ms: number }[] = []
  const pending = new Map<string, (m: Record<string, unknown>) => void>()
  const savedSecret = process.env.STREAM_TOKEN_SECRET

  const ask = (m: Record<string, unknown>, reply: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(reply, resolve)
      child.send(m)
    })

  beforeAll(async () => {
    process.env.STREAM_TOKEN_SECRET = SECRET
    orgId = await createOrg()
    // One camera per stream, 20 per location and NVR (documentation-free loopback addresses that nothing dials: the fake upstream
    // stands in for go2rtc, and the fake go2rtc API only records the registrations).
    const total = SUB + MAIN
    for (let l = 0; l * 20 < total; l++) {
      const loc = await createLocation(orgId, { name: `Load location ${l + 1}` })
      const rec = await createRecorder(orgId, loc, { host: '127.0.0.1', httpPort: 30_000 + l, rtspPort: 31_000 + l, secret: 'load-nvr-password' })
      for (let ch = 1; ch <= 20 && cameras.length < total; ch++) cameras.push(await createCamera(orgId, { locationId: loc, recorderId: rec, channel: ch, name: `Load camera ${cameras.length + 1}` }))
    }
    const subCams = cameras.slice(0, SUB)
    const mainCams = cameras.slice(SUB, SUB + MAIN)
    for (let v = 0; v < VIEWERS; v++) {
      const u = await createUser(orgId, 'user')
      const grantIds = await grant(orgId, u.id, 'cctv.live', ORG_SCOPE)
      const take = <T>(list: T[]) => list.filter((_, i) => i % VIEWERS === v)
      viewers.push({ u, grantIds, ip: `10.50.${Math.floor(v / 250)}.${(v % 250) + 1}`, sub: take(subCams), main: take(mainCams) })
    }
    api = await startFakeGo2rtc()
    upstream = await startFakeMediaUpstream(PROFILES)
    child = fork(path.join(__dirname, 'gateway-child.ts'), [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, LOAD_STREAM_SECRET: SECRET, LOAD_GATEWAY_CONFIG: JSON.stringify({ go2rtcUrl: upstream.url, origin: APP, hops: HOPS, maxSockets: 1000 }) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    gatewayPort = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the gateway process did not start within 60 s')), 60_000)
      child.on('message', (m: Record<string, unknown>) => {
        if (m.type === 'ready') {
          clearTimeout(t)
          resolve(Number(m.port))
        } else if (m.type === 'sample') samples.push(m as never)
        else pending.get(String(m.type))?.(m)
      })
      child.on('exit', (code) => reject(new Error(`the gateway process ended (${code})`)))
    })
  }, 300_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.send({ type: 'stop' })
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => (child.kill(), resolve()), 5000)
        child.once('exit', () => (clearTimeout(t), resolve()))
      })
    }
    await upstream?.close()
    await api?.close()
    if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET
    else process.env.STREAM_TOKEN_SECRET = savedSecret
    await cleanupOrg(orgId)
  }, 120_000)

  it('ramps up, holds every stream without drops or failures, and ends the revoked viewer\'s streams within 20 s', async () => {
    const tiles: Tile[] = []
    const media = createMediaClient()
    const issue: number[] = []
    // A few seconds with nothing open: the gateway's idle CPU and memory.
    await new Promise((r) => setTimeout(r, 5000))
    const t0 = performance.now()
    const idle = samples.length
    // Ramp: viewers join one after another; each asks for its wall (sub-streams) and its enlarged pictures (main) like the Live screen.
    const ramp = viewers.map(async (v, i) => {
      await new Promise((r) => setTimeout(r, (RAMP_MS * i) / VIEWERS))
      for (const [kind, list] of [['sub', v.sub], ['main', v.main]] as const) {
        if (list.length === 0) continue
        const requestedAt = performance.now()
        const r = await openStreams({ admin: media, rls: v.u.client, go2rtc: api.client, env: {} }, { id: v.u.id, orgId }, list, kind)
        const tokenAt = performance.now()
        issue.push(tokenAt - requestedAt)
        if (!r.ok) {
          for (const camera of list) tiles.push({ viewer: i, camera, kind, requestedAt, tokenAt, createdAt: tokenAt, bytes: 0, frames: 0, stalls: 0, failed: `openStreams: ${r.error}` })
          continue
        }
        for (const s of r.streams) {
          const tile: Tile = { viewer: i, camera: s.cameraId, kind, requestedAt, tokenAt, createdAt: performance.now(), bytes: 0, frames: 0, stalls: 0 }
          tiles.push(tile)
          const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/g/ws?token=${encodeURIComponent(s.token)}`, { origin: APP, headers: HOPS ? { 'X-Forwarded-For': v.ip } : {}, perMessageDeflate: false })
          tile.ws = ws
          ws.on('open', () => {
            tile.openAt = performance.now()
            ws.send(JSON.stringify({ type: 'mse', value: 'avc1.640029,avc1.64002A,avc1.640033' }))
          })
          ws.on('message', (data, isBinary) => {
            if (!isBinary) return
            const now = performance.now()
            if (tile.firstAt === undefined) tile.firstAt = now
            else if (tile.lastAt !== undefined && now - tile.lastAt > STALL_MS) tile.stalls++
            tile.lastAt = now
            tile.frames++
            tile.bytes += (data as Buffer).length
          })
          ws.on('close', (code, reason) => (tile.closed = { code, reason: reason.toString(), at: performance.now() }))
          ws.on('error', (e) => (tile.failed ??= e.message))
        }
      }
    })
    await Promise.all(ramp)
    // Let the last wall's first fragments arrive, then hold.
    await new Promise((r) => setTimeout(r, 3000))
    const holdStart = performance.now()
    const busySamplesFrom = samples.length
    // Half-way: the first viewer's access is taken away (revoke_grant), as an administrator would in the access editor.
    await new Promise((r) => setTimeout(r, HOLD_MS / 2))
    const revokedAt = performance.now()
    expect((await adminClient().rpc('revoke_grant', { p_org: orgId, p_user: viewers[0].u.id, p_grant_ids: viewers[0].grantIds, p_reason: 'load test: revoked under load' })).error).toBeNull()
    // (A gap is counted as a stall when the next fragment comes; a gap that never ends shows as "silent at the end".)
    await new Promise((r) => setTimeout(r, HOLD_MS / 2))
    const holdEnd = performance.now()
    const report = await ask({ type: 'report' }, 'report')
    const bench = await ask({ type: 'bench', n: 50_000 }, 'bench')
    // End: every viewer leaves.
    for (const t of tiles) t.ws?.close(1000)
    await new Promise((r) => setTimeout(r, 1500))

    // ── results ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const revokedViewer = tiles.filter((t) => t.viewer === 0)
    const others = tiles.filter((t) => t.viewer !== 0)
    const started = tiles.filter((t) => t.firstAt !== undefined)
    const failures = tiles.filter((t) => t.firstAt === undefined)
    // Dropped: a stream that had started (a first fragment) and was closed before the end of the hold. A refusal is a failure, not a drop.
    const dropped = others.filter((t) => t.firstAt !== undefined && t.closed && t.closed.at < holdEnd)
    const revocation = revokedViewer.map((t) => (t.closed?.code === 4403 ? t.closed.at - revokedAt : Number.POSITIVE_INFINITY))
    const silentAtEnd = others.filter((t) => t.lastAt !== undefined && holdEnd - t.lastAt > STALL_MS)
    const holdSec = (holdEnd - holdStart) / 1000
    const fragmentsPerSec = (t: Tile) => t.frames / ((holdEnd - (t.firstAt ?? holdEnd)) / 1000 || 1)
    const received = others.reduce((n, t) => n + t.bytes, 0)
    const busy = samples.slice(busySamplesFrom)
    const tm = report.timings as { open: number[]; stillValid: { ms: number; sessions: number }[]; closes: number }
    const result = {
      mode: MODE, at: new Date().toISOString(), machine: machine(),
      workload: {
        viewers: VIEWERS, subStreams: SUB, mainStreams: MAIN, rampSec: RAMP_MS / 1000, holdSec: round(holdSec, 0), profiles: PROFILES, proxyHops: HOPS,
        gatewayCheckEverySec: (report.health as { validateEverySec: number }).validateEverySec,
      },
      sessionStartMs: summary(started.map((t) => t.firstAt! - t.requestedAt)),
      parts: {
        tokenIssueMs: summary(issue), socketOpenMs: summary(started.filter((t) => t.openAt).map((t) => t.openAt! - t.createdAt)),
        openToFirstFragmentMs: summary(started.filter((t) => t.openAt).map((t) => t.firstAt! - t.openAt!)),
      },
      failures: failures.length, failureReasons: [...new Set(failures.map((t) => t.failed ?? (t.closed ? `${t.closed.code} ${t.closed.reason}` : 'no fragment')))],
      droppedDuringHold: dropped.length, droppedReasons: [...new Set(dropped.map((t) => `${t.closed!.code} ${t.closed!.reason}`))],
      stalls: others.reduce((n, t) => n + t.stalls, 0), silentAtEnd: silentAtEnd.length,
      fragmentsPerSecond: { sub: summary(others.filter((t) => t.kind === 'sub').map(fragmentsPerSec)), main: summary(others.filter((t) => t.kind === 'main').map(fragmentsPerSec)) },
      throughputMbitPerSec: round((received * 8) / 1e6 / ((holdEnd - t0) / 1000), 1),
      revocationUnderLoad: { sockets: revokedViewer.length, closeMs: summary(revocation.filter(Number.isFinite)), allClosed4403: revocation.every(Number.isFinite) },
      gateway: {
        idle: samples.slice(0, idle).at(-1) ?? null,
        cpuPctOfOneCore: summary(busy.map((s) => s.cpuPctOfOneCore)), rssMb: summary(busy.map((s) => s.rssMb)), heapUsedMb: summary(busy.map((s) => s.heapUsedMb)),
        loopDelayP99Ms: summary(busy.map((s) => s.loopDelayP99Ms)), openSessionsMax: Math.max(0, ...busy.map((s) => s.openSessions)), events: report.events,
      },
      registry: {
        openMs: summary(tm.open), stillValidMs: summary(tm.stillValid.map((s) => s.ms)), stillValidChecks: tm.stillValid.length,
        stillValidSessionsMax: Math.max(0, ...tm.stillValid.map((s) => s.sessions)), closes: tm.closes,
      },
      tokenCheckMicroseconds: round(Number(bench.usPerVerify), 2),
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, `load-media-${MODE}${HOPS ? '' : '-no-proxy-hops'}.json`), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ media_load: result }))

    expect(tiles).toHaveLength(SUB + MAIN)
    expect(result.failureReasons).toEqual([])
    expect(result.failures).toBe(0)
    expect(result.droppedReasons).toEqual([])
    expect(result.droppedDuringHold).toBe(0)
    expect(result.silentAtEnd).toBe(0)
    expect(result.revocationUnderLoad.allClosed4403).toBe(true)
    expect(result.revocationUnderLoad.closeMs.max!).toBeLessThan(20_000)
    expect(result.sessionStartMs.p95!).toBeLessThan(3000)
  }, 30 * 60_000)
})
