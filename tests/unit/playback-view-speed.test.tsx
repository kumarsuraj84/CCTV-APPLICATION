import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/actions/playback', () => ({
  listDaySegmentsAction: vi.fn(),
  listRecordedDaysAction: vi.fn(),
  openPlaybackAction: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { FastPlayer } from '@/components/live/FastPlayer'
import { PlaybackView } from '@/components/live/PlaybackView'

const camera = { id: '0b7f0a52-1f0c-4a52-9c63-2f2f0c7bd111', name: 'Front Door', storeCode: 'PA' }
const view = (fastPlayback?: boolean) => renderToStaticMarkup(<PlaybackView camera={camera} today="2026-10-22" initialDay="2026-10-22" fastPlayback={fastPlayback} />)
const speedSelect = (html: string) => /<select[^>]*id="[^"]*-speed"[^>]*>([\s\S]*?)<\/select>/.exec(html)

describe('the speed choice on the Playback screen', () => {
  it('offers only 1x, and says why, when ffmpeg is not set up on the server', () => {
    const html = view(false)
    const select = speedSelect(html)
    expect(select).not.toBeNull()
    expect([...select![1].matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(['1x'])
    expect(html).toContain('Fast playback is not set up on this server.')
    // the select points at that sentence
    const describedBy = /aria-describedby="([^"]+)"/.exec(select![0])
    expect(describedBy).not.toBeNull()
    expect(html).toContain(`id="${describedBy![1]}"`)
  })

  it('is the same when the setting is not given at all (the safe default)', () => {
    expect(view(undefined)).toContain('Fast playback is not set up on this server.')
  })

  it('offers 1x, 2x, 4x and 8x, with a label, when ffmpeg works', () => {
    const html = view(true)
    const select = speedSelect(html)!
    expect([...select[1].matchAll(/<option[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(['1x', '2x', '4x', '8x'])
    expect(html).toMatch(/<label[^>]*for="[^"]*-speed"[^>]*>Speed<\/label>/)
    expect(html).not.toContain('Fast playback is not set up')
    expect(html).toContain('Play 10 minutes')
  })

  it('keeps the select at the readable mobile size like the length select', () => {
    const html = view(true)
    expect(speedSelect(html)![0]).toContain('text-base')
  })
})

describe('FastPlayer', () => {
  const html = renderToStaticMarkup(<FastPlayer src="/api/vod?camera=a&start=b&minutes=10" minutes={10} speed={4} label="PA, Front Door, 22 Oct, 14:30" onStop={() => {}} onContinue={() => {}} />)
  it('is a plain, muted video with the browser controls (no download, no speed menu), named for a screen reader', () => {
    expect(html).toContain('<video')
    expect(html).toContain('muted')
    expect(html).toContain('controls')
    expect(html).toContain('nodownload noplaybackrate')
    expect(html).toContain('aria-label="PA, Front Door, 22 Oct, 14:30, 4x"')
  })
  it('says there is no sound and how much is played at which speed, and has a Stop button', () => {
    expect(html).toContain('No sound. Plays 10 minutes of recording at 4x.')
    expect(html).toContain('>Stop<')
  })
  it('shows a message while it is getting the recording', () => {
    expect(html).toContain('Getting the recording')
  })
})
