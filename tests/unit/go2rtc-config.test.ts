import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// P2-6 (D-13) and review round 1 (M-11): go2rtc's configuration switches off every listener the app does not use, and its API asks
// for the login from the environment. Checked on the pinned 1.9.9 image (only :1984 listens; /api/streams without the login is 401).

const read = (f: string) => readFileSync(path.resolve(__dirname, '../../deploy', f), 'utf8')
/** The `listen:` value of one top-level section, or undefined when the section is absent. */
const listenOf = (text: string, section: string) => new RegExp(`^${section}:\\s*\\n\\s+listen:\\s*"([^"]*)"`, 'm').exec(text)?.[1]

describe('go2rtc configuration (D-13, M-11)', () => {
  it('production config: only the API listens; RTSP, WebRTC, SRTP and RTMP are off; the login comes from the environment', () => {
    const c = read('go2rtc.yaml')
    expect(listenOf(c, 'api')).toBe(':1984')
    for (const s of ['rtsp', 'webrtc', 'srtp', 'rtmp']) expect(listenOf(c, s), s).toBe('')
    expect(c).toMatch(/username: \$\{GO2RTC_API_USERNAME:\}/)
    expect(c).toMatch(/password: \$\{GO2RTC_API_PASSWORD:\}/)
    expect(c).not.toMatch(/^homekit:|^hass:/m)
  })

  it('demo config: RTSP on the container loopback only (for the generated picture), the rest off', () => {
    const c = read('go2rtc.demo.yaml')
    expect(listenOf(c, 'rtsp')).toBe('127.0.0.1:8554')
    for (const s of ['webrtc', 'srtp', 'rtmp']) expect(listenOf(c, s), s).toBe('')
  })
})
