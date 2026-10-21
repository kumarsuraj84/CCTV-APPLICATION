import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPingArgs, icmpCheck, isValidHost, tcpCheck } from '@/lib/probes'
import { closedPort, startFakeTcp, type Running } from '../helpers/fake-servers'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

type FakeChild = EventEmitter & { kill: () => void }

describe('tcpCheck', () => {
  it('is ok when something listens', async () => {
    const s = await startFakeTcp()
    running.push(s)
    expect(await tcpCheck('127.0.0.1', s.port)).toEqual({ ok: true })
  })
  it('says the port refused when nothing listens', async () => {
    expect(await tcpCheck('127.0.0.1', await closedPort())).toEqual({ ok: false, error: 'The port refused the connection.' })
  })
  it('gives a plain message for an address outside the test network (egress guard)', async () => {
    const r = await tcpCheck('192.0.2.1', 80, 500)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Egress guard')
  })
  it('refuses a host or port that cannot be right, without connecting', async () => {
    const bad = { ok: false, error: 'That address or port is not valid.' }
    expect(await tcpCheck('2130706433', 80)).toEqual(bad)
    expect(await tcpCheck('0x7f.1', 80)).toEqual(bad)
    expect(await tcpCheck('user@127.0.0.1', 80)).toEqual(bad)
    expect(await tcpCheck('127.0.0.1/x', 80)).toEqual(bad)
    expect(await tcpCheck('127.0.0.1\r\n', 80)).toEqual(bad)
    expect(await tcpCheck('', 80)).toEqual(bad)
    expect(await tcpCheck('127.0.0.1', 0)).toEqual(bad)
    expect(await tcpCheck('127.0.0.1', 65536)).toEqual(bad)
    expect(await tcpCheck('127.0.0.1', 80.5)).toEqual(bad)
  })
})

describe('isValidHost', () => {
  it('accepts IP addresses and plain host names only', () => {
    for (const h of ['127.0.0.1', '192.0.2.5', '::1', 'camera-1.local', 'nvr']) expect(isValidHost(h)).toBe(true)
  })
  it('rejects option-like, numeric, hex, credential-bearing and whitespace forms', () => {
    for (const h of ['-n', '-n 100 evil', '2130706433', '0x7f.1', '0x7f000001', '127.1', '1.2.3', 'a@b', 'a/b', 'a b', 'a\tb', 'a\r\nb', 'a:80', 'fe80::1%eth0', '', 'a'.repeat(300)]) {
      expect(isValidHost(h)).toBe(false)
    }
  })
})

describe('ping', () => {
  it('builds the right arguments for each system', () => {
    expect(buildPingArgs('win32', '192.0.2.5', 2000)).toEqual(['-n', '1', '-w', '2000', '192.0.2.5'])
    expect(buildPingArgs('linux', '192.0.2.5', 2000)).toEqual(['-c', '1', '-W', '2', '192.0.2.5'])
    expect(buildPingArgs('linux', '192.0.2.5', 300)).toEqual(['-c', '1', '-W', '1', '192.0.2.5'])
    expect(buildPingArgs('darwin', '192.0.2.5', 2000)).toEqual(['-c', '1', '-W', '2000', '192.0.2.5'])
  })
  it('refuses anything that is not an IP address, so it can never be a command option', async () => {
    expect(await icmpCheck('-n 100 evil')).toEqual({ ok: false, error: 'That is not an IP address.' })
    expect(await icmpCheck('example.org')).toEqual({ ok: false, error: 'That is not an IP address.' })
    expect(await icmpCheck('-1')).toEqual({ ok: false, error: 'That is not an IP address.' })
    expect(await icmpCheck('127.0.0.1 -t')).toEqual({ ok: false, error: 'That is not an IP address.' })
    expect(await icmpCheck('fe80::1%eth0')).toEqual({ ok: false, error: 'That is not an IP address.' })
  })
  it('reads the exit code of the ping program', async () => {
    const fake = (code: number | 'enoent') => () => {
      const p = new EventEmitter() as FakeChild
      p.kill = () => {}
      setTimeout(() => (code === 'enoent' ? p.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })) : p.emit('close', code)), 5)
      return p
    }
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake(0) as never })).toEqual({ ok: true })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake(1) as never })).toEqual({ ok: false, error: 'No reply to the ping.' })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fake('enoent') as never })).toEqual({ ok: false, error: 'The ping program is not available on this computer.' })
  })
  it('passes the program name and an arguments array only (no shell string)', async () => {
    const calls: unknown[][] = []
    const spawn = (...a: unknown[]) => {
      calls.push(a)
      const p = new EventEmitter() as FakeChild
      p.kill = () => {}
      setTimeout(() => p.emit('close', 0), 1)
      return p
    }
    await icmpCheck('192.0.2.5', 2000, { platform: 'win32', spawn: spawn as never })
    expect(calls).toEqual([['ping', ['-n', '1', '-w', '2000', '192.0.2.5']]])
  })
  it('stops waiting and kills a ping that never ends', async () => {
    let killed = false
    const spawn = () => {
      const p = new EventEmitter() as FakeChild
      p.kill = () => {
        killed = true
      }
      return p
    }
    const started = Date.now()
    expect(await icmpCheck('192.0.2.5', 200, { platform: 'linux', spawn: spawn as never })).toEqual({ ok: false, error: 'No reply to the ping.' })
    expect(killed).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('really pings loopback', async () => {
    expect(await icmpCheck('127.0.0.1', 2000)).toEqual({ ok: true })
  })
})
