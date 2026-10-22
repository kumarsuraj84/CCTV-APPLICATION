import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/playback', () => ({
  listDaySegmentsAction: vi.fn(),
  listRecordedDaysAction: vi.fn(),
  oldestRecordingAction: vi.fn(),
  openPlaybackAction: vi.fn(),
  openFastPlaybackAction: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { DayTimeline } from '@/components/live/DayTimeline'
import { FastStreamPlayer } from '@/components/live/FastStreamPlayer'
import { PlaybackView } from '@/components/live/PlaybackView'
import { FULL_DAY } from '@/lib/streams/timeline'

const camera = { id: '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111', name: 'Front Door', storeCode: 'PA' }
const view = (fastPlayback: 'available' | 'not-set-up') => renderToStaticMarkup(<PlaybackView camera={camera} today="2026-10-22" initialDay="2026-10-22" fastPlayback={fastPlayback} />)
const speedSelect = (html: string) => /<select[^>]*id="[^"]*-speed"[^>]*>([\s\S]*?)<\/select>/.exec(html)
const options = (html: string) => [...speedSelect(html)![1].matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1])

// Decision D-L1 replaces the pre-directive rule "fast playback only with cctv.export" (the old test "offers only 1x … to somebody who may
// not use fast playback"): everybody on this screen holds cctv.playback for the camera, so 2x-16x is offered whenever the server can do it.
describe('the speed choice on the Playback screen (D-L1, LG-14)', () => {
  it('offers 1x, 2x, 4x, 8x and 16x with a label when fast playback is set up on the server', () => {
    const html = view('available')
    expect(options(html)).toEqual(['1x', '2x', '4x', '8x', '16x'])
    expect(html).toMatch(/<label[^>]*for="[^"]*-speed"[^>]*>Speed<\/label>/)
    expect(html).not.toContain('Fast playback is not set up')
    expect(html).toContain('Play 10 minutes')
  })

  it('offers only 1x, and says why, when it is not set up on this server', () => {
    const html = view('not-set-up')
    expect(options(html)).toEqual(['1x'])
    expect(html).toContain('Fast playback is not set up on this server.')
    const describedBy = /aria-describedby="([^"]+)"/.exec(speedSelect(html)![0])
    expect(describedBy).not.toBeNull()
    expect(html).toContain(`id="${describedBy![1]}"`)
  })

  it('never builds an /api/vod address (the savable file is export only)', () => {
    expect(view('available')).not.toContain('/api/vod')
  })

  it('keeps the select at the readable mobile size like the length select', () => {
    expect(speedSelect(view('available'))![0]).toContain('text-base')
  })
})

describe('jumps and zoom (LG-11, LG-13)', () => {
  const html = view('available')
  it('has the six jump buttons with plain names', () => {
    for (const name of ['Back 10 minutes', 'Back 5 minutes', 'Back 1 minute', 'Forward 1 minute', 'Forward 5 minutes', 'Forward 10 minutes']) {
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${name}"`))
    }
  })
  it('has zoom in, zoom out and whole day, and says how to use the bar with the keyboard', () => {
    for (const name of ['Zoom in', 'Zoom out', 'Whole day']) expect(html).toMatch(new RegExp(`<button[^>]*>[^<]*(<svg[\\s\\S]*?</svg>)?\\s*${name}`))
    expect(html).toMatch(/left and right arrow keys move 30 seconds/i)
  })
  it('says the times are India time, 24 hour', () => {
    expect(html).toContain('Times are India time (IST), 24-hour.')
  })
})

describe('DayTimeline', () => {
  const bar = (o: Partial<Parameters<typeof DayTimeline>[0]> = {}) =>
    renderToStaticMarkup(<DayTimeline label="Thursday 22 October 2026" spans={[{ startSec: 3600, endSec: 7200 }]} second={5400} view={FULL_DAY} onView={() => {}} onPick={() => {}} {...o} />)
  it('is a slider with a time in words and the recordings as text for a screen reader', () => {
    const html = bar()
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-valuetext="01:30:00"')
    expect(html).toContain('1 recording: 01:00 to 02:00.')
  })
  it('shows a zoomed window with finer marks', () => {
    const html = bar({ view: { start: 3600, end: 7200 } })
    expect(html).toContain('01:30')
    expect(html).toMatch(/Showing 01:00 to 02:00/)
  })
  it('LG-17: when the list could not be read the bar is marked unknown, not empty', () => {
    const html = bar({ spans: [], unknown: true })
    expect(html).toContain('The list of recordings is not available')
  })
})

describe('FastStreamPlayer', () => {
  const html = renderToStaticMarkup(<FastStreamPlayer token="t" minutes={10} speed={16} label="PA, Front Door, 22 Oct, 14:30" onStop={() => {}} onContinue={() => {}} />)
  it('is a muted video named for a screen reader, with the browser controls but no download, no speed menu and no picture-in-picture', () => {
    expect(html).toContain('<video')
    expect(html).toContain('muted')
    expect(html).toContain('nodownload noplaybackrate')
    expect(html).toContain('disablePictureInPicture')
    expect(html).toContain('aria-label="PA, Front Door, 22 Oct, 14:30, 16x"')
    expect(html).not.toMatch(/src="\/api/)
  })
  it('says there is no sound and how much is played at which speed, and has a Stop button', () => {
    expect(html).toContain('No sound. Plays 10 minutes of recording at 16x.')
    expect(html).toContain('>Stop<')
    expect(html).toContain('Getting the recording')
  })
})
