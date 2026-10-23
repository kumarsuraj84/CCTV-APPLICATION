import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// P4-L2 review m-5: the Playback screen's IST arithmetic (shown time = UTC fields + 330 minutes, no daylight saving time) must not
// depend on the time zone of the server or the browser. A child process runs it with TZ set to zones far from India on both sides.

const ROOT = path.resolve(__dirname, '../..')
const tsx = createRequire(path.join(ROOT, 'package.json')).resolve('tsx/cli')
const PROBE = path.join(ROOT, 'tests/helpers/ist-probe.ts')
const run = (tz: string) => JSON.parse(execFileSync(process.execPath, [tsx, PROBE], { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 60_000 }).trim().split('\n').at(-1)!)

const EXPECTED = {
  todayBefore: '2026-10-22',
  todayAfter: '2026-10-23',
  jump: { day: '2026-10-23', sec: 180 },
  leap: { day: '2028-02-29', sec: 86_390 },
  start: '2026-10-22T12:34:56Z',
  spans: [{ startSec: 0, endSec: 2700 }],
  calendar: [3, 4, 31],
  label: 'Thursday 22 October 2026',
  short: '22 Oct, 14:35',
  playable: [true, false],
  nav: { canPreviousDay: false, canNextDay: true },
}

describe('IST arithmetic is the same in every machine time zone (review m-5)', () => {
  for (const [tz, offset] of [['America/Los_Angeles', 420], ['Pacific/Kiritimati', -840], ['UTC', 0]] as const) {
    it(`TZ=${tz}`, () => {
      const out = run(tz)
      expect(out.machineOffsetMin).toBe(offset) // the zone really applied in the child
      delete out.machineOffsetMin
      expect(out).toEqual(EXPECTED)
    }, 90_000)
  }
})
