import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { passwordSchema } from '@/lib/validation/password'
import {
  DEFAULT_NVR_PORT,
  DEMO_ORG_NAME,
  DEMO_SLUG,
  LOOPBACK,
  demoEmail,
  demoPlan,
  isDemoOrg,
  makePassword,
  parseFakeNvrArgs,
  parseNvrPort,
} from '../../scripts/lib/demo'

describe('fake NVR options', () => {
  it('uses the default port and no flipping when nothing is given', () => {
    expect(parseFakeNvrArgs([], {})).toEqual({ port: DEFAULT_NVR_PORT, flip: false })
  })

  it('takes --port in both spellings, --flip, and FAKE_NVR_PORT', () => {
    expect(parseFakeNvrArgs(['--port=8100', '--flip'], {})).toEqual({ port: 8100, flip: true })
    expect(parseFakeNvrArgs(['--port', '8101'], {}).port).toBe(8101)
    expect(parseFakeNvrArgs([], { FAKE_NVR_PORT: '8102' }).port).toBe(8102)
    expect(parseFakeNvrArgs(['--port=8103'], { FAKE_NVR_PORT: '8102' }).port).toBe(8103)
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

  it('the fake servers can only listen on 127.0.0.1', () => {
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
    expect(demoPlan(8100).stores.filter((s) => s.code !== 'DEMO2').every((s) => s.httpPort === 8100)).toBe(true)
    expect(() => demoPlan(8082)).toThrow()
  })

  it('one store has its NVR down and one device is offline', () => {
    const plan = demoPlan()
    const live = new Set(plan.stores.map((s) => s.httpPort))
    expect(live.size).toBe(2) // the live NVR port and the dead one
    expect(plan.devices.some((d) => d.port === 9199)).toBe(true)
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
    for (const r of ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const) expect(demoEmail(r)).toMatch(/^demo\.[a-z-]+@demo\.example\.test$/)
  })

  it('reset recognises only the demo organisation', () => {
    expect(isDemoOrg({ slug: DEMO_SLUG, name: DEMO_ORG_NAME })).toBe(true)
    expect(isDemoOrg({ slug: 'citykart', name: 'CityKart' })).toBe(false)
    expect(isDemoOrg({ slug: DEMO_SLUG, name: 'CityKart' })).toBe(false)
    expect(isDemoOrg({ slug: 'demo', name: 'DEMO something' })).toBe(false)
    expect(isDemoOrg({ slug: `${DEMO_SLUG}-2`, name: DEMO_ORG_NAME })).toBe(false)
  })
})
