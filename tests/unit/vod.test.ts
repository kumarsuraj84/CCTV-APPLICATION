import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ffmpegHelpHasReadrate } from '@/lib/streams/ffmpeg'
import {
  buildDownloadBody,
  buildFfmpegArgs,
  classifyFfmpegFailure,
  clipPlaybackUri,
  createConversionLimiter,
  createFfmpegCheck,
  createSpawn,
  defaultSpawn,
  FORMAT_WHITELIST,
  parseVodQuery,
  resolveFfmpeg,
  sanitizeStderr,
  startConversion,
  videoFamily,
  type SpawnFn,
} from '@/lib/streams/vod'
import { fakeSpawn, isAlive } from '../helpers/fake-spawn'

const ID = '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111'

/** A source of `total` bytes in chunks of 64 KB, made only as fast as it is read. */
function counting(total: number) {
  const state = { sent: 0, cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> }
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.sent >= total) return c.close()
        const n = Math.min(64 * 1024, total - state.sent)
        c.enqueue(new Uint8Array(n).fill(7))
        state.sent += n
      },
      cancel() {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return state
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader()
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return n
    n += value.byteLength
  }
}

describe('ffmpeg arguments', () => {
  const BASE = [
    '-nostdin',
    '-loglevel', 'error',
    '-protocol_whitelist', 'pipe',
    '-format_whitelist', 'mpeg,mpegts,mov,mp4,h264,hevc',
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1',
    '-f', 'mp4',
    'pipe:1',
  ]
  it('are exactly: no keyboard, only pipe input, only the listed formats, input from standard input, no sound, picture copied, fragmented MP4 to standard output', () => {
    expect(buildFfmpegArgs()).toEqual(BASE)
  })
  it('limit the protocol and the formats BEFORE the input (they are input options)', () => {
    const args = buildFfmpegArgs()
    const input = args.indexOf('-i')
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'pipe'])
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(input)
    expect(args.indexOf('-format_whitelist')).toBeLessThan(input)
    expect(args[args.indexOf('-format_whitelist') + 1]).toBe(FORMAT_WHITELIST)
    expect(args[input + 1]).toBe('pipe:0')
  })
  it('allow only the formats Hikvision NVRs send (MPEG-PS, MPEG-TS, MP4, bare H.264 / H.265) and nothing that can name other files', () => {
    expect(FORMAT_WHITELIST.split(',')).toEqual(['mpeg', 'mpegts', 'mov', 'mp4', 'h264', 'hevc'])
    for (const never of ['concat', 'hls', 'applehttp', 'dash', 'sdp', 'rtsp', 'image2', 'lavfi', 'avfoundation']) expect(FORMAT_WHITELIST.split(',')).not.toContain(never)
  })
  it('add the hvc1 tag for H.265 only, right after the copy', () => {
    const args = buildFfmpegArgs({ hevc: true })
    expect(args).toEqual([...BASE.slice(0, 12), '-tag:v', 'hvc1', ...BASE.slice(12)])
    expect(buildFfmpegArgs({ hevc: false })).toEqual(BASE)
    expect(buildFfmpegArgs({})).toEqual(BASE)
  })
  it('come back fresh each time, so one caller cannot change what the next one runs', () => {
    buildFfmpegArgs().push('-evil')
    expect(buildFfmpegArgs()).toEqual(BASE)
  })
  it('read the video family from the NVR name', () => {
    expect(['H.264-BP', 'H.264', 'AVC', 'h264'].map(videoFamily)).toEqual(['h264', 'h264', 'h264', 'h264'])
    expect(['H.265', 'HEVC', 'hevc', 'H.265+'].map(videoFamily)).toEqual(['h265', 'h265', 'h265', 'h265'])
    expect([undefined, '', 'MPEG4', 'MJPEG', 'x'].map(videoFamily)).toEqual([null, null, null, null, null])
  })
})

describe('the FFMPEG setting and where ffmpeg is looked for', () => {
  const POSIX = { platform: 'linux' as const }
  const WIN = { platform: 'win32' as const }
  it('takes a full path, trimmed', () => {
    expect(resolveFfmpeg({ FFMPEG: ' /usr/local/bin/ffmpeg ' }, POSIX)).toEqual({ ok: true, path: '/usr/local/bin/ffmpeg' })
    expect(resolveFfmpeg({ FFMPEG: ' C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe\r\n' }, WIN)).toEqual({ ok: true, path: 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe' })
    expect(resolveFfmpeg({ FFMPEG: '\\\\server\\share\\ffmpeg.exe' }, WIN)).toEqual({ ok: true, path: '\\\\server\\share\\ffmpeg.exe' })
  })
  it('refuses a name or a relative path with a plain message, and then looks nowhere else', () => {
    const asked: string[] = []
    const lookup = { ...POSIX, exists: (f: string) => (asked.push(f), true) }
    for (const bad of ['ffmpeg', './ffmpeg', '../bin/ffmpeg', 'bin/ffmpeg', '~/ffmpeg', 'ffmpeg.exe']) {
      expect(resolveFfmpeg({ FFMPEG: bad, PATH: '/usr/bin' }, lookup), bad).toEqual({ ok: false, error: 'FFMPEG must be the full path of the ffmpeg program.' })
    }
    for (const bad of ['ffmpeg.exe', '.\\ffmpeg.exe', 'bin\\ffmpeg.exe', '\\ffmpeg.exe', 'C:ffmpeg.exe', '\\Windows\\ffmpeg.exe']) {
      expect(resolveFfmpeg({ FFMPEG: bad }, WIN), bad).toEqual({ ok: false, error: 'FFMPEG must be the full path of the ffmpeg program.' })
    }
    expect(asked).toEqual([])
  })
  it('refuses a value with a line break, a NUL or any control character, and one that is far too long', () => {
    for (const bad of ['/bin/ffmpeg\n-i x', '/bin/ffmpeg\r-i', '/bin/ff\u0000mpeg', '/bin/ffmpeg\u0007', '/bin/ffmpeg\u007f', `/${'x'.repeat(1030)}`]) {
      expect(resolveFfmpeg({ FFMPEG: bad }, POSIX), JSON.stringify(bad).slice(0, 30)).toMatchObject({ ok: false, error: 'FFMPEG must be the full path of the ffmpeg program.' })
    }
  })
  it('finds the default `ffmpeg` only in full-path entries of PATH, in order', () => {
    const exists = (f: string) => ['/opt/x/ffmpeg', '/usr/bin/ffmpeg'].includes(f)
    expect(resolveFfmpeg({ PATH: '/bin:/usr/bin:/opt/x' }, { ...POSIX, exists })).toEqual({ ok: true, path: '/usr/bin/ffmpeg' })
    expect(resolveFfmpeg({ PATH: '/opt/x:/usr/bin' }, { ...POSIX, exists })).toEqual({ ok: true, path: '/opt/x/ffmpeg' })
    expect(resolveFfmpeg({ FFMPEG: '', PATH: '/usr/bin' }, { ...POSIX, exists })).toEqual({ ok: true, path: '/usr/bin/ffmpeg' })
  })
  it('skips empty, "." and relative entries (and so the current folder), also when ffmpeg is there', () => {
    const asked: string[] = []
    const exists = (f: string) => (asked.push(f), true)
    expect(resolveFfmpeg({ PATH: ':.::bin:./bin:../x:~/bin' }, { ...POSIX, exists })).toEqual({ ok: false, error: 'ffmpeg is not installed on the server' })
    expect(asked).toEqual([])
    expect(resolveFfmpeg({ PATH: '.;;bin;..\\x;\\tools;C:tools;' }, { ...WIN, exists })).toEqual({ ok: false, error: 'ffmpeg is not installed on the server' })
    expect(asked).toEqual([])
    expect(resolveFfmpeg({ PATH: '.:/usr/bin' }, { ...POSIX, exists })).toEqual({ ok: true, path: '/usr/bin/ffmpeg' })
    expect(asked).toEqual(['/usr/bin/ffmpeg'])
  })
  it('on Windows looks for ffmpeg.exe (never a .cmd shim), strips quotes around an entry, and reads the Path spelling', () => {
    const seen: string[] = []
    const exists = (f: string) => (seen.push(f), f === 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe')
    expect(resolveFfmpeg({ Path: 'C:\\Windows;"C:\\Program Files\\ffmpeg\\bin"' }, { ...WIN, exists })).toEqual({ ok: true, path: 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' })
    expect(seen).toEqual(['C:\\Windows\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'])
  })
  it('says "not installed" when PATH is missing or has no ffmpeg', () => {
    const none = { ...POSIX, exists: () => false }
    expect(resolveFfmpeg({}, none)).toEqual({ ok: false, error: 'ffmpeg is not installed on the server' })
    expect(resolveFfmpeg({ PATH: '/usr/bin:/bin' }, none)).toEqual({ ok: false, error: 'ffmpeg is not installed on the server' })
  })
  it('really checks the file system by default: a folder or a missing file is not a program', () => {
    const here = path.resolve(__dirname)
    expect(resolveFfmpeg({ PATH: here }).ok).toBe(false) // there is no ffmpeg in the tests folder
  })
})

describe('how the program is started', () => {
  it('without a shell, with the arguments as a list, three pipes and no console window', () => {
    const impl = vi.fn(() => ({}) as never)
    createSpawn(impl as never)('/opt/ffmpeg', ['-i', 'pipe:0'])
    expect(impl).toHaveBeenCalledTimes(1)
    expect(impl).toHaveBeenCalledWith('/opt/ffmpeg', ['-i', 'pipe:0'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  })
})

describe('what ffmpeg says when it does not understand the recording', () => {
  it('is a format problem for the usual words, anything else is a plain failure', () => {
    for (const s of [
      '[in#0] Error opening input: Invalid data found when processing input',
      'Unsupported codec with id 98314 for input stream 0',
      'Could not find codec parameters for stream 0',
      'moov atom not found',
      'Format mpegts not on whitelist \'mpeg,mov\'',
      'Unknown decoder \'xyz\'',
      'Codec not currently supported in container',
    ]) expect(classifyFfmpegFailure(s), s).toBe('format')
    for (const s of ['', 'Conversion failed!', 'Broken pipe', 'Out of memory']) expect(classifyFfmpegFailure(s), s).toBe('failed')
  })
})

describe('what is logged from ffmpeg', () => {
  it('hides addresses, drops control characters and long runs of space, and is cut at 200 characters', () => {
    expect(sanitizeStderr('Error opening input rtsp://admin:hunter2@10.0.0.5/x?y=1: Invalid data\nfoo\u0000  bar')).toBe('Error opening input [address] Invalid data foo bar')
    expect(sanitizeStderr('see http://10.1.1.1:80/ISAPI and file://C:/x then https://a.b/c')).toBe('see [address] and [address] then [address]')
    expect(sanitizeStderr('x'.repeat(500))).toHaveLength(200)
    expect(sanitizeStderr('')).toBe('')
  })
})

describe('the download request', () => {
  it('puts the address, escaped, inside downloadRequest/playbackURI and nowhere else', () => {
    const body = buildDownloadBody('rtsp://10.0.0.5/Streaming/tracks/101?starttime=20261022T100000Z&endtime=20261022T101000Z&name=a"b<c>\'d')
    expect(body).toContain('<downloadRequest')
    expect(body).toContain('<playbackURI>rtsp://10.0.0.5/Streaming/tracks/101?starttime=20261022T100000Z&amp;endtime=20261022T101000Z&amp;name=a&quot;b&lt;c&gt;&apos;d</playbackURI>')
    expect(body).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
    expect(body).not.toContain('<c>')
  })
  it('accepts rtsp, http and https addresses of at most 512 characters', () => {
    for (const ok of ['rtsp://h/p', 'RTSP://h/p', 'http://h/p', 'https://h/p', `rtsp://h/${'a'.repeat(512 - 'rtsp://h/'.length)}`]) expect(() => buildDownloadBody(ok), ok.slice(0, 20)).not.toThrow()
  })
  it('refuses any other scheme, control characters, whitespace, an empty address and one longer than 512, without echoing it', () => {
    const bad = ['file:///etc/passwd', 'ftp://h/p', 'javascript:alert(1)', 'rtsp:/h', '//h/p', 'rtsp://h/p\n<x/>', 'rtsp://h/p\u0000', 'rtsp://h/ p', 'rtsp://h/\u0007', 'rtsp://h/\u2028x', '', `rtsp://h/${'a'.repeat(512)}`, ' rtsp://h/p']
    for (const b of bad) {
      expect(() => buildDownloadBody(b), JSON.stringify(b).slice(0, 30)).toThrow('Invalid playback address.')
    }
    expect(() => buildDownloadBody(undefined as unknown as string)).toThrow('Invalid playback address.')
    expect(() => buildDownloadBody({ toString: () => 'rtsp://h/p' } as unknown as string)).toThrow('Invalid playback address.')
  })
  it('stays far below the NVR client body cap even when every character is escaped', () => {
    expect(Buffer.byteLength(buildDownloadBody(`rtsp://h/${'&'.repeat(503)}`), 'utf8')).toBeLessThan(8 * 1024)
  })
  it('replaces starttime and endtime of the address by the wanted NVR instants and changes nothing else', () => {
    const uri = 'rtsp://10.0.0.5/Streaming/tracks/101?starttime=20261022T090000Z&endtime=20261022T100000Z&name=0001&size=123'
    expect(clipPlaybackUri(uri, new Date(Date.UTC(2026, 9, 22, 9, 30, 5)), new Date(Date.UTC(2026, 9, 22, 9, 40, 5)))).toBe(
      'rtsp://10.0.0.5/Streaming/tracks/101?starttime=20261022T093005Z&endtime=20261022T094005Z&name=0001&size=123',
    )
  })
  it('refuses (null) an address without both times: it would download a whole file of unknown size', () => {
    const a = new Date(Date.UTC(2026, 9, 22, 9))
    const b = new Date(Date.UTC(2026, 9, 22, 10))
    expect(clipPlaybackUri('rtsp://h/p?name=1', a, b)).toBeNull()
    expect(clipPlaybackUri('rtsp://h/p?starttime=20261022T090000Z', a, b)).toBeNull()
    expect(clipPlaybackUri('rtsp://h/p?endtime=20261022T090000Z', a, b)).toBeNull()
    expect(clipPlaybackUri('rtsp://h/p', a, b)).toBeNull()
  })
  it('does not let a value with special replacement characters change the result', () => {
    const out = clipPlaybackUri('rtsp://h/p?starttime=$&&name=$1&endtime=$2', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), new Date(Date.UTC(2026, 0, 2, 3, 5, 5)))
    expect(out).toBe('rtsp://h/p?starttime=20260102T030405Z&&name=$1&endtime=20260102T030505Z')
  })
})

describe('the limits on running conversions', () => {
  it('lets one person have one at a time and eight run in all', () => {
    const l = createConversionLimiter()
    const first = l.acquire('a')
    expect(first.ok).toBe(true)
    expect(l.acquire('a')).toEqual({ ok: false, reason: 'person' })
    const others = ['b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => l.acquire(k))
    expect(others.every((x) => x.ok)).toBe(true)
    expect(l.running).toBe(8)
    expect(l.acquire('i')).toEqual({ ok: false, reason: 'total' })
    expect(l.acquire('a')).toEqual({ ok: false, reason: 'person' }) // the person reason wins when both hold
  })
  it('gives the place back on release, once only', () => {
    const l = createConversionLimiter(1, 2)
    const a = l.acquire('a')
    const b = l.acquire('b')
    if (!a.ok || !b.ok) throw new Error('expected places')
    a.release()
    a.release()
    a.release()
    expect(l.running).toBe(1)
    const again = l.acquire('a')
    expect(again.ok).toBe(true)
    expect(l.acquire('c')).toEqual({ ok: false, reason: 'total' })
    b.release()
    expect(l.acquire('c').ok).toBe(true)
  })
  it('a refused request takes nothing, and peek never takes a place', () => {
    const l = createConversionLimiter(1, 1)
    expect(l.peek('a')).toEqual({ ok: true })
    expect(l.running).toBe(0)
    const a = l.acquire('a')
    expect(l.acquire('b')).toEqual({ ok: false, reason: 'total' })
    expect(l.peek('a')).toEqual({ ok: false, reason: 'person' })
    expect(l.running).toBe(1)
    if (a.ok) a.release()
    expect(l.running).toBe(0)
    expect(l.peek('b')).toEqual({ ok: true })
  })
  describe('a person who starts something new', () => {
    it('asks their running conversion to end, waits until its place is back, and then there is room', async () => {
      const l = createConversionLimiter()
      const stopped = vi.fn()
      const old = l.acquire('a', stopped)
      if (!old.ok) throw new Error('expected a place')
      const other = l.acquire('b', vi.fn())
      expect(l.acquire('a')).toEqual({ ok: false, reason: 'person' })
      const pending = l.supersede('a', 5000)
      expect(stopped).toHaveBeenCalledTimes(1)
      let settled: boolean | null = null
      void pending.then((v) => (settled = v))
      await new Promise((r) => setTimeout(r, 30))
      expect(settled).toBeNull() // not before the place is given back
      old.release()
      expect(await pending).toBe(true)
      expect(l.acquire('a').ok).toBe(true)
      expect(other.ok && l.running).toBe(2) // somebody else's is untouched
    })
    it('does not wait longer than asked when the old one will not end', async () => {
      const l = createConversionLimiter()
      l.acquire('a', () => {})
      const t0 = Date.now()
      expect(await l.supersede('a', 100)).toBe(false)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
      expect(l.acquire('a')).toEqual({ ok: false, reason: 'person' })
    })
    it('is at once true when there is nothing running, and a stop that throws does not matter', async () => {
      const l = createConversionLimiter()
      expect(await l.supersede('nobody', 1000)).toBe(true)
      const s = l.acquire('a', () => {
        throw new Error('x')
      })
      const done = l.supersede('a', 1000)
      if (s.ok) s.release()
      expect(await done).toBe(true)
    })
    it('can be asked by two callers at once', async () => {
      const l = createConversionLimiter()
      const s = l.acquire('a', () => {})
      const both = Promise.all([l.supersede('a', 1000), l.supersede('a', 1000)])
      if (s.ok) s.release()
      expect(await both).toEqual([true, true])
    })
  })
  it('peek can leave a person\'s own running conversion out of the count', () => {
    const l = createConversionLimiter(1, 1)
    l.acquire('a')
    expect(l.peek('a')).toEqual({ ok: false, reason: 'person' })
    expect(l.peek('a', { ignoreOwn: true })).toEqual({ ok: true })
    expect(l.peek('b', { ignoreOwn: true })).toEqual({ ok: false, reason: 'total' })
  })
  it('allows more per person when asked to', () => {
    const l = createConversionLimiter(2, 8)
    expect(l.acquire('a').ok).toBe(true)
    expect(l.acquire('a').ok).toBe(true)
    expect(l.acquire('a').ok).toBe(false)
  })
})

describe('the query', () => {
  const q = (s: string) => parseVodQuery(new URLSearchParams(s))
  it('reads a camera, a strict ISO start ending in Z, and whole minutes from 1 to 30', () => {
    const r = q(`camera=${ID.toUpperCase()}&start=2026-10-22T14:30:00Z&minutes=10`)
    expect(r).toMatchObject({ ok: true, query: { camera: ID, minutes: 10, probe: false } })
    if (r.ok) expect(r.query.start.toISOString()).toBe('2026-10-22T14:30:00.000Z')
    expect(q(`camera=${ID}&start=2026-10-22T14:30Z&minutes=1`).ok).toBe(true)
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&minutes=30&probe=1`)).toMatchObject({ ok: true, query: { minutes: 30, probe: true } })
  })
  it('refuses a missing, malformed or repeated camera as "Camera not found." and everything else as a plain message', () => {
    for (const s of ['start=2026-10-22T14:30:00Z&minutes=5', `camera=nope&start=2026-10-22T14:30:00Z&minutes=5`, `camera=${ID}&camera=${ID}&start=2026-10-22T14:30:00Z&minutes=5`]) expect(q(s)).toEqual({ ok: false, error: 'Camera not found.' })
    for (const start of ['', '2026-10-22', '2026-10-22T14:30:00', '2026-10-22T14:30:00+05:30', '2026-10-22 14:30:00Z', '2026-02-30T14:30:00Z', '2026-10-22T25:30:00Z', 'yesterday', '2026-10-22T14:30:00Z%20']) {
      expect(q(`camera=${ID}&start=${encodeURIComponent(start)}&minutes=5`), start).toEqual({ ok: false, error: 'That request is not valid.' })
    }
    expect(q(`camera=${ID}&minutes=5`)).toEqual({ ok: false, error: 'That request is not valid.' })
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&start=2026-10-22T14:31:00Z&minutes=5`).ok).toBe(false)
  })
  it('refuses minutes that are not a whole number from 1 to 30', () => {
    for (const m of ['0', '31', '-1', '1.5', '1e1', '', 'ten', '010x', '100', '+5', ' 5']) expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&minutes=${encodeURIComponent(m)}`).ok, m).toBe(false)
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z`).ok).toBe(false)
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&minutes=5&minutes=6`).ok).toBe(false)
  })
  it('accepts probe only as probe=1, once', () => {
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&minutes=5&probe=0`).ok).toBe(false)
    expect(q(`camera=${ID}&start=2026-10-22T14:30:00Z&minutes=5&probe=1&probe=1`).ok).toBe(false)
  })
})

describe('the conversion', () => {
  let exits = 0
  const onExit = () => {
    exits++
  }
  const logged: string[] = []
  beforeEach(() => {
    exits = 0
    logged.length = 0
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => void logged.push(String(s)))
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => void logged.push(String(s)))
  })
  afterEach(() => vi.restoreAllMocks())

  const run = (src: ReturnType<typeof counting>, spawn: SpawnFn, extra: Partial<Parameters<typeof startConversion>[0]> = {}) =>
    startConversion({ spawn, ffmpeg: 'the-program', source: src.stream, abortSource: () => {}, onExit, killGraceMs: 200, ...extra })

  it('asks for the program it was given with the exact arguments, and passes every byte through unchanged', async () => {
    const src = counting(300_000)
    const spawn = fakeSpawn('copy')
    const r = await run(src, spawn)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(spawn.calls).toEqual([{ command: 'the-program', args: buildFfmpegArgs() }])
    expect(await readAll(r.body)).toBe(300_000)
    await vi.waitFor(() => expect(exits).toBe(1))
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('reads the NVR only as fast as the reader reads the video (back-pressure), and stops everything when the reader cancels', async () => {
    const src = counting(500 * 1024 * 1024)
    const spawn = fakeSpawn('copy')
    const aborted = vi.fn()
    const r = await run(src, spawn, { abortSource: aborted })
    if (!r.ok) throw new Error('expected output')
    const reader = r.body.getReader()
    await reader.read()
    await new Promise((res) => setTimeout(res, 600))
    expect(src.sent).toBeLessThan(8 * 1024 * 1024) // of 500 MB offered
    const before = src.sent
    await new Promise((res) => setTimeout(res, 300))
    expect(src.sent).toBe(before) // and it stays stopped
    const pid = spawn.children[0].pid
    expect(isAlive(pid)).toBe(true)

    await reader.cancel()
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(pid)).toBe(false)
    expect(src.cancelled).toBe(true)
    expect(aborted).toHaveBeenCalled()
  })

  it('resumes after the reader has been slow', async () => {
    const src = counting(3 * 1024 * 1024)
    const r = await run(src, fakeSpawn('copy'))
    if (!r.ok) throw new Error('expected output')
    const reader = r.body.getReader()
    await reader.read()
    await new Promise((res) => setTimeout(res, 200))
    let n = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
    }
    expect(n).toBeGreaterThan(2 * 1024 * 1024)
    await vi.waitFor(() => expect(exits).toBe(1))
  })

  it('answers "format" when ffmpeg ends before any output saying the data is invalid, logs one short line without the address, and gives the place back', async () => {
    const src = counting(10_000)
    const spawn = fakeSpawn('fail')
    const aborted = vi.fn()
    const r = await run(src, spawn, { abortSource: aborted })
    expect(r).toEqual({ ok: false, reason: 'format' })
    await vi.waitFor(() => expect(exits).toBe(1))
    expect(aborted).toHaveBeenCalled()
    expect(isAlive(spawn.children[0].pid)).toBe(false)
    const line = logged.find((l) => l.includes('vod_ffmpeg_ended'))
    expect(line).toBeDefined()
    expect(line).toContain('[address]')
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('10.0.0.5')
    expect(line!.length).toBeLessThan(600)
  })

  it('answers "failed" when ffmpeg ends before any output without a word about the format', async () => {
    const src = counting(10_000)
    const spawn = fakeSpawn('crash')
    expect(await run(src, spawn)).toEqual({ ok: false, reason: 'failed' })
    await vi.waitFor(() => expect(exits).toBe(1))
  })

  it('ends a conversion whose NVR stops sending (no data for the idle time), kills the program and gives the place back', async () => {
    let sent = 0
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ === 0) c.enqueue(new Uint8Array(1000).fill(1))
        else return new Promise(() => {}) // the NVR goes quiet
      },
    })
    const spawn = fakeSpawn('copy')
    const aborted = vi.fn()
    const r = await startConversion({ spawn, ffmpeg: 'x', source, abortSource: aborted, onExit, idleMs: 400, killGraceMs: 200 })
    if (!r.ok) throw new Error('expected output')
    const t0 = Date.now()
    await expect(readAll(r.body)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(3000)
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(aborted).toHaveBeenCalled()
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('does not count the viewer being slow as the NVR being quiet', async () => {
    const src = counting(500 * 1024 * 1024)
    const spawn = fakeSpawn('copy')
    const r = await run(src, spawn, { idleMs: 300 })
    if (!r.ok) throw new Error('expected output')
    const reader = r.body.getReader()
    await reader.read()
    await new Promise((res) => setTimeout(res, 1200)) // four times the idle time with nobody reading
    expect(isAlive(spawn.children[0].pid)).toBe(true)
    expect(exits).toBe(0)
    await reader.read() // and it still delivers
    await reader.cancel()
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
  })

  it('a failure in the set-up after the program has started ends it, kills the program and gives the place back', async () => {
    const src = counting(1000)
    const spawn = fakeSpawn('copy')
    const aborted = vi.fn()
    const r = await startConversion({
      spawn,
      ffmpeg: 'x',
      source: src.stream,
      abortSource: aborted,
      onExit,
      killGraceMs: 200,
      toNodeStream: () => {
        throw new Error('cannot make the stream')
      },
    })
    expect(r).toEqual({ ok: false, reason: 'failed' })
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(aborted).toHaveBeenCalled()
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('ends the video with an error when ffmpeg fails after it has started', async () => {
    const src = counting(10 * 1024 * 1024)
    const spawn = fakeSpawn('fail-late')
    const r = await run(src, spawn)
    if (!r.ok) throw new Error('expected output')
    await expect(readAll(r.body)).rejects.toThrow()
    await vi.waitFor(() => expect(exits).toBe(1))
    expect(src.cancelled).toBe(true)
  })

  it('gives up on a program that makes no output within the time, and kills it', async () => {
    const src = counting(1000)
    const spawn = fakeSpawn('hang')
    const r = await run(src, spawn, { firstByteMs: 250 })
    expect(r).toEqual({ ok: false, reason: 'timeout' })
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('ends the video cleanly when the longest total time passes, and kills the program that is still there', async () => {
    const src = counting(10_000)
    const spawn = fakeSpawn('linger')
    const r = await run(src, spawn, { maxMs: 500 })
    if (!r.ok) throw new Error('expected output')
    expect(await readAll(r.body)).toBe(10_000) // the video ends; no error
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('stops when the person goes away (the signal aborts)', async () => {
    const src = counting(500 * 1024 * 1024)
    const spawn = fakeSpawn('copy')
    const gone = new AbortController()
    const r = await run(src, spawn, { signal: gone.signal })
    if (!r.ok) throw new Error('expected output')
    const reader = r.body.getReader()
    await reader.read()
    gone.abort()
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return 'ended'
      })(),
    ).rejects.toThrow()
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(spawn.children[0].pid)).toBe(false)
    expect(src.cancelled).toBe(true)
  })

  it('does not even start the program when the person is already gone before it', async () => {
    const src = counting(1000)
    const spawn = fakeSpawn('copy')
    const gone = new AbortController()
    gone.abort()
    const r = await run(src, spawn, { signal: gone.signal })
    expect(r).toEqual({ ok: false, reason: 'cancelled' })
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(spawn.children[0]?.pid)).toBe(false)
  })

  it('ends the video with an error, and kills the program, when the NVR transfer fails midway', async () => {
    let n = 0
    const source = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (n++ < 3) return c.enqueue(new Uint8Array(1000).fill(1))
        await new Promise((res) => setTimeout(res, 400)) // long enough for the first output to be passed on
        c.error(new Error('NVR went away'))
      },
    })
    const spawn = fakeSpawn('linger')
    const r = await startConversion({ spawn, ffmpeg: 'x', source, abortSource: () => {}, onExit, killGraceMs: 200 })
    if (!r.ok) throw new Error('expected output')
    await expect(readAll(r.body)).rejects.toThrow()
    await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 })
    expect(isAlive(spawn.children[0].pid)).toBe(false)
  })

  it('reports a program that is not there as "missing" (nothing is thrown), stops the NVR transfer and gives the place back', async () => {
    const src = counting(1000)
    const aborted = vi.fn()
    const r = await startConversion({ spawn: defaultSpawn, ffmpeg: 'definitely-not-an-installed-program-xyz', source: src.stream, abortSource: aborted, onExit })
    expect(r).toEqual({ ok: false, reason: 'missing' })
    await vi.waitFor(() => expect(exits).toBe(1))
    expect(aborted).toHaveBeenCalled()
    expect(src.cancelled).toBe(true)
  })

  it('reports a spawn that throws as "missing" for a missing file and "failed" otherwise', async () => {
    const throwing = (code: string): SpawnFn => () => {
      throw Object.assign(new Error('x'), { code })
    }
    expect(await startConversion({ spawn: throwing('ENOENT'), ffmpeg: 'x', source: counting(1).stream, abortSource: () => {}, onExit })).toEqual({ ok: false, reason: 'missing' })
    expect(await startConversion({ spawn: throwing('EMFILE'), ffmpeg: 'x', source: counting(1).stream, abortSource: () => {}, onExit })).toEqual({ ok: false, reason: 'failed' })
    expect(exits).toBe(2)
  })

  describe('killing', () => {
    class FakeChild extends EventEmitter {
      stdin = new PassThrough()
      stdout = new PassThrough()
      stderr = new PassThrough()
      kill = vi.fn<(signal?: string) => boolean>(() => true)
    }
    afterEach(() => vi.useRealTimers())

    it('asks the program to stop first, kills it after the grace time if it is still there, and gives the place back only when it has really gone', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const child = new FakeChild()
      const gone = new AbortController()
      const p = startConversion({ spawn: () => child as never, ffmpeg: 'x', source: counting(1_000_000).stream, abortSource: () => {}, onExit, signal: gone.signal, killGraceMs: 3000 })
      child.stdout.write(Buffer.from('x'))
      const r = await p
      if (!r.ok) throw new Error('expected output')
      void r.body.cancel()
      await vi.advanceTimersByTimeAsync(0)
      expect(child.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(2900)
      expect(child.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(200)
      expect(child.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGKILL'])
      expect(exits).toBe(0) // still not gone
      child.emit('close', null, 'SIGKILL')
      expect(exits).toBe(1)
      child.emit('close', null, 'SIGKILL')
      expect(exits).toBe(1)
    })

    it('does not kill outright a program that stopped on the polite request', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const child = new FakeChild()
      const p = startConversion({ spawn: () => child as never, ffmpeg: 'x', source: counting(1_000_000).stream, abortSource: () => {}, onExit, killGraceMs: 3000 })
      child.stdout.write(Buffer.from('x'))
      const r = await p
      if (!r.ok) throw new Error('expected output')
      void r.body.cancel()
      await vi.advanceTimersByTimeAsync(0)
      child.emit('close', null, 'SIGTERM')
      expect(exits).toBe(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(child.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM'])
    })

    it('sends the error output of the program nowhere but a short log line, and reads it so the program never blocks on it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const child = new FakeChild()
      const p = startConversion({ spawn: () => child as never, ffmpeg: 'x', source: counting(1_000_000).stream, abortSource: () => {}, onExit })
      child.stderr.write('a'.repeat(100_000) + ' rtsp://u:pw@h/x')
      child.emit('close', 1, null)
      expect(await p).toEqual({ ok: false, reason: 'failed' })
      const line = logged.find((l) => l.includes('vod_ffmpeg_ended'))!
      expect(line.length).toBeLessThan(500)
      expect(line).not.toContain('pw@h')
    })
  })
})

describe('the check that ffmpeg runs', () => {
  class FakeChild extends EventEmitter {
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    kill = vi.fn<(signal?: string) => boolean>(() => true)
  }
  // P4-L2 review I-1: the check also needs ffmpeg 5.0 or newer (-readrate), read from `-version`'s first line.
  const spawnReturning = (code: number | 'error' | 'hang', version = 'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers\n') => {
    const calls: { command: string; args: string[] }[] = []
    const spawn: SpawnFn = (command, args) => {
      calls.push({ command, args })
      const c = new FakeChild()
      queueMicrotask(() => {
        if (code === 'error') c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
        else if (code !== 'hang') {
          c.stdout.end(version)
          setTimeout(() => c.emit('close', code, null), 5)
        }
      })
      return c as never
    }
    return Object.assign(spawn, { calls })
  }

  const lookup = { platform: 'linux' as const, exists: () => true }
  const E = { PATH: '/usr/bin' }
  const make = (o: Parameters<typeof createFfmpegCheck>[0] = {}) => createFfmpegCheck({ lookup, ...o })

  it('is true when `<program> -version` ends with 0, false when it fails, does not exist or hangs', async () => {
    expect(await make({ spawn: spawnReturning(0) })(E)).toBe(true)
    expect(await make({ spawn: spawnReturning(1) })(E)).toBe(false)
    expect(await make({ spawn: spawnReturning('error') })(E)).toBe(false)
    expect(await make({ spawn: spawnReturning('hang'), timeoutMs: 50 })(E)).toBe(false)
    expect(await make({ spawn: () => { throw new Error('boom') } })(E)).toBe(false)
  })

  it('review I-1: an ffmpeg older than 5.0, or one that does not say its version, is not enough', async () => {
    expect(await make({ spawn: spawnReturning(0, 'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright\n') })(E)).toBe(false)
    expect(await make({ spawn: spawnReturning(0, '') })(E)).toBe(false)
    expect(await make({ spawn: spawnReturning(0, 'ffmpeg version 5.1.4 Copyright\n') })(E)).toBe(true)
  })

  // Release 1 clean-ups (P4-L2 re-review N-4): a dated git build says "ffmpeg version 2024-05-13-git-…" — no release number. Instead of
  // refusing it, the check asks the program itself whether it has -readrate (`-hide_banner -h full`).
  it('N-4: a build without a release number passes when its help lists -readrate, and fails when it does not', async () => {
    const answering = (versionText: string, helpText: string) => {
      const calls: string[][] = []
      const spawn: SpawnFn = (_command, args) => {
        calls.push(args)
        const c = new FakeChild()
        queueMicrotask(() => {
          c.stdout.end(args.includes('-version') ? versionText : helpText)
          setTimeout(() => c.emit('close', 0, null), 5)
        })
        return c as never
      }
      return Object.assign(spawn, { calls })
    }
    const git = 'ffmpeg version 2024-05-13-git-37db0454e4-essentials_build-www.gyan.dev Copyright (c) 2000-2024\n'
    const withReadrate = answering(git, 'Advanced per-input options:\n-re                 read input at native frame rate\n-readrate speed     read input at specified rate\n')
    expect(await make({ spawn: withReadrate })(E)).toBe(true)
    expect(withReadrate.calls).toEqual([['-version'], ['-hide_banner', '-h', 'full']])
    expect(await make({ spawn: answering(git, 'Advanced per-input options:\n-re   read input at native frame rate\n') })(E)).toBe(false)
    // A release number decides alone: an old release is refused without asking further, a new one is not asked either.
    const old = answering('ffmpeg version 4.4.2 Copyright\n', '-readrate speed read input at specified rate\n')
    expect(await make({ spawn: old })(E)).toBe(false)
    expect(old.calls).toEqual([['-version']])
    expect(ffmpegHelpHasReadrate('  -readrate speed   read input at specified rate')).toBe(true)
    expect(ffmpegHelpHasReadrate('-readrate_initial_burst  something')).toBe(false)
  })

  it('runs the program from the setting with only -version, and says false at once for a setting that is refused', async () => {
    const spawn = spawnReturning(0)
    const check = make({ spawn })
    expect(await check({ FFMPEG: '/opt/ffmpeg' })).toBe(true)
    expect(spawn.calls).toEqual([{ command: '/opt/ffmpeg', args: ['-version'] }])
    expect(await check({ FFMPEG: 'x\ny' })).toBe(false)
    expect(spawn.calls).toHaveLength(1)
  })

  it('remembers the answer for 60 seconds per program, then asks again', async () => {
    let t = 1_000_000
    const spawn = spawnReturning(0)
    const check = make({ spawn, now: () => t })
    expect(await check(E)).toBe(true)
    expect(await check(E)).toBe(true)
    expect(spawn.calls).toHaveLength(1)
    expect(await check({ FFMPEG: '/opt/other' })).toBe(true)
    expect(spawn.calls).toHaveLength(2)
    t += 59_000
    await check(E)
    expect(spawn.calls).toHaveLength(2)
    t += 2_000
    await check(E)
    expect(spawn.calls).toHaveLength(3)
  })

  it('shares one running check between callers who ask at the same time', async () => {
    const spawn = spawnReturning(0)
    const check = make({ spawn })
    const all = await Promise.all([check(E), check(E), check(E)])
    expect(all).toEqual([true, true, true])
    expect(spawn.calls).toHaveLength(1)
  })

  it('is false when ffmpeg is nowhere on PATH', async () => {
    const spawn = spawnReturning(0)
    expect(await createFfmpegCheck({ spawn, lookup: { platform: 'linux', exists: () => false } })(E)).toBe(false)
    expect(spawn.calls).toHaveLength(0)
  })

  it('finds out for real that a program that is not there does not run', async () => {
    expect(await createFfmpegCheck()({ FFMPEG: path.resolve('definitely-not-an-installed-program-xyz') })).toBe(false)
  })
})
