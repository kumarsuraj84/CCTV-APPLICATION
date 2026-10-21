import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPingArgs, describeTcpError, icmpCheck, isValidHost, MAX_PING_OUTPUT, pingCommand, tcpCheck } from '@/lib/probes'
import { closedPort, startFakeTcp, type Running } from '../helpers/fake-servers'

const running: Running[] = []
afterEach(async () => {
  while (running.length) await running.pop()!.close()
})

type FakeChild = EventEmitter & { kill: () => void; stdout: EventEmitter }
const REPLY = 'Pinging 192.0.2.5 with 32 bytes of data:\r\nReply from 192.0.2.5: bytes=32 time=1ms TTL=64\r\n'
const UNREACHABLE = 'Pinging 192.0.2.5 with 32 bytes of data:\r\nReply from 10.0.0.1: Destination host unreachable.\r\n'

/** A fake ping program: prints `out` (a string, or a function that gets stdout to print lots) and then ends with `code`. */
function fakePing(code: number | 'enoent', out: string | ((stdout: EventEmitter) => void) = '') {
  return () => {
    const p = new EventEmitter() as FakeChild
    p.stdout = new EventEmitter()
    p.kill = () => {}
    setTimeout(() => {
      if (code === 'enoent') return p.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
      if (typeof out === 'function') out(p.stdout)
      else if (out) p.stdout.emit('data', Buffer.from(out))
      p.emit('close', code)
    }, 5)
    return p
  }
}

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

describe('describeTcpError', () => {
  it('uses plain words and never a raw code', () => {
    expect(describeTcpError({ code: 'ECONNREFUSED' })).toBe('The port refused the connection.')
    expect(describeTcpError({ code: 'ETIMEDOUT' })).toBe('No answer in time.')
    expect(describeTcpError({ code: 'ENOTFOUND' })).toBe('That name cannot be found.')
    expect(describeTcpError({ code: 'EHOSTUNREACH' })).toBe('The address cannot be reached.')
    expect(describeTcpError({ code: 'ENETUNREACH' })).toBe('The address cannot be reached.')
    expect(describeTcpError({ code: 'ECONNRESET' })).toBe('The connection was reset.')
    expect(describeTcpError({ code: 'EWHATEVER' })).toBe('The connection failed.')
    expect(describeTcpError({})).toBe('The connection failed.')
    expect(describeTcpError({ code: 'EACCES', message: 'connect EACCES 10.1.2.3:80' })).toBe('The connection failed.')
  })
})

describe('isValidHost', () => {
  it('accepts IP addresses and plain host names only', () => {
    for (const h of ['127.0.0.1', '192.0.2.5', '::1', 'camera-1.local', 'nvr', 'store_12.corp.local', 'nvr.corp.local.']) expect(isValidHost(h)).toBe(true)
  })
  it('rejects option-like, numeric, hex, credential-bearing and whitespace forms', () => {
    for (const h of ['-n', '-n 100 evil', '2130706433', '0x7f.1', '0x7f000001', '127.1', '1.2.3', 'a@b', 'a/b', 'a b', 'a\tb', 'a\r\nb', 'a:80', 'fe80::1%eth0', '', 'a'.repeat(300), '127.1.', '2130706433.', '0x7f.1.', '_x', 'a..b', '.a', '..']) {
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
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing(0, REPLY) as never })).toEqual({ ok: true })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing(1) as never })).toEqual({ ok: false, error: 'No reply to the ping.' })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing('enoent') as never })).toEqual({ ok: false, error: 'The ping program is not available on this computer.' })
  })
  it('does not call a device live because a router answered "unreachable" with exit code 0', async () => {
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'win32', spawn: fakePing(0, UNREACHABLE) as never })).toEqual({ ok: false, error: 'The device did not answer the ping.' })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'win32', spawn: fakePing(0) as never })).toEqual({ ok: false, error: 'The device did not answer the ping.' })
  })
  it('needs both a real echo reply and exit code 0', async () => {
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'win32', spawn: fakePing(0, REPLY) as never })).toEqual({ ok: true })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing(0, '64 bytes from 192.0.2.5: icmp_seq=1 ttl=64 time=0.5 ms\n') as never })).toEqual({ ok: true })
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'win32', spawn: fakePing(1, REPLY) as never })).toEqual({ ok: false, error: 'No reply to the ping.' })
  })
  it('keeps only the start of a huge output, still reads it all, and still resolves', async () => {
    let chunks = 0
    const flood = (stdout: EventEmitter) => {
      for (let i = 0; i < 200; i++, chunks++) stdout.emit('data', Buffer.from('x'.repeat(10_000)))
    }
    const r = await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing(0, flood) as never })
    expect(chunks).toBe(200)
    expect(r).toEqual({ ok: false, error: 'The device did not answer the ping.' })
    // a reply inside the kept part is still seen even when much more follows
    const withReply = (stdout: EventEmitter) => {
      stdout.emit('data', Buffer.from(REPLY))
      for (let i = 0; i < 200; i++) stdout.emit('data', Buffer.from('x'.repeat(10_000)))
    }
    expect(await icmpCheck('192.0.2.5', 1000, { platform: 'linux', spawn: fakePing(0, withReply) as never })).toEqual({ ok: true })
    expect(MAX_PING_OUTPUT).toBe(4096)
  })
  it('starts the system ping.exe by full path on Windows and plain "ping" elsewhere', () => {
    expect(pingCommand('win32', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\ping.exe')
    expect(pingCommand('win32', {})).toBe('C:\\Windows\\System32\\ping.exe')
    expect(pingCommand('linux', { SystemRoot: 'C:\\Windows' })).toBe('ping')
    expect(pingCommand('darwin')).toBe('ping')
  })
  it('still goes through the egress guard: a non-loopback address is refused and nothing is pinged', async () => {
    expect(await icmpCheck('192.0.2.1', 500)).toEqual({ ok: false, error: expect.stringContaining('Egress guard') })
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
    expect(calls).toEqual([[pingCommand('win32'), ['-n', '1', '-w', '2000', '192.0.2.5']]])
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
