import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAYER_RTC_SHA384, PLAYER_SCRIPT_INTEGRITY, PLAYER_SCRIPT_SRC, playerScriptUrl } from '@/lib/web/player-script'

// Final fix Y (final review B minor 5, D-12): the player is a pinned copy in the app (go2rtc 1.9.9), loaded with integrity; the tile
// loader uses it, not the gateway's proxied script.

const ROOT = path.resolve(__dirname, '../..')
const file = (rel: string) => readFileSync(path.join(ROOT, 'public', rel))
const sha384 = (b: Buffer) => createHash('sha384').update(b).digest('base64')

describe('the pinned go2rtc player (B minor 5)', () => {
  it('both files are exactly the pinned ones; the entry imports only its neighbour', () => {
    const entry = file(PLAYER_SCRIPT_SRC)
    expect(`sha384-${sha384(entry)}`).toBe(PLAYER_SCRIPT_INTEGRITY)
    expect(sha384(file('vendor/go2rtc-1.9.9/video-rtc.js'))).toBe(PLAYER_RTC_SHA384)
    const imports = [...entry.toString('utf8').matchAll(/import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(imports).toEqual(['./video-rtc.js'])
  })

  it('the address, with a fresh one for a retry', () => {
    expect(playerScriptUrl()).toBe('/vendor/go2rtc-1.9.9/video-stream.js')
    expect(playerScriptUrl(2)).toBe('/vendor/go2rtc-1.9.9/video-stream.js?r=2')
  })

  it('the tile loader uses the pinned copy with its integrity, not the gateway', () => {
    const src = readFileSync(path.join(ROOT, 'components/live/player.ts'), 'utf8')
    expect(src).toMatch(/script\.integrity = PLAYER_SCRIPT_INTEGRITY/)
    expect(src).toMatch(/playerScriptUrl\(/)
    expect(src).not.toMatch(/gatewayScriptUrl\(/)
  })
})
