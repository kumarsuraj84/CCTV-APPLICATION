import { describe, expect, it } from 'vitest'
import { buildPlaybackUrl, buildRtspUrl, demoSource, isDemoRecorder } from '@/lib/streams/source'

const base = { host: '192.168.1.10', port: 554, username: 'viewer', password: 'pw', channel: 3, kind: 'sub' as const }
const pb = { host: '192.168.1.10', port: 554, username: 'viewer', password: 'pw', channel: 3, start: new Date('2026-03-10T10:00:00Z'), end: new Date('2026-03-10T10:30:00Z'), offsetMin: 0 }

describe('buildRtspUrl', () => {
  it('builds the sub and main stream paths', () => {
    expect(buildRtspUrl(base)).toBe('rtsp://viewer:pw@192.168.1.10:554/Streaming/Channels/302')
    expect(buildRtspUrl({ ...base, kind: 'main' })).toBe('rtsp://viewer:pw@192.168.1.10:554/Streaming/Channels/301')
    expect(buildRtspUrl({ ...base, channel: 12 })).toBe('rtsp://viewer:pw@192.168.1.10:554/Streaming/Channels/1202')
  })

  it('percent-encodes the password', () => {
    const url = buildRtspUrl({ ...base, password: 'p@ss:w/rd#' })
    expect(url).toBe('rtsp://viewer:p%40ss%3Aw%2Frd%23@192.168.1.10:554/Streaming/Channels/302')
    expect(new URL(url).password).toBe('p%40ss%3Aw%2Frd%23')
    expect(new URL(url).hostname).toBe('192.168.1.10')
  })

  it('also encodes the characters encodeURIComponent leaves alone, in the user name and the password', () => {
    const url = buildRtspUrl({ ...base, username: "us!er'(1)*", password: "a!b'c(d)e*f" })
    expect(url).toContain('us%21er%27%281%29%2A:a%21b%27c%28d%29e%2Af@')
    expect(url).not.toMatch(/[!'()*]/)
  })

  it('encodes spaces, percent signs, non-ASCII, ? and the user name colon', () => {
    const url = buildRtspUrl({ ...base, username: 'a:b', password: 'x y%z?é' })
    expect(url).toContain('rtsp://a%3Ab:x%20y%25z%3F%C3%A9@192.168.1.10')
    const parsed = new URL(url)
    expect(decodeURIComponent(parsed.username)).toBe('a:b')
    expect(decodeURIComponent(parsed.password)).toBe('x y%z?é')
    expect(parsed.pathname).toBe('/Streaming/Channels/302')
  })

  it('puts an IPv6 host in brackets', () => {
    expect(buildRtspUrl({ ...base, host: '::1' })).toBe('rtsp://viewer:pw@[::1]:554/Streaming/Channels/302')
    expect(buildRtspUrl({ ...base, host: '2001:db8::5', port: 8554 })).toBe('rtsp://viewer:pw@[2001:db8::5]:8554/Streaming/Channels/302')
    expect(new URL(buildRtspUrl({ ...base, host: '2001:db8::5' })).hostname).toBe('[2001:db8::5]')
  })

  it('accepts a host name', () => {
    expect(buildRtspUrl({ ...base, host: 'nvr-01.store.example' })).toBe('rtsp://viewer:pw@nvr-01.store.example:554/Streaming/Channels/302')
  })

  it('refuses an invalid host, port or channel with a plain message that does not echo the credentials', () => {
    const secret = { username: 'topsecretuser', password: 'topsecretpass' }
    const bad = [
      { host: '' }, { host: 'a b' }, { host: 'host/evil' }, { host: 'evil@host' }, { host: 'host:554' }, { host: '[::1]' }, { host: 'fe80::1%eth0' },
      { host: '1.2.3' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: Number.NaN }, { channel: 0 }, { channel: 4097 }, { channel: -1 },
      { channel: 1.5 }, { channel: Number.NaN }, { channel: Infinity }, { kind: 'pb' as 'sub' },
    ]
    for (const o of bad) {
      let message = ''
      try {
        buildRtspUrl({ ...base, ...secret, ...o })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, JSON.stringify(o)).not.toBe('')
      expect(message).not.toContain('topsecret')
      expect(message).not.toContain('rtsp://')
    }
  })

  it('accepts the channel limits', () => {
    expect(buildRtspUrl({ ...base, channel: 1 })).toMatch(/\/102$/)
    expect(buildRtspUrl({ ...base, channel: 4096 })).toMatch(/\/409602$/)
  })

  it('refuses credentials that are not strings', () => {
    expect(() => buildRtspUrl({ ...base, password: undefined as unknown as string })).toThrow()
    expect(() => buildRtspUrl({ ...base, username: null as unknown as string })).toThrow()
  })
})

describe('buildPlaybackUrl', () => {
  it('builds the track path with UTC times', () => {
    expect(buildPlaybackUrl(pb)).toBe(
      'rtsp://viewer:pw@192.168.1.10:554/Streaming/tracks/301?starttime=20260310T100000Z&endtime=20260310T103000Z',
    )
  })

  it('shifts both instants back by the NVR offset (an NVR running 330 minutes ahead)', () => {
    const url = buildPlaybackUrl({ ...pb, offsetMin: 330 })
    expect(url).toContain('starttime=20260310T043000Z&endtime=20260310T050000Z')
  })

  it('shifts forward for a negative offset and across midnight', () => {
    expect(buildPlaybackUrl({ ...pb, start: new Date('2026-03-10T00:10:00Z'), end: new Date('2026-03-10T00:40:00Z'), offsetMin: 30 })).toContain(
      'starttime=20260309T234000Z&endtime=20260310T001000Z',
    )
    expect(buildPlaybackUrl({ ...pb, offsetMin: -60 })).toContain('starttime=20260310T110000Z&endtime=20260310T113000Z')
  })

  it('P2-5b: takes a per-recorder offset in seconds (ruling R13 direction: the NVR is asked for shown time minus the offset)', () => {
    const { offsetMin: _ignored, ...base } = pb
    void _ignored
    expect(buildPlaybackUrl({ ...base, offsetSec: 90 })).toContain('starttime=20260310T095830Z&endtime=20260310T102830Z')
    expect(buildPlaybackUrl({ ...base, offsetSec: -45 })).toContain('starttime=20260310T100045Z&endtime=20260310T103045Z')
    expect(buildPlaybackUrl({ ...base, offsetSec: 330 * 60 })).toBe(buildPlaybackUrl({ ...pb, offsetMin: 330 }))
    expect(buildPlaybackUrl({ ...base, offsetSec: 86_400 })).toContain('starttime=20260309T100000Z')
    expect(() => buildPlaybackUrl({ ...base, offsetSec: 86_401 })).toThrow('The camera address is not valid.')
    expect(() => buildPlaybackUrl({ ...base, offsetSec: 1.5 })).toThrow('The camera address is not valid.')
    // Exactly one of the two: both or neither is refused.
    expect(() => buildPlaybackUrl({ ...base, offsetSec: 60, offsetMin: 1 } as never)).toThrow('The camera address is not valid.')
    expect(() => buildPlaybackUrl({ ...base } as never)).toThrow('The camera address is not valid.')
  })

  it('encodes credentials and brackets IPv6 like the live URL', () => {
    const url = buildPlaybackUrl({ ...pb, host: '2001:db8::5', password: "p@ss:w/rd#!'()*" })
    expect(url.startsWith("rtsp://viewer:p%40ss%3Aw%2Frd%23%21%27%28%29%2A@[2001:db8::5]:554/Streaming/tracks/301?")).toBe(true)
  })

  it('accepts an offset up to a day either way and refuses more', () => {
    expect(buildPlaybackUrl({ ...pb, offsetMin: 1440 })).toContain('starttime=20260309T100000Z')
    expect(buildPlaybackUrl({ ...pb, offsetMin: -1440 })).toContain('starttime=20260311T100000Z')
    expect(() => buildPlaybackUrl({ ...pb, offsetMin: 1441 })).toThrow('The camera address is not valid.')
    expect(() => buildPlaybackUrl({ ...pb, offsetMin: -1441 })).toThrow('The camera address is not valid.')
    expect(() => buildPlaybackUrl({ ...pb, offsetMin: 1e12 })).toThrow()
  })

  it('refuses a time that cannot be shifted into a valid date', () => {
    const edge = 8.64e15 // the last instant a Date can hold
    expect(() => buildPlaybackUrl({ ...pb, start: new Date(edge - 1000), end: new Date(edge), offsetMin: -1, password: 'topsecretpass' })).toThrow(
      'The camera address is not valid.',
    )
    expect(() => buildPlaybackUrl({ ...pb, start: new Date(-edge), end: new Date(-edge + 1000), offsetMin: 1 })).toThrow('The camera address is not valid.')
  })

  it('refuses an invalid host, port, channel, date, range or offset', () => {
    const bad = [
      { host: 'a b' }, { port: 0 }, { channel: 0 }, { channel: 4097 }, { start: new Date('nope') }, { end: new Date('nope') },
      { end: new Date('2026-03-10T10:00:00Z') }, { end: new Date('2026-03-10T09:00:00Z') }, { offsetMin: Number.NaN }, { offsetMin: Infinity },
      { start: '2026-03-10T10:00:00Z' as unknown as Date },
    ]
    for (const o of bad) {
      let message = ''
      try {
        buildPlaybackUrl({ ...pb, password: 'topsecretpass', ...o })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, JSON.stringify(o)).not.toBe('')
      expect(message).not.toContain('topsecret')
    }
  })
})

describe('demoSource', () => {
  it('uses the test pattern chosen by channel modulo four', () => {
    const pattern = (n: number) => /video=(\w+)&size/.exec(demoSource(n))![1]
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(pattern)).toEqual(['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc', 'testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc'])
  })

  it("is go2rtc's own test-picture source, H.264, 640 by 360 (an exec: source is refused through the API)", () => {
    expect(demoSource(1)).toBe('ffmpeg:virtual?video=testsrc2&size=640x360#video=h264')
    for (const n of [0, 1, 2, 3, 4]) expect(demoSource(n)).not.toMatch(/^exec:|\{output\}|rtsp:\/\//)
  })

  it('gives every camera its own source, because go2rtc publishes each under a path made from the source text', () => {
    const a = demoSource(1, '0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')
    const b = demoSource(1, '0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0002')
    expect(a).not.toBe(b)
    expect(a).toBe(demoSource(1, '0f6ad1c4-85a3-4a55-9d0b-3f0a4b1a0001')) // stable for one camera
    expect(a).toMatch(/^ffmpeg:virtual\?video=testsrc2&size=640x360&duration=86400\.\d{1,13}#video=h264$/)
    expect(demoSource(1)).not.toContain('duration') // without an id it is the plain source
  })

  it('refuses a channel that is not a whole number', () => {
    expect(() => demoSource(Number.NaN)).toThrow()
    expect(() => demoSource(1.5)).toThrow()
  })
})

// P2-5b: demo video is decided by the RECORDER's address (a location may have a loopback demo NVR next to a real one).
describe('isDemoRecorder', () => {
  const on = { DEMO_VIDEO: '1', NODE_ENV: 'development' }
  it('is true only for DEMO_VIDEO=1, not production, with a loopback NVR address', () => {
    expect(isDemoRecorder({ host:'127.0.0.1' }, on)).toBe(true)
    expect(isDemoRecorder({ host:'localhost' }, on)).toBe(true)
    expect(isDemoRecorder({ host:'::1' }, on)).toBe(true)
    expect(isDemoRecorder({ host:'127.0.0.1' }, { DEMO_VIDEO: '1' })).toBe(true)
  })
  it('is false when the flag is not exactly 1', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
      expect(isDemoRecorder({ host:'127.0.0.1' }, { DEMO_VIDEO: v, NODE_ENV: 'development' }), String(v)).toBe(false)
    }
  })
  it('is false in production', () => {
    expect(isDemoRecorder({ host:'127.0.0.1' }, { DEMO_VIDEO: '1', NODE_ENV: 'production' })).toBe(false)
  })
  it('is false for any address that is not loopback', () => {
    for (const ip of ['192.168.1.10', '127.0.0.2', '0.0.0.0', '', '10.0.0.1', 'example.com', '127.0.0.1.evil.com', ' 127.0.0.1']) {
      expect(isDemoRecorder({ host:ip }, on), ip).toBe(false)
    }
  })
  it('reads process.env when no environment is given', () => {
    const before = { d: process.env.DEMO_VIDEO }
    try {
      delete process.env.DEMO_VIDEO
      expect(isDemoRecorder({ host:'127.0.0.1' })).toBe(false)
    } finally {
      if (before.d !== undefined) process.env.DEMO_VIDEO = before.d
    }
  })
})
