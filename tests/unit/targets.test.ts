import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addressClass, checkTarget, connectRefusal, forgetTargetsForTest, MSG_DNS_CHANGED, MSG_NOT_REGISTERED, MSG_PORT_MISMATCH, registerEndpoints, sourceRefusal,
} from '@/lib/security/targets'
import { tcpCheck } from '@/lib/probes'
import { rtspDescribe } from '@/lib/rtsp/describe'
import { NvrClient, NvrError } from '@/lib/nvr/client'
import { demoSource } from '@/lib/streams/source'

// P2-6 brief item 5 (SO-4, D-13): every outbound connection asks lib/security/targets.ts first. Only endpoints this process read from
// the database (registered recorder/asset endpoints) or an explicit allow-list may be reached; link-local, metadata, unspecified,
// multicast and broadcast addresses never; loopback only outside production; a name must keep resolving to the address it was first
// checked with (DNS rebinding); a port other than the registered one is refused. Refusals open no socket at all.

const DEV = { NODE_ENV: 'development' }
const PROD = { NODE_ENV: 'production' }

let connects = 0
const realConnect = net.Socket.prototype.connect
beforeEach(() => {
  forgetTargetsForTest()
  connects = 0
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...a: unknown[]) {
    connects++
    return (realConnect as (...x: unknown[]) => net.Socket).apply(this, a)
  } as typeof net.Socket.prototype.connect)
})
afterEach(() => vi.restoreAllMocks())

describe('address classes', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['127.9.9.9', 'loopback'], ['::1', 'loopback'], ['::ffff:127.0.0.1', 'loopback'],
    ['169.254.169.254', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'],
    ['169.254.1.1', 'link_local'], ['fe80::1', 'link_local'], ['::ffff:169.254.10.10', 'link_local'],
    ['0.0.0.0', 'unspecified'], ['::', 'unspecified'], ['224.0.0.1', 'multicast'], ['ff02::1', 'multicast'], ['255.255.255.255', 'broadcast'],
    ['192.168.1.100', 'private'], ['10.0.3.4', 'private'], ['172.16.0.1', 'private'], ['fd12:3456::1', 'private'],
    ['8.8.8.8', 'public'], ['not-an-ip', 'invalid'],
  ])('%s is %s', (ip, kind) => expect(addressClass(ip)).toBe(kind))
})

describe('connectRefusal (the backstop in front of every socket)', () => {
  it('refuses link-local, metadata, unspecified, multicast and broadcast addresses everywhere, with plain words', () => {
    for (const ip of ['169.254.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fe80::1', '::ffff:169.254.169.254']) {
      const r = connectRefusal(ip, DEV)
      expect(r, ip).toMatch(/^This address cannot be used/)
      expect(r, ip).not.toContain(ip)
    }
    expect(connectRefusal('metadata.google.internal', DEV)).not.toBeNull()
  })
  it('loopback only outside production', () => {
    expect(connectRefusal('127.0.0.1', DEV)).toBeNull()
    expect(connectRefusal('localhost', DEV)).toBeNull()
    expect(connectRefusal('127.0.0.1', PROD)).toMatch(/this computer/)
    expect(connectRefusal('localhost', PROD)).toMatch(/this computer/)
    expect(connectRefusal('::1', PROD)).toMatch(/this computer/)
  })
  it('private and public addresses and plain names pass the backstop (the registered-endpoint check is checkTarget)', () => {
    expect(connectRefusal('192.168.1.100', PROD)).toBeNull()
    expect(connectRefusal('nvr-jcl.example.test', PROD)).toBeNull()
  })

  it('tcpCheck, rtspDescribe and the NVR client open no socket for a refused address', async () => {
    expect(await tcpCheck('169.254.169.254', 80)).toEqual({ ok: false, error: expect.stringMatching(/^This address cannot be used/) })
    expect((await rtspDescribe({ host: '169.254.1.1', port: 554, username: 'u', password: 'p', channel: 1 })).code).toBe(0)
    await expect(new NvrClient({ host: '0.0.0.0', port: 80, username: 'u', password: 'p' }).channels()).rejects.toBeInstanceOf(NvrError)
    expect(connects).toBe(0)
  })
})

describe('checkTarget (registered endpoints, ports, DNS pinning)', () => {
  const lookupOf = (answers: Record<string, string[]>) => vi.fn(async (name: string) => {
    const a = answers[name]
    if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  })

  it('a registered recorder endpoint passes and gives the address to connect to', async () => {
    registerEndpoints([{ host: '192.168.20.100', port: 80 }, { host: '192.168.20.100', port: 554 }])
    expect(await checkTarget({ host: '192.168.20.100', port: 80, purpose: 'nvr_http' }, { env: PROD })).toEqual({ ok: true, address: '192.168.20.100' })
    expect(await checkTarget({ host: '192.168.20.100', port: 554, purpose: 'nvr_rtsp' }, { env: PROD })).toEqual({ ok: true, address: '192.168.20.100' })
  })

  it('an unregistered host is refused with plain words and nothing is opened', async () => {
    expect(await checkTarget({ host: '192.168.99.1', port: 80, purpose: 'nvr_http' }, { env: PROD })).toEqual({ ok: false, error: MSG_NOT_REGISTERED })
    expect(connects).toBe(0)
  })

  it('a registered host on another port is a port mismatch', async () => {
    registerEndpoints([{ host: '192.168.20.101', port: 80 }])
    expect(await checkTarget({ host: '192.168.20.101', port: 8080, purpose: 'nvr_http' }, { env: PROD })).toEqual({ ok: false, error: MSG_PORT_MISMATCH })
  })

  it('the explicit allow-list (OUTBOUND_TARGET_ALLOWLIST) also passes; nothing else', async () => {
    const env = { ...PROD, OUTBOUND_TARGET_ALLOWLIST: '192.168.50.5:161, 192.168.50.6:22' }
    expect((await checkTarget({ host: '192.168.50.5', port: 161, purpose: 'snmp' }, { env })).ok).toBe(true)
    expect((await checkTarget({ host: '192.168.50.5', port: 162, purpose: 'snmp' }, { env })).ok).toBe(false)
  })

  it('a registered link-local or metadata address is still refused', async () => {
    registerEndpoints([{ host: '169.254.169.254', port: 80 }, { host: '169.254.3.3', port: 554 }])
    for (const host of ['169.254.169.254', '169.254.3.3']) {
      const r = await checkTarget({ host, port: host.endsWith('254') ? 80 : 554, purpose: 'nvr_http' }, { env: DEV })
      expect(r.ok, host).toBe(false)
    }
  })

  it('a registered name is resolved once and pinned; a changed DNS answer is refused (DNS rebinding)', async () => {
    registerEndpoints([{ host: 'nvr-a.example.test', port: 80 }])
    const lookup = lookupOf({ 'nvr-a.example.test': ['192.168.30.10'] })
    expect(await checkTarget({ host: 'nvr-a.example.test', port: 80, purpose: 'nvr_http' }, { env: PROD, lookup })).toEqual({ ok: true, address: '192.168.30.10' })
    const changed = lookupOf({ 'nvr-a.example.test': ['192.168.77.77'] })
    expect(await checkTarget({ host: 'nvr-a.example.test', port: 80, purpose: 'nvr_http' }, { env: PROD, lookup: changed })).toEqual({ ok: false, error: MSG_DNS_CHANGED })
    // The same answer again is fine.
    expect((await checkTarget({ host: 'nvr-a.example.test', port: 80, purpose: 'nvr_http' }, { env: PROD, lookup })).ok).toBe(true)
  })

  it('a name that resolves to a forbidden address is refused, whichever answer comes first', async () => {
    registerEndpoints([{ host: 'evil.example.test', port: 80 }])
    const lookup = lookupOf({ 'evil.example.test': ['192.168.30.11', '169.254.169.254'] })
    expect((await checkTarget({ host: 'evil.example.test', port: 80, purpose: 'nvr_http' }, { env: PROD, lookup })).ok).toBe(false)
    const toLoopback = lookupOf({ 'evil.example.test': ['127.0.0.1'] })
    forgetTargetsForTest()
    registerEndpoints([{ host: 'evil.example.test', port: 80 }])
    expect((await checkTarget({ host: 'evil.example.test', port: 80, purpose: 'nvr_http' }, { env: PROD, lookup: toLoopback })).ok).toBe(false)
  })

  it('a registration expires (an endpoint not read from the database for an hour is no longer reachable)', async () => {
    const t0 = 1_800_000_000_000
    registerEndpoints([{ host: '192.168.20.102', port: 80 }], t0)
    expect((await checkTarget({ host: '192.168.20.102', port: 80, purpose: 'nvr_http' }, { env: PROD, now: t0 + 59 * 60_000 })).ok).toBe(true)
    expect(await checkTarget({ host: '192.168.20.102', port: 80, purpose: 'nvr_http' }, { env: PROD, now: t0 + 61 * 60_000 })).toEqual({ ok: false, error: MSG_NOT_REGISTERED })
  })
})

describe('go2rtc sources (D-13)', () => {
  it('only rtsp:// sources of registered recorder endpoints, plus the demo picture outside production', () => {
    registerEndpoints([{ host: '192.168.40.100', port: 554 }])
    expect(sourceRefusal('rtsp://viewer:p%40ss@192.168.40.100:554/Streaming/Channels/102', PROD)).toBeNull()
    expect(sourceRefusal('rtsp://viewer:pass@192.168.40.100:8554/Streaming/Channels/102', PROD)).not.toBeNull()
    expect(sourceRefusal('rtsp://viewer:pass@192.168.40.200:554/Streaming/Channels/102', PROD)).not.toBeNull()
    expect(sourceRefusal(demoSource(1, '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'), DEV)).toBeNull()
    expect(sourceRefusal(demoSource(2), DEV)).toBeNull()
    expect(sourceRefusal(demoSource(1), PROD)).not.toBeNull()
  })

  it.each([
    'exec:ffmpeg -i rtsp://x -f rtsp {output}', 'echo:/bin/sh -c id', 'expr:let x = 1', 'ffmpeg:rtsp://192.168.40.100:554/x#video=copy',
    'ffmpeg:virtual?video=testsrc&size=640x360#video=h264#raw=-i /etc/passwd', 'http://192.168.40.100/snapshot.jpg', 'rtmp://192.168.40.100/live',
    'rtsp://169.254.169.254:554/x', 'rtsp://127.0.0.1:554/x', 'webrtc:http://x', '',
  ])('refuses %j with plain words that never repeat the source', (src) => {
    registerEndpoints([{ host: '192.168.40.100', port: 554 }, { host: '169.254.169.254', port: 554 }, { host: '127.0.0.1', port: 554 }])
    const r = sourceRefusal(src, PROD)
    expect(r).not.toBeNull()
    if (src) expect(r).not.toContain(src)
  })
})
