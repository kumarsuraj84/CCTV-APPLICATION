import { afterEach, describe, expect, it } from 'vitest'
import { NvrClient, NvrError } from '@/lib/nvr/client'
import { buildSearchBody, findSegments, parseDailyDistribution, parseSearchResult, recordedDays } from '@/lib/nvr/playback'
import { closedPort, startFakeNvr, type FakeNvr } from '../helpers/fake-servers'

let nvr: FakeNvr | null = null
afterEach(async () => {
  await nvr?.close()
  nvr = null
})
const client = (port: number, password = 'secret-pass', timeoutMs = 4000) => new NvrClient({ host: '127.0.0.1', port, username: 'viewer', password }, { timeoutMs })

const item = (s: string, e: string, uri?: string) =>
  `<searchMatchItem><sourceID>x</sourceID><trackID>101</trackID><timeSpan><startTime>${s}</startTime><endTime>${e}</endTime></timeSpan><mediaSegmentDescriptor><contentType>video</contentType>${uri === undefined ? '' : `<playbackURI>${uri}</playbackURI>`}</mediaSegmentDescriptor></searchMatchItem>`
const answer = (items: string[], status = 'OK') =>
  `<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><searchID>x</searchID><responseStatus>true</responseStatus><responseStatusStrg>${status}</responseStatusStrg><numOfMatches>${items.length}</numOfMatches><matchList>${items.join('')}</matchList></CMSearchResult>`
const segsOf = async (c: NvrClient, o: { channel: number; day: string; offsetMin: number }) => (await findSegments(c, o)).segments
const iso = (segs: { start: Date; end: Date }[]) => segs.map((s) => [s.start.toISOString(), s.end.toISOString()])

describe('buildSearchBody', () => {
  const base = { channel: 1, start: new Date('2026-10-20T01:02:03Z'), end: new Date('2026-10-20T04:05:06Z'), position: 0, limit: 200, searchId: 'abc-123' }
  it('writes the elements the NVR expects, with its own spelling of searchResultPostion and Z times', () => {
    expect(buildSearchBody(base)).toBe(
      "<?xml version='1.0' encoding='utf-8'?>" +
        '<CMSearchDescription><searchID>abc-123</searchID><trackIDList><trackID>101</trackID></trackIDList>' +
        '<timeSpanList><timeSpan><startTime>2026-10-20T01:02:03Z</startTime><endTime>2026-10-20T04:05:06Z</endTime></timeSpan></timeSpanList>' +
        '<maxResults>200</maxResults><searchResultPostion>0</searchResultPostion>' +
        '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>',
    )
  })
  it('uses the channel for the track id, the position and the limit', () => {
    const body = buildSearchBody({ ...base, channel: 12, position: 400, limit: 50 })
    expect(body).toContain('<trackID>1201</trackID>')
    expect(body).toContain('<searchResultPostion>400</searchResultPostion>')
    expect(body).toContain('<maxResults>50</maxResults>')
  })
  it('drops fractions of a second and always writes UTC', () => {
    const body = buildSearchBody({ ...base, start: new Date('2026-10-20T01:02:03.999Z') })
    expect(body).toContain('<startTime>2026-10-20T01:02:03Z</startTime>')
  })
  it('accepts a UUID as the search id', () => {
    expect(buildSearchBody({ ...base, searchId: '3f2b8c1e-5d0a-4c1b-9e2f-7a6b5c4d3e2f' })).toContain('<searchID>3f2b8c1e-5d0a-4c1b-9e2f-7a6b5c4d3e2f</searchID>')
  })
  it.each([0, 4097, 1.5, Number.NaN, -1, '1' as unknown as number])('refuses channel %s', (channel) => {
    expect(() => buildSearchBody({ ...base, channel })).toThrow(Error)
  })
  it.each([0, 201, 1.5, Number.NaN, -5, Infinity])('refuses limit %s', (limit) => {
    expect(() => buildSearchBody({ ...base, limit })).toThrow(Error)
  })
  it.each([-1, 1.5, Number.NaN, Infinity])('refuses position %s', (position) => {
    expect(() => buildSearchBody({ ...base, position })).toThrow(Error)
  })
  it.each(['', 'a b', '<x/>', 'a&b', 'a"b', 'a\r\nb', 'x'.repeat(65), 'é'])('refuses search id %j', (searchId) => {
    expect(() => buildSearchBody({ ...base, searchId })).toThrow(Error)
  })
  it('refuses dates that are not real or not in order', () => {
    expect(() => buildSearchBody({ ...base, start: new Date('nope') })).toThrow(Error)
    expect(() => buildSearchBody({ ...base, end: new Date(Number.NaN) })).toThrow(Error)
    expect(() => buildSearchBody({ ...base, end: base.start })).toThrow(Error)
    expect(() => buildSearchBody({ ...base, end: new Date('2026-10-19T00:00:00Z') })).toThrow(Error)
    expect(() => buildSearchBody({ ...base, start: '2026-10-20T01:02:03Z' as unknown as Date })).toThrow(Error)
  })
  it('never lets an error echo the search id', () => {
    try {
      buildSearchBody({ ...base, searchId: 'bad id <secret>' })
    } catch (e) {
      expect(String(e)).not.toContain('secret')
    }
  })
})

describe('parseSearchResult', () => {
  it('reads two segments and no MORE', () => {
    const r = parseSearchResult(answer([item('2026-10-20T09:00:00Z', '2026-10-20T09:30:00Z'), item('2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z')]))
    expect(r.more).toBe(false)
    expect(iso(r.segments)).toEqual([['2026-10-20T09:00:00.000Z', '2026-10-20T09:30:00.000Z'], ['2026-10-20T12:00:00.000Z', '2026-10-20T13:00:00.000Z']])
  })
  it('reads MORE, whatever its case or spacing', () => {
    const one = [item('2026-10-20T09:00:00Z', '2026-10-20T09:30:00Z')]
    expect(parseSearchResult(answer(one, 'MORE')).more).toBe(true)
    expect(parseSearchResult(answer(one, ' more \n')).more).toBe(true)
    expect(parseSearchResult(answer(one, 'OK')).more).toBe(false)
    expect(parseSearchResult(answer(one, 'MOREOVER')).more).toBe(false)
  })
  it('gives nothing for an empty answer, no matches, or text that is not XML', () => {
    expect(parseSearchResult(answer([], 'NO MATCHES'))).toEqual({ segments: [], more: false })
    expect(parseSearchResult('')).toEqual({ segments: [], more: false })
    expect(parseSearchResult('this is not xml')).toEqual({ segments: [], more: false })
  })
  it('sorts by start and drops identical segments', () => {
    const r = parseSearchResult(
      answer([
        item('2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z'),
        item('2026-10-20T09:00:00Z', '2026-10-20T09:30:00Z'),
        item('2026-10-20T12:00:00Z', '2026-10-20T13:00:00Z'),
      ]),
    )
    expect(iso(r.segments).map((s) => s[0])).toEqual(['2026-10-20T09:00:00.000Z', '2026-10-20T12:00:00.000Z'])
  })
  it('ignores items with times that are missing, not real, not UTC, empty or in the wrong order', () => {
    const r = parseSearchResult(
      answer([
        item('2026-10-20T13:00:00Z', '2026-10-20T12:00:00Z'), // inverted
        item('2026-10-20T13:00:00Z', '2026-10-20T13:00:00Z'), // empty
        item('2026-02-30T13:00:00Z', '2026-03-01T12:00:00Z'), // no such day
        item('2026-13-01T13:00:00Z', '2026-13-01T14:00:00Z'), // no such month
        item('2026-10-20T25:00:00Z', '2026-10-20T26:00:00Z'), // no such hour
        item('2026-10-20T13:00:00.', '2026-10-20T14:00:00.'), // a dot and no digits
        item('2026-10-20 13:00:00Z', '2026-10-20 14:00:00Z'), // no T
        item('2026-10-20T13:00:00-05:00', '2026-10-20T14:00:00-05:00'), // an offset
        item('2026-10-20T13:00:00.1234567890Z', '2026-10-20T14:00:00Z'), // ten fraction digits
        item('2026-10-20T13:00:00+05:30', '2026-10-20T14:00:00+05:30'), // an offset
        item('yesterday', 'today'),
        item('', ''),
        '<searchMatchItem><timeSpan><startTime>2026-10-20T13:00:00Z</startTime></timeSpan></searchMatchItem>', // no end
        '<searchMatchItem>nothing here</searchMatchItem>',
        item('2026-10-20T14:00:00Z', '2026-10-20T15:00:00Z'), // the only good one
      ]),
    )
    expect(iso(r.segments)).toEqual([['2026-10-20T14:00:00.000Z', '2026-10-20T15:00:00.000Z']])
  })
  it('reads times with or without Z and with up to nine fraction digits (cut to milliseconds)', () => {
    const r = parseSearchResult(
      answer([
        item('2026-10-20T01:00:00', '2026-10-20T02:00:00'),
        item('2026-10-20T03:00:00.123456789', '2026-10-20T04:00:00.9999999Z'),
        item('2026-10-20T05:00:00.5', '2026-10-20T06:00:00.05Z'),
      ]),
    )
    expect(iso(r.segments)).toEqual([
      ['2026-10-20T01:00:00.000Z', '2026-10-20T02:00:00.000Z'],
      ['2026-10-20T03:00:00.123Z', '2026-10-20T04:00:00.999Z'],
      ['2026-10-20T05:00:00.500Z', '2026-10-20T06:00:00.050Z'],
    ])
  })
  it('reads a fraction of a second, entities and CDATA in times, and refuses markup smuggled into them', () => {
    const r = parseSearchResult(
      answer([
        item('2026-10-20T01:00:00.500Z', '2026-10-20T02:00:00Z'),
        item('2026-10-20T03:00:00&#x5A;', '2026-10-20T04:00:00Z'),
        item('<![CDATA[2026-10-20T05:00:00Z]]>', '2026-10-20T06:00:00Z'),
        item('2026-10-20T07:00:00&lt;b&gt;Z', '2026-10-20T08:00:00Z'),
      ]),
    )
    expect(iso(r.segments)).toEqual([
      ['2026-10-20T01:00:00.500Z', '2026-10-20T02:00:00.000Z'],
      ['2026-10-20T03:00:00.000Z', '2026-10-20T04:00:00.000Z'],
      ['2026-10-20T05:00:00.000Z', '2026-10-20T06:00:00.000Z'],
    ])
  })
  it('does not mix up similar tag names', () => {
    const xml = `<CMSearchResult><searchMatchItemList><x/></searchMatchItemList><responseStatusStrg>OK</responseStatusStrg></CMSearchResult>`
    expect(parseSearchResult(xml).segments).toEqual([])
  })
  it('keeps at most 5000 segments from one answer', () => {
    const base = Date.UTC(2026, 0, 1)
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
    const items: string[] = []
    for (let i = 0; i < 6000; i++) items.push(item(stamp(base + i * 60_000), stamp(base + i * 60_000 + 30_000)))
    expect(parseSearchResult(answer(items)).segments).toHaveLength(5000)
  })
  it('stays fast on hostile input: unclosed tags, nested items, a long run of angle brackets', () => {
    const cases = [
      '<searchMatchItem>'.repeat(60_000),
      '<searchMatchItem>'.repeat(60_000) + '</searchMatchItem>',
      '<searchMatchItem><timeSpan><startTime>'.repeat(30_000),
      '<'.repeat(1_000_000),
      '<searchMatchItem'.repeat(60_000),
      `<searchMatchItem>${'<timeSpan>'.repeat(100_000)}</searchMatchItem>`,
      `<responseStatusStrg>${'MORE'.repeat(250_000)}`,
    ]
    for (const c of cases) {
      const t = Date.now()
      parseSearchResult(c)
      expect(Date.now() - t).toBeLessThan(1500)
    }
  })
})

describe('parseSearchResult playback address', () => {
  const uriOf = (uri: string | undefined) => parseSearchResult(answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', uri)])).segments[0]?.uri
  it('keeps an rtsp, http or https address as written (entities decoded)', () => {
    expect(uriOf('rtsp://192.0.2.1/Streaming/tracks/101?starttime=20261020T090000Z&amp;endtime=20261020T100000Z&amp;name=00001')).toBe('rtsp://192.0.2.1/Streaming/tracks/101?starttime=20261020T090000Z&endtime=20261020T100000Z&name=00001')
    expect(uriOf('http://192.0.2.1/x')).toBe('http://192.0.2.1/x')
    expect(uriOf('HTTPS://192.0.2.1/x')).toBe('HTTPS://192.0.2.1/x')
  })
  it.each([
    ['nothing', undefined],
    ['an empty one', ''],
    ['another scheme', 'ftp://192.0.2.1/x'],
    ['javascript', 'javascript:alert(1)'],
    ['no scheme', '192.0.2.1/x'],
    ['a space', 'rtsp://192.0.2.1/a b'],
    ['a line break (as an entity)', 'rtsp://192.0.2.1/a&#10;b'],
    ['a tab', 'rtsp://192.0.2.1/a&#9;b'],
    ['a NUL character', 'rtsp://192.0.2.1/a b'],
    ['a DEL', 'rtsp://192.0.2.1/a&#127;b'],
    ['513 characters', `rtsp://${'a'.repeat(513 - 7)}`],
  ])('leaves the address out for %s but keeps the segment', (_n, uri) => {
    const r = parseSearchResult(answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', uri)]))
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].uri).toBeUndefined()
    expect('uri' in r.segments[0]).toBe(false)
  })
  it('accepts exactly 512 characters', () => {
    expect(uriOf(`rtsp://${'a'.repeat(512 - 7)}`)).toHaveLength(512)
  })
  it('keeps the address of the first copy of a repeated segment, or fills it from a later one', () => {
    const r = parseSearchResult(answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z'), item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', 'rtsp://192.0.2.1/x')]))
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].uri).toBe('rtsp://192.0.2.1/x')
  })
})

describe('parseDailyDistribution', () => {
  const day = (d: string, rec: string) => `<day><dayOfMonth>${d}</dayOfMonth><record>${rec}</record><recordType>CMR</recordType></day>`
  const xml = (days: string[]) => `<?xml version="1.0"?><trackDailyDistribution version="2.0"><dayList>${days.join('')}</dayList></trackDailyDistribution>`
  it('lists only the days with recordings', () => {
    expect(parseDailyDistribution(xml([day('1', 'false'), day('2', 'true'), day('3', 'false'), day('4', 'true')]))).toEqual([2, 4])
  })
  it('sorts, drops repeats and ignores days that cannot exist', () => {
    expect(parseDailyDistribution(xml([day('20', 'true'), day('3', 'TRUE'), day('20', 'true'), day('0', 'true'), day('32', 'true'), day('x', 'true'), day('', 'true'), day('5', 'maybe')]))).toEqual([3, 20])
  })
  it('gives nothing for an empty or unusable answer', () => {
    expect(parseDailyDistribution(xml([]))).toEqual([])
    expect(parseDailyDistribution('')).toEqual([])
    expect(parseDailyDistribution('not xml')).toEqual([])
  })
  it('stays fast on hostile input', () => {
    for (const c of ['<day>'.repeat(200_000), '<day><dayOfMonth>1'.repeat(60_000), '<dayOfMonth>'.repeat(80_000), `<day>${'<record>'.repeat(100_000)}</day>`]) {
      const t = Date.now()
      parseDailyDistribution(c)
      expect(Date.now() - t).toBeLessThan(1500)
    }
  })
})

// NVR clock terms below are ISO instants as the fake NVR reports them (it writes them with a Z).
const RECORDINGS = [
  { start: '2026-10-19T17:00:00', end: '2026-10-19T17:30:00' }, // before the window
  { start: '2026-10-19T18:00:00', end: '2026-10-19T19:00:00' }, // starts before the window opens
  { start: '2026-10-20T09:00:00', end: '2026-10-20T09:30:00' },
  { start: '2026-10-20T12:00:00', end: '2026-10-20T13:00:00' },
  { start: '2026-10-20T18:00:00', end: '2026-10-20T19:00:00' }, // runs past the window end
  { start: '2026-10-20T19:00:00', end: '2026-10-20T20:00:00' }, // after the window
]
const searchPosts = (n: FakeNvr) => n.posts.filter((p) => p.path === '/ISAPI/ContentMgmt/search')
const positions = (n: FakeNvr) => searchPosts(n).map((p) => Number(/<searchResultPostion>(\d+)</.exec(p.body)![1]))

describe('findSegments against the fake NVR', () => {
  it('pages until there is no more and shifts the shown times forward by the offset (ruling R13)', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    const segs = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 330 })
    expect(segs.every((s) => s.start instanceof Date && s.end instanceof Date)).toBe(true)
    expect(iso(segs)).toEqual([
      ['2026-10-19T23:30:00.000Z', '2026-10-20T00:30:00.000Z'], // nothing is clipped to the day
      ['2026-10-20T14:30:00.000Z', '2026-10-20T15:00:00.000Z'],
      ['2026-10-20T17:30:00.000Z', '2026-10-20T18:30:00.000Z'],
      ['2026-10-20T23:30:00.000Z', '2026-10-21T00:30:00.000Z'],
    ])
    expect(positions(nvr)).toEqual([0, 2]) // two pages of two
  })
  it('asks the NVR for [day 00:00 - offset, next day 00:00 - offset)', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    await segsOf(client(nvr.port), { channel: 5, day: '2026-10-20', offsetMin: 330 })
    const body = searchPosts(nvr)[0].body
    expect(body).toContain('<startTime>2026-10-19T18:30:00Z</startTime>')
    expect(body).toContain('<endTime>2026-10-20T18:30:00Z</endTime>')
    expect(body).toContain('<trackID>501</trackID>')
    expect(body).toContain('<maxResults>200</maxResults>')
    expect(searchPosts(nvr)[0].contentType).toBe('application/xml')
  })
  it('works with offset 0 and with a negative offset', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    const zero = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(iso(zero).map((s) => s[0])).toEqual(['2026-10-20T09:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-20T18:00:00.000Z', '2026-10-20T19:00:00.000Z'])
    const neg = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: -60 })
    // window is [01:00, next day 01:00) in NVR terms; shown = NVR - 60 min
    expect(iso(neg)[0]).toEqual(['2026-10-20T08:00:00.000Z', '2026-10-20T08:30:00.000Z'])
  })
  it('P2-5b: a per-recorder offset in seconds asks for [day - offset) and shows NVR time + offset, to the second', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    const found = await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetSec: 330 * 60 + 30 })
    const body = searchPosts(nvr)[0].body
    expect(body).toContain('<startTime>2026-10-19T18:29:30Z</startTime>')
    expect(body).toContain('<endTime>2026-10-20T18:29:30Z</endTime>')
    expect(found.segments[1].start.toISOString()).toBe('2026-10-20T14:30:30.000Z')
    await expect(findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetSec: 86_401 })).rejects.toThrow()
    await expect(findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetSec: 1.5 })).rejects.toThrow()
    await expect(findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetSec: 60, offsetMin: 1 } as never)).rejects.toThrow()
  })
  it('uses a new search id for each call and the same one for every page of a call', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    const c = client(nvr.port)
    await segsOf(c, { channel: 1, day: '2026-10-20', offsetMin: 330 })
    await segsOf(c, { channel: 1, day: '2026-10-20', offsetMin: 330 })
    const ids = searchPosts(nvr).map((p) => /<searchID>([A-Za-z0-9-]+)</.exec(p.body)![1])
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).toBe(ids[3])
    expect(ids[0]).not.toBe(ids[2])
  })
  it('gives an empty list, after one request, for a day with nothing recorded', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    expect(await segsOf(client(nvr.port), { channel: 1, day: '2026-10-25', offsetMin: 330 })).toEqual([])
    expect(positions(nvr)).toEqual([0])
  })
  it('only returns the recordings of the channel asked for', async () => {
    nvr = await startFakeNvr({ recordings: [{ start: '2026-10-20T09:00:00', end: '2026-10-20T09:30:00', channel: 2 }] })
    expect(await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toEqual([])
    expect(await segsOf(client(nvr.port), { channel: 2, day: '2026-10-20', offsetMin: 0 })).toHaveLength(1)
  })
  it('moves on by the number of items the NVR sent, even when some of them are unusable', async () => {
    const seen: number[] = []
    nvr = await startFakeNvr({
      searchAnswer: ({ position }) => {
        seen.push(position)
        if (position === 0) return answer([item('2026-10-20T10:00:00Z', '2026-10-20T09:00:00Z'), item('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z')], 'MORE')
        return answer([item('2026-10-20T13:00:00Z', '2026-10-20T14:00:00Z')])
      },
    })
    const segs = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(seen).toEqual([0, 2])
    expect(segs).toHaveLength(2)
  })
  it('merges pages: repeats across pages are dropped and the result is sorted by start', async () => {
    nvr = await startFakeNvr({
      searchAnswer: ({ position }) =>
        position === 0
          ? answer([item('2026-10-20T13:00:00Z', '2026-10-20T14:00:00Z'), item('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z')], 'MORE')
          : answer([item('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z'), item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')]),
    })
    const segs = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(iso(segs).map((s) => s[0])).toEqual(['2026-10-20T09:00:00.000Z', '2026-10-20T11:00:00.000Z', '2026-10-20T13:00:00.000Z'])
  })
  it('stops when an NVR keeps saying MORE and sends the same items again', async () => {
    nvr = await startFakeNvr({ searchAnswer: () => answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z'), item('2026-10-20T11:00:00Z', '2026-10-20T12:00:00Z')], 'MORE') })
    const segs = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(segs).toHaveLength(2)
    expect(searchPosts(nvr)).toHaveLength(2)
  })
  it('stops when a page with MORE has no items at all', async () => {
    nvr = await startFakeNvr({ searchAnswer: () => answer([], 'MORE') })
    expect(await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toEqual([])
    expect(searchPosts(nvr)).toHaveLength(1)
  })
  it('reads at most 50 pages from an NVR that keeps sending one new item and MORE', async () => {
    nvr = await startFakeNvr({
      searchAnswer: ({ position }) => {
        const s = Date.UTC(2026, 9, 20, 0, 0, 0) + position * 60_000
        const f = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
        return answer([item(f(s), f(s + 30_000))], 'MORE')
      },
    })
    const { segments: segs, truncated } = await findSegments(client(nvr.port, 'secret-pass', 20_000), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(searchPosts(nvr)).toHaveLength(50)
    expect(segs).toHaveLength(50)
    expect(truncated).toBe(true)
  }, 30_000)
  it('keeps at most 5000 segments from an NVR that never stops sending full pages', async () => {
    nvr = await startFakeNvr({
      searchAnswer: ({ position, maxResults }) => {
        const f = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
        const items: string[] = []
        for (let i = 0; i < maxResults; i++) {
          const s = Date.UTC(2026, 9, 20, 0, 0, 0) + (position + i) * 10_000
          items.push(item(f(s), f(s + 5_000)))
        }
        return answer(items, 'MORE')
      },
    })
    const { segments: segs, truncated } = await findSegments(client(nvr.port, 'secret-pass', 20_000), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(segs).toHaveLength(5000)
    expect(truncated).toBe(true)
    expect(segs[0].start.toISOString()).toBe('2026-10-20T00:00:00.000Z') // the FIRST 5000 are kept
    expect(searchPosts(nvr).length).toBeLessThanOrEqual(50)
    expect(searchPosts(nvr).length).toBe(25)
  }, 30_000)
  it('says truncated is false for a complete list, and the result has segments, truncated and skipped', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    expect(await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 330 })).toMatchObject({ truncated: false, skipped: 0 })
    expect(Object.keys(await findSegments(client(nvr.port), { channel: 1, day: '2026-10-25', offsetMin: 0 })).sort()).toEqual(['segments', 'skipped', 'truncated'])
  })
  it('says truncated when the NVR keeps repeating itself with MORE, or sends an empty page with MORE', async () => {
    nvr = await startFakeNvr({ searchAnswer: () => answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')], 'MORE') })
    expect(await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toMatchObject({ truncated: true })
    const empty = await startFakeNvr({ searchAnswer: () => answer([], 'MORE') })
    expect(await findSegments(client(empty.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toMatchObject({ segments: [], truncated: true })
    await empty.close()
  })
  it('does not say truncated when a repeated page is the last one (no MORE)', async () => {
    nvr = await startFakeNvr({
      searchAnswer: ({ position }) => (position === 0 ? answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')], 'MORE') : answer([item('2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')])),
    })
    expect(await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toMatchObject({ truncated: false })
  })
  it('keeps the first 5000 segments, in order, and says truncated, when one answer holds more', async () => {
    const f = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
    const items: string[] = []
    for (let i = 0; i < 5200; i++) items.push(`<searchMatchItem><timeSpan><startTime>${f(Date.UTC(2026, 9, 20) + i * 10_000)}</startTime><endTime>${f(Date.UTC(2026, 9, 20) + i * 10_000 + 5_000)}</endTime></timeSpan></searchMatchItem>`) // small items: the whole answer must stay under 1 MB
    nvr = await startFakeNvr({ searchAnswer: () => answer(items) })
    const r = await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(r.segments).toHaveLength(5000)
    expect(r.truncated).toBe(true)
    expect(r.segments[4999].start.getTime()).toBe(Date.UTC(2026, 9, 20) + 4999 * 10_000)
  })
  it('reads NVR times written without Z exactly like times with Z, shifted by the offset', async () => {
    nvr = await startFakeNvr({
      searchAnswer: () => answer([item('2026-10-20T09:00:00', '2026-10-20T09:30:00'), item('2026-10-20T12:00:00.250000', '2026-10-20T13:00:00')]),
    })
    const withZ = await startFakeNvr({ searchAnswer: () => answer([item('2026-10-20T09:00:00Z', '2026-10-20T09:30:00Z'), item('2026-10-20T12:00:00.250Z', '2026-10-20T13:00:00Z')]) })
    const a = await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 330 })
    const b = await findSegments(client(withZ.port), { channel: 1, day: '2026-10-20', offsetMin: 330 })
    await withZ.close()
    expect(iso(a.segments)).toEqual(iso(b.segments))
    expect(iso(a.segments)[0]).toEqual(['2026-10-20T14:30:00.000Z', '2026-10-20T15:00:00.000Z'])
    expect(a.segments).toHaveLength(2)
  })
  it('keeps paging past a page whose items are all unusable, and counts what it could not read', async () => {
    const seen: number[] = []
    nvr = await startFakeNvr({
      searchAnswer: ({ position }) => {
        seen.push(position)
        if (position === 0) return answer([item('garbage', 'garbage'), item('2026-10-20T10:00:00Z', '2026-10-20T09:00:00Z')], 'MORE')
        return answer([item('2026-10-20T13:00:00Z', '2026-10-20T14:00:00Z'), item('', '')])
      },
    })
    const r = await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(seen).toEqual([0, 2])
    expect(r.segments).toHaveLength(1)
    expect(r.skipped).toBe(3)
    expect(r.truncated).toBe(false)
  })
  it('gives no segments, truncated false and the number skipped when every item was unusable', async () => {
    nvr = await startFakeNvr({ searchAnswer: () => answer([item('x', 'y'), item('2026-10-20T10:00:00Z', '2026-10-20T09:00:00Z'), '<searchMatchItem>nothing</searchMatchItem>']) })
    expect(await findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).toEqual({ segments: [], truncated: false, skipped: 3 })
  })
  it('reads at most 50 pages of unusable items with MORE, and says truncated', async () => {
    nvr = await startFakeNvr({ searchAnswer: () => answer([item('x', 'y')], 'MORE') })
    const r = await findSegments(client(nvr.port, 'secret-pass', 20_000), { channel: 1, day: '2026-10-20', offsetMin: 0 })
    expect(searchPosts(nvr)).toHaveLength(50)
    expect(r).toMatchObject({ segments: [], truncated: true, skipped: 50 })
  }, 30_000)
  it('carries the playback address the NVR gave, unchanged by the offset', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    const { segments } = await findSegments(client(nvr.port), { channel: 3, day: '2026-10-20', offsetMin: 330 })
    expect(segments).toHaveLength(4)
    expect(segments.every((s) => s.uri?.startsWith('rtsp://127.0.0.1/Streaming/tracks/301?starttime='))).toBe(true)
    expect(segments[1].uri).toBe('rtsp://127.0.0.1/Streaming/tracks/301?starttime=2026-10-20T09:00:00Z&endtime=2026-10-20T09:30:00Z')
  })
  it.each([
    ['2026-12-31', 330, '2026-12-30T18:30:00Z', '2026-12-31T18:30:00Z'],
    ['2026-10-20', -300, '2026-10-20T05:00:00Z', '2026-10-21T05:00:00Z'],
    ['2028-02-29', 0, '2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z'],
    ['2028-02-29', 330, '2028-02-28T18:30:00Z', '2028-02-29T18:30:00Z'],
    ['2026-01-01', 330, '2025-12-31T18:30:00Z', '2026-01-01T18:30:00Z'],
    ['2100-12-31', -330, '2100-12-31T05:30:00Z', '2101-01-01T05:30:00Z'],
  ])('asks the NVR for the window of %s at offset %s: [%s, %s)', async (day, offsetMin, from, to) => {
    nvr = await startFakeNvr({ recordings: [] })
    await findSegments(client(nvr.port), { channel: 1, day, offsetMin })
    const body = searchPosts(nvr)[0].body
    expect(body).toContain('<startTime>' + from + '</startTime>')
    expect(body).toContain('<endTime>' + to + '</endTime>')
  })
  it('reports an answer that is not a search result as a bad response, not as "no recordings"', async () => {
    nvr = await startFakeNvr({ mode: 'garbage' })
    await expect(findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'bad_response' })
  })
  it('reports an answer over 1 MB as a bad response', async () => {
    nvr = await startFakeNvr({ mode: 'huge' })
    const err = await segsOf(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NvrError)
    expect(err).toMatchObject({ kind: 'bad_response' })
  })
  it('maps NVR errors like get: auth, forbidden, unreachable, timeout', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    await expect(findSegments(client(nvr.port, 'wrong'), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'auth' })
    await expect(findSegments(client(await closedPort()), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'unreachable' })
    const forbidden = await startFakeNvr({ mode: 'forbidden' })
    await expect(findSegments(client(forbidden.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'forbidden' })
    await forbidden.close()
    const slow = await startFakeNvr({ mode: 'slow' })
    await expect(findSegments(client(slow.port, 'secret-pass', 300), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'timeout' })
    await slow.close()
  })
  it('gives one deadline to all the pages of one call', async () => {
    // 4 matching recordings = 2 pages = 4 requests, each 250 ms late: about 1 s. A 600 ms deadline for the whole call stops it.
    nvr = await startFakeNvr({ recordings: RECORDINGS, delayMs: 250 })
    const t = Date.now()
    await expect(findSegments(client(nvr.port, 'secret-pass', 600), { channel: 1, day: '2026-10-20', offsetMin: 330 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t).toBeLessThan(600 * 1.8)
  })
  it('refuses a login the NVR cannot be given without sending anything in clear', async () => {
    nvr = await startFakeNvr({ recordings: RECORDINGS, challenge: 'basic-only' })
    await expect(findSegments(client(nvr.port), { channel: 1, day: '2026-10-20', offsetMin: 0 })).rejects.toMatchObject({ kind: 'bad_response', reason: 'unsupported_login' })
    expect(nvr.authorizations).toEqual([])
  })
  it.each(['2026-2-3', '2026-02-30', '2026-13-01', '1999-12-31', '2101-01-01', '2026-10-20T00:00', ' 2026-10-20', '2026-10-20\n', '2026/10/20', '', '20261020', '2026-10-2x', '+2026-10-20'])('refuses the day %j without asking the NVR', async (day) => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    await expect(findSegments(client(nvr.port), { channel: 1, day, offsetMin: 0 })).rejects.toThrow(Error)
    await expect(findSegments(client(nvr.port), { channel: 1, day, offsetMin: 0 })).rejects.not.toBeInstanceOf(NvrError)
    expect(nvr.requests).toEqual([])
  })
  it.each([[0, 0], [4097, 0], [1.5, 0], [Number.NaN, 0], [1, Number.NaN], [1, 1441], [1, -1441], [1, Infinity], [1, 0.5], [1, 330.5], [1, '330' as unknown as number]])('refuses channel %s with offset %s without asking the NVR', async (channel, offsetMin) => {
    nvr = await startFakeNvr({ recordings: RECORDINGS })
    await expect(findSegments(client(nvr.port), { channel, day: '2026-10-20', offsetMin })).rejects.toThrow(Error)
    expect(nvr.requests).toEqual([])
  })
  it('accepts the first and last allowed years and a leap day', async () => {
    nvr = await startFakeNvr({ recordings: [] })
    for (const day of ['2000-01-01', '2100-12-31', '2028-02-29']) expect(await segsOf(client(nvr.port), { channel: 1, day, offsetMin: 0 })).toEqual([])
  })
})

describe('recordedDays against the fake NVR', () => {
  const MONTH = [
    { start: '2026-09-30T23:00:00', end: '2026-10-01T00:30:00' }, // covers 30 September and 1 October
    { start: '2026-10-03T10:00:00', end: '2026-10-03T11:00:00' },
    { start: '2026-10-20T23:00:00', end: '2026-10-21T01:00:00' }, // covers 20 and 21
    { start: '2026-10-31T10:00:00', end: '2026-10-31T11:00:00', channel: 2 },
    { start: '2026-11-02T10:00:00', end: '2026-11-02T11:00:00' },
  ]
  it('lists the days of the month with recordings, for the channel asked for', async () => {
    nvr = await startFakeNvr({ recordings: MONTH })
    expect(await recordedDays(client(nvr.port), { channel: 1, year: 2026, month: 10 })).toEqual([1, 3, 20, 21])
    expect(await recordedDays(client(nvr.port), { channel: 2, year: 2026, month: 10 })).toEqual([1, 3, 20, 21, 31])
    expect(await recordedDays(client(nvr.port), { channel: 1, year: 2026, month: 9 })).toEqual([30])
    expect(await recordedDays(client(nvr.port), { channel: 1, year: 2026, month: 12 })).toEqual([])
  })
  it('sends the track and the month the way the NVR expects', async () => {
    nvr = await startFakeNvr({ recordings: MONTH })
    await recordedDays(client(nvr.port), { channel: 3, year: 2026, month: 10 })
    expect(nvr.posts).toEqual([{ path: '/ISAPI/ContentMgmt/record/tracks/301/dailyDistribution', body: '<trackDailyParam><year>2026</year><monthOfYear>10</monthOfYear></trackDailyParam>', contentType: 'application/xml' }])
  })
  it('ignores days past the end of the month', async () => {
    nvr = await startFakeNvr({ recordings: [], dailyAnswer: () => `<trackDailyDistribution><dayList><day><dayOfMonth>30</dayOfMonth><record>true</record></day><day><dayOfMonth>28</dayOfMonth><record>true</record></day></dayList></trackDailyDistribution>` })
    expect(await recordedDays(client(nvr.port), { channel: 1, year: 2026, month: 2 })).toEqual([28])
    expect(await recordedDays(client(nvr.port), { channel: 1, year: 2028, month: 2 })).toEqual([28]) // leap year: still 30 is too many
  })
  it.each([[1999, 5], [2101, 5], [2026, 0], [2026, 13], [2026, 1.5], [2026.5, 3], [Number.NaN, 3], [2026, Number.NaN]])('refuses year %s month %s without asking the NVR', async (year, month) => {
    nvr = await startFakeNvr({ recordings: MONTH })
    await expect(recordedDays(client(nvr.port), { channel: 1, year, month })).rejects.toThrow(Error)
    expect(nvr.requests).toEqual([])
  })
  it('refuses a channel that is not a camera number', async () => {
    nvr = await startFakeNvr({ recordings: MONTH })
    await expect(recordedDays(client(nvr.port), { channel: 0, year: 2026, month: 10 })).rejects.toThrow(Error)
    expect(nvr.requests).toEqual([])
  })
  it('reports an answer that is not a calendar as a bad response, and maps NVR errors like get', async () => {
    const garbage = await startFakeNvr({ mode: 'garbage' })
    await expect(recordedDays(client(garbage.port), { channel: 1, year: 2026, month: 10 })).rejects.toMatchObject({ kind: 'bad_response' })
    await garbage.close()
    nvr = await startFakeNvr({ recordings: MONTH })
    await expect(recordedDays(client(nvr.port, 'wrong'), { channel: 1, year: 2026, month: 10 })).rejects.toMatchObject({ kind: 'auth' })
    await expect(recordedDays(client(await closedPort()), { channel: 1, year: 2026, month: 10 })).rejects.toMatchObject({ kind: 'unreachable' })
    const huge = await startFakeNvr({ mode: 'huge' })
    await expect(recordedDays(client(huge.port), { channel: 1, year: 2026, month: 10 })).rejects.toMatchObject({ kind: 'bad_response' })
    await huge.close()
  })
})

describe('the video format of a recording (codecType)', () => {
  const item = (codec: string | null) =>
    `<CMSearchResult><responseStatusStrg>OK</responseStatusStrg><matchList><searchMatchItem><timeSpan><startTime>2026-10-22T09:00:00Z</startTime><endTime>2026-10-22T10:00:00Z</endTime></timeSpan><mediaSegmentDescriptor>${codec === null ? '' : `<codecType>${codec}</codecType>`}<playbackURI>rtsp://h/p?starttime=1&amp;endtime=2</playbackURI></mediaSegmentDescriptor></searchMatchItem></matchList></CMSearchResult>`
  it('is kept when it is a short plain name, and only then', () => {
    expect(parseSearchResult(item('H.265')).segments[0].codec).toBe('H.265')
    expect(parseSearchResult(item('H.264-BP')).segments[0].codec).toBe('H.264-BP')
    expect(parseSearchResult(item(null)).segments[0]).not.toHaveProperty('codec')
    expect(parseSearchResult(item('x'.repeat(33))).segments[0]).not.toHaveProperty('codec')
    expect(parseSearchResult(item('H.265;rm -rf /')).segments[0]).not.toHaveProperty('codec')
    expect(parseSearchResult(item('&lt;script&gt;')).segments[0]).not.toHaveProperty('codec')
  })
})
