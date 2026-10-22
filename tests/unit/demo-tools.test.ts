import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { passwordSchema } from '@/lib/validation/password'
import {
  ADMIN_BASELINE,
  DEFAULT_NVR_PORT,
  DEMO_ORG_NAME,
  DEMO_ROLES,
  DEMO_SLUG,
  FAKE_RTSP_2_PORT,
  LOOPBACK,
  SECOND_NVR_PORT,
  demoEmail,
  demoGrants,
  demoPlan,
  isDemoOrg,
  makePassword,
  parseFakeNvrArgs,
  parseNvrPort,
} from '../../scripts/lib/demo'
import { findClosedPorts, isPortClosed } from '../../scripts/lib/ports'
import { closedPort, startFakeNvr, startFakeRtsp, startFakeTcp } from '../helpers/fake-servers'

describe('fake NVR options', () => {
  it('uses the default ports (two pretend NVRs, P2-5b) and no flipping when nothing is given', () => {
    expect(parseFakeNvrArgs([], {})).toEqual({ port: DEFAULT_NVR_PORT, secondPort: SECOND_NVR_PORT, flip: false })
  })

  it('takes --port in both spellings, --flip, and FAKE_NVR_PORT', () => {
    expect(parseFakeNvrArgs(['--port=8100', '--flip'], {})).toEqual({ port: 8100, secondPort: SECOND_NVR_PORT, flip: true })
    expect(parseFakeNvrArgs(['--port', '8101'], {}).port).toBe(8101)
    expect(parseFakeNvrArgs([], { FAKE_NVR_PORT: '8102' }).port).toBe(8102)
    expect(parseFakeNvrArgs(['--port=8103'], { FAKE_NVR_PORT: '8102' }).port).toBe(8103)
  })

  it('takes --second-port for the second pretend NVR, which must differ from the first', () => {
    expect(parseFakeNvrArgs(['--second-port=8110'], {}).secondPort).toBe(8110)
    expect(parseFakeNvrArgs(['--second-port', '8111'], {}).secondPort).toBe(8111)
    expect(() => parseFakeNvrArgs(['--port=8110', '--second-port=8110'], {})).toThrow(/differ/)
    expect(() => parseFakeNvrArgs(['--second-port=8554'], {})).toThrow()
  })

  it('has no way to choose an address: every address option is refused', () => {
    for (const a of ['--host=0.0.0.0', '--host', '--bind=192.168.1.5', '--listen=0.0.0.0:8081', '--address=10.0.0.1', '--interface=eth0', '--hostname=x', '--ip=10.1.1.1']) {
      expect(() => parseFakeNvrArgs([a, '0.0.0.0'], {}), a).toThrow(/127\.0\.0\.1/)
    }
    expect(() => parseFakeNvrArgs(['--whatever'], {})).toThrow(/Unknown option/)
    // An address is not a port either.
    expect(() => parseFakeNvrArgs(['--port=0.0.0.0:8081'], {})).toThrow()
    expect(() => parseFakeNvrArgs(['--port=192.168.1.5'], {})).toThrow()
  })

  it('refuses ports that make no sense or that the demo uses for something else', () => {
    for (const bad of ['0', '80', '1023', '65536', '-1', 'abc', '8081.5', '', ' ', '8554', '9101', '8082']) expect(() => parseNvrPort(bad), bad).toThrow()
    expect(parseNvrPort('1024')).toBe(1024)
    expect(parseNvrPort(65535)).toBe(65535)
  })

  it('the fake servers really listen on 127.0.0.1, whichever port they are started on', async () => {
    const started = [await startFakeNvr({ port: 0 }), await startFakeRtsp('open', 0), await startFakeTcp(0)]
    try {
      for (const s of started) {
        expect(s.host).toBe('127.0.0.1')
        expect(s.port).toBeGreaterThan(0)
      }
    } finally {
      await Promise.all(started.map((s) => s.close()))
    }
  })

  it('the fake servers can only listen on 127.0.0.1 (source check)', () => {
    const source = readFileSync('tests/helpers/fake-servers.ts', 'utf8')
    const listens = source.split('\n').filter((l) => l.includes('.listen('))
    expect(listens.length).toBeGreaterThanOrEqual(3)
    for (const l of listens) expect(l).toContain("'127.0.0.1'")
    // And the demo script does not pass an address of its own.
    expect(readFileSync('scripts/fake-nvr.ts', 'utf8')).not.toMatch(/0\.0\.0\.0|\.listen\(/)
  })
})

describe('demo data plan', () => {
  it('points only at this computer and says DEMO everywhere', () => {
    const plan = demoPlan()
    expect(plan.stores.map((s) => s.code)).toEqual(['DEMO1', 'DEMO2', 'DEMO3'])
    for (const s of plan.stores) expect(s.name.startsWith('Demo ')).toBe(true)
    // T-1 (ruling T-1): the demo places are locations, not stores.
    expect(plan.stores.map((s) => s.name)).toEqual(['Demo location Patna', 'Demo location Ranchi', 'Demo location Gaya'])
    expect(JSON.stringify(plan.stores.map((s) => s.name)).toLowerCase()).not.toContain('store')
    for (const d of plan.devices) expect(d.name.startsWith('Demo ')).toBe(true)
    expect(LOOPBACK).toBe('127.0.0.1')
    const source = readFileSync('scripts/seed-demo.ts', 'utf8') + readFileSync('scripts/lib/demo.ts', 'utf8')
    // Every IPv4 address written in the seed code is the loopback one, or a documentation address (192.0.2.x, never connected to).
    for (const ip of source.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []) expect(['127.0.0.1', '192.0.2.1']).toContain(ip)
  })

  it('has no two devices on the same address and port (the database refuses duplicates)', () => {
    const ports = demoPlan().devices.map((d) => d.port)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('follows a chosen NVR port, and refuses a clashing one', () => {
    expect(demoPlan(8100).stores.find((s) => s.code === 'DEMO1')!.recorders.map((r) => r.httpPort)).toEqual([8100])
    expect(() => demoPlan(8082)).toThrow()
  })

  // P2-5b (brief): a demo location with TWO pretend NVRs on different loopback ports, one of them down; every other location has one NVR.
  const dead = { nvrHttp: 50_001, nvrRtsp: 50_002, device: 50_003, nvr2Http: 50_004, nvr2Rtsp: 50_005 }
  it('DEMO3 has two NVRs on different ports with the same channel numbers: the second pretend NVR (up) and one nobody answers (down)', () => {
    const plan = demoPlan(8100, dead, 8110)
    const demo3 = plan.stores.find((s) => s.code === 'DEMO3')!
    expect(demo3.recorders.map((r) => [r.name, r.httpPort, r.rtspPort])).toEqual([['NVR 1', 8110, FAKE_RTSP_2_PORT], ['NVR 2', dead.nvr2Http, dead.nvr2Rtsp]])
    expect(demo3.recorders.every((r) => r.cameras > 0)).toBe(true)
    for (const s of plan.stores.filter((x) => x.code !== 'DEMO3')) expect(s.recorders).toHaveLength(1)
    // No two NVRs of the demo share an address and port (each is its own box).
    const all = plan.stores.flatMap((s) => s.recorders.flatMap((r) => [r.httpPort, r.rtspPort]))
    expect(new Set(all).size).toBe(all.length)
  })

  it('puts the NVRs that are down on DEMO2 and on DEMO3\'s second NVR only, and the offline device on the footfall counter only', () => {
    const plan = demoPlan(8100, dead, 8110)
    const down = plan.stores.flatMap((s) => s.recorders.filter((r) => r.httpPort === dead.nvrHttp || r.httpPort === dead.nvr2Http).map((r) => `${s.code}/${r.name}`))
    expect(down).toEqual(['DEMO2/NVR 1', 'DEMO3/NVR 2'])
    expect(plan.stores.find((s) => s.code === 'DEMO2')!.recorders.map((r) => [r.httpPort, r.rtspPort])).toEqual([[dead.nvrHttp, dead.nvrRtsp]])
    expect(plan.stores.find((s) => s.code === 'DEMO1')!.recorders.map((r) => [r.httpPort, r.rtspPort])).toEqual([[8100, 8554]])
    expect(plan.devices.filter((d) => d.port === dead.device).map((d) => d.name)).toEqual(['Demo footfall counter'])
    // Every other device points at a port the pretend servers open.
    expect(plan.devices.filter((d) => d.port !== dead.device).map((d) => d.port)).toEqual([9101, 9102, 9103])
  })

  it('the offline ports must differ from each other and from the ports the pretend servers use', () => {
    expect(() => demoPlan(8100, { ...dead, nvrRtsp: dead.nvrHttp })).toThrow()
    expect(() => demoPlan(8100, { ...dead, nvrHttp: 8100 })).toThrow()
    expect(() => demoPlan(8100, { ...dead, nvrRtsp: 8554 })).toThrow()
    expect(() => demoPlan(8100, { ...dead, device: 9101 })).toThrow()
    expect(() => demoPlan(8100, { ...dead, nvr2Http: dead.nvrHttp })).toThrow()
    expect(() => demoPlan(8100, { ...dead, nvr2Rtsp: FAKE_RTSP_2_PORT })).toThrow()
    expect(() => demoPlan(8100, dead, 8100)).toThrow()
  })
})

describe('ports that nothing listens on', () => {
  it('tells an open port from a closed one', async () => {
    const open = await startFakeTcp(0)
    try {
      expect(await isPortClosed(open.port)).toBe(false)
    } finally {
      await open.close()
    }
    expect(await isPortClosed(await closedPort())).toBe(true)
  })

  it('finds distinct closed ports and keeps away from the ones it is told to avoid', async () => {
    const avoid = new Set([8081, 8554])
    const found = await findClosedPorts(3, avoid)
    expect(new Set(found).size).toBe(3)
    for (const p of found) {
      expect(avoid.has(p)).toBe(false)
      expect(p).toBeGreaterThanOrEqual(1024)
      expect(await isPortClosed(p)).toBe(true)
    }
  })
})

describe('demo accounts and reset', () => {
  it('passwords are random, long enough, and meet the rule', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const p = makePassword()
      expect(passwordSchema.safeParse(p).success).toBe(true)
      expect(p.length).toBeGreaterThanOrEqual(16)
      seen.add(p)
    }
    expect(seen.size).toBe(200)
  })

  it('demo e-mail addresses cannot belong to a real person', () => {
    for (const r of DEMO_ROLES) expect(demoEmail(r)).toMatch(/^demo\.[a-z-]+@demo\.example\.test$/)
  })

  // P2-1: the demo operator is demo.operator (AC-15), and every demo person's access is explicit grants (AC-1, AC-8).
  it('the demo people are user, operator, manager, admin and platform owner', () => {
    expect(DEMO_ROLES).toEqual(['user', 'operator', 'manager', 'admin', 'platform_owner'])
    expect(demoEmail('operator')).toBe('demo.operator@demo.example.test')
  })

  it('each demo person gets explicit grants: the viewer CCTV only, the manager scoped, administrators the organisation', () => {
    const plan = demoPlan()
    const codes = plan.stores.map((s) => s.code)
    const of = (role: (typeof DEMO_ROLES)[number]) => demoGrants(role, codes)
    expect(of('user')).toEqual([{ capabilities: ['cctv.live', 'cctv.playback'], scope: { stores: ['DEMO1', 'DEMO2'] } }])
    const op = of('operator')
    expect(op.flatMap((g) => g.capabilities)).toEqual(expect.arrayContaining(['cctv.live', 'it.monitoring.operate']))
    expect(op.every((g) => g.scope !== 'organization')).toBe(true)
    const manager = of('manager')
    expect(manager.every((g) => g.scope !== 'organization')).toBe(true) // a manager is not global any more
    expect(manager.flatMap((g) => g.capabilities)).toEqual(expect.arrayContaining(['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view']))
    for (const r of ['admin', 'platform_owner'] as const) {
      expect(of(r).every((g) => g.scope === 'organization')).toBe(true)
      expect(of(r).flatMap((g) => g.capabilities)).toEqual(expect.arrayContaining(['cctv.live', 'cctv.playback', 'cctv.export', 'admin.users', 'admin.access']))
    }
    // The viewer never gets IT access, and nobody gets the high-risk IT capabilities.
    expect(of('user').flatMap((g) => g.capabilities).some((c) => c.startsWith('it.'))).toBe(false)
    for (const r of DEMO_ROLES) for (const g of of(r)) for (const c of g.capabilities) expect(['it.remote.control', 'it.script.run', 'it.credentials.admin']).not.toContain(c)
    // Every store named exists in the plan.
    for (const r of DEMO_ROLES) for (const g of of(r)) if (g.scope !== 'organization') for (const s of g.scope.stores) expect(codes).toContain(s)
  })

  it('the dev admin script grants the same administrator set (source check)', () => {
    const src = readFileSync('scripts/create-dev-admin.mjs', 'utf8')
    for (const c of ADMIN_BASELINE) expect(src, c).toContain(`'${c}'`)
    expect(src).toContain("rpc('grant_access'")
  })

  it('reset recognises only the demo organisation', () => {
    expect(isDemoOrg({ slug: DEMO_SLUG, name: DEMO_ORG_NAME })).toBe(true)
    expect(isDemoOrg({ slug: 'citykart', name: 'CityKart' })).toBe(false)
    expect(isDemoOrg({ slug: DEMO_SLUG, name: 'CityKart' })).toBe(false)
    expect(isDemoOrg({ slug: 'demo', name: 'DEMO something' })).toBe(false)
    expect(isDemoOrg({ slug: `${DEMO_SLUG}-2`, name: DEMO_ORG_NAME })).toBe(false)
  })
})
