import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDownloadBody,
  buildFfmpegArgs,
  clipPlaybackUri,
  createConversionLimiter,
  createFfmpegCheck,
  defaultSpawn,
  parseVodQuery,
  resolveFfmpeg,
  sanitizeStderr,
  startConversion,
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
  it('are exactly the ones the brief names: input from standard input, no sound, picture copied, fragmented MP4 to standard output', () => {
    expect(buildFfmpegArgs()).toEqual(['-loglevel', 'error', '-i', 'pipe:0', '-an', '-c:v', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'])
  })
  it('come back fresh each time, so one caller cannot change what the next one runs', () => {
    buildFfmpegArgs().push('-evil')
    expect(buildFfmpegArgs()).toHaveLength(14)
  })
})

describe('the FFMPEG setting', () => {
  it('defaults to ffmpeg when it is not set or blank', () => {
    expect(resolveFfmpeg({})).toBe('ffmpeg')
    expect(resolveFfmpeg({ FFMPEG: '' })).toBe('ffmpeg')
    expect(resolveFfmpeg({ FFMPEG: '   ' })).toBe('ffmpeg')
  })
  it('takes a name or a path, trimmed', () => {
    expect(resolveFfmpeg({ FFMPEG: ' C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe ' })).toBe('C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe')
    expect(resolveFfmpeg({ FFMPEG: '/usr/local/bin/ffmpeg' })).toBe('/usr/local/bin/ffmpeg')
    expect(resolveFfmpeg({ FFMPEG: 'ffmpeg\r\n' })).toBe('ffmpeg') // the line ending of an env file
  })
  it('refuses a value with a line break, a NUL or any control character, and one that is far too long', () => {
    for (const bad of ['ffmpeg\n-i x', 'ffmpeg\r-i', 'ff\u0000mpeg', 'ffmpeg\u0007', 'ffmpeg\u007f', 'a\nb', `/${'x'.repeat(1030)}`]) expect(resolveFfmpeg({ FFMPEG: bad }), JSON.stringify(bad).slice(0, 30)).toBeNull()
  })
  it('is run without a shell and with the arguments as a list', () => {
    const src = defaultSpawn.toString()
    expect(src).toContain('shell: false')
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
    expect(body).toContain('<playbackURI>rtsp://10.0.0.5/Streaming/tracks/101?starttime=20261022T100000Z&#38;endtime=20261022T101000Z&#38;name=a&#34;b&#60;c&#62;&#39;d</playbackURI>')
    expect(body).not.toMatch(/&(?!#)/)
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
  it('leaves an address without both times as it is', () => {
    const a = new Date(Date.UTC(2026, 9, 22, 9))
    const b = new Date(Date.UTC(2026, 9, 22, 10))
    expect(clipPlaybackUri('rtsp://h/p?name=1', a, b)).toBe('rtsp://h/p?name=1')
    expect(clipPlaybackUri('rtsp://h/p?starttime=20261022T090000Z', a, b)).toBe('rtsp://h/p?starttime=20261022T090000Z')
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

  it('answers "failed" when ffmpeg ends before any output, logs one short line without the address, and gives the place back', async () => {
    const src = counting(10_000)
    const spawn = fakeSpawn('fail')
    const aborted = vi.fn()
    const r = await run(src, spawn, { abortSource: aborted })
    expect(r).toEqual({ ok: false, reason: 'failed' })
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
  const spawnReturning = (code: number | 'error' | 'hang') => {
    const calls: { command: string; args: string[] }[] = []
    const spawn: SpawnFn = (command, args) => {
      calls.push({ command, args })
      const c = new FakeChild()
      queueMicrotask(() => {
        if (code === 'error') c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
        else if (code !== 'hang') c.emit('close', code, null)
      })
      return c as never
    }
    return Object.assign(spawn, { calls })
  }

  it('is true when `<program> -version` ends with 0, false when it fails, does not exist or hangs', async () => {
    expect(await createFfmpegCheck({ spawn: spawnReturning(0) })({})).toBe(true)
    expect(await createFfmpegCheck({ spawn: spawnReturning(1) })({})).toBe(false)
    expect(await createFfmpegCheck({ spawn: spawnReturning('error') })({})).toBe(false)
    expect(await createFfmpegCheck({ spawn: spawnReturning('hang'), timeoutMs: 50 })({})).toBe(false)
    expect(await createFfmpegCheck({ spawn: () => { throw new Error('boom') } })({})).toBe(false)
  })

  it('runs the program from the setting with only -version, and says false at once for a setting that is refused', async () => {
    const spawn = spawnReturning(0)
    const check = createFfmpegCheck({ spawn })
    expect(await check({ FFMPEG: '/opt/ffmpeg' })).toBe(true)
    expect(spawn.calls).toEqual([{ command: '/opt/ffmpeg', args: ['-version'] }])
    expect(await check({ FFMPEG: 'x\ny' })).toBe(false)
    expect(spawn.calls).toHaveLength(1)
  })

  it('remembers the answer for 60 seconds per program, then asks again', async () => {
    let t = 1_000_000
    const spawn = spawnReturning(0)
    const check = createFfmpegCheck({ spawn, now: () => t })
    expect(await check({})).toBe(true)
    expect(await check({})).toBe(true)
    expect(spawn.calls).toHaveLength(1)
    expect(await check({ FFMPEG: 'other' })).toBe(true)
    expect(spawn.calls).toHaveLength(2)
    t += 59_000
    await check({})
    expect(spawn.calls).toHaveLength(2)
    t += 2_000
    await check({})
    expect(spawn.calls).toHaveLength(3)
  })

  it('shares one running check between callers who ask at the same time', async () => {
    const spawn = spawnReturning(0)
    const check = createFfmpegCheck({ spawn })
    const all = await Promise.all([check({}), check({}), check({})])
    expect(all).toEqual([true, true, true])
    expect(spawn.calls).toHaveLength(1)
  })

  it('finds out for real that a program that is not there does not run', async () => {
    expect(await createFfmpegCheck({})({ FFMPEG: 'definitely-not-an-installed-program-xyz' })).toBe(false)
  })
})
