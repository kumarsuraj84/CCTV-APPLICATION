import { describe, expect, it } from 'vitest'
import { backoffSeconds, classifyLoginAnswer, classifyRtspCode, decideLogin, reportLogin, tryAgain, type LoginState } from '@/lib/nvr/login-policy'

// Final fix X (release 1 review C I-1, I-3; ruling NB-1): the rules of the shared NVR login back-off. The database implements the same
// (tests/integration/nvr-login-state-db.test.ts runs these scenarios against it).

const T0 = Date.parse('2026-10-23T08:00:00Z')
const min = (n: number) => n * 60_000
const V = 'v1'

/** A small driver: one NVR's state, moved by gate and report calls. */
function nvr(version: string | null = V) {
  let s: LoginState | undefined
  let v = version
  return {
    gate: (now: number, o: { claim?: boolean; freshSec?: number | null } = {}) => {
      const r = decideLogin(s, v, now, { claim: o.claim ?? true, freshSec: o.freshSec })
      s = r.state
      return r.gate
    },
    report: (outcome: 'ok' | 'refused' | 'unknown', now: number, version = v ?? '') => {
      const r = reportLogin(s, v, version, outcome, now)
      s = r.state
      return r.applied
    },
    setVersion: (next: string | null) => (v = next),
    tryAgain: () => (s = tryAgain(s)),
    state: () => s,
  }
}

describe('the NVR login back-off rules', () => {
  it('the window doubles from 15 minutes to at most 6 hours', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 30].map((l) => backoffSeconds(l))).toEqual([900, 1800, 3600, 7200, 14400, 21600, 21600, 21600])
    expect(backoffSeconds(2, { baseSec: 60, maxSec: 100 })).toBe(100)
  })

  it('a login never proven gets exactly one attempt; the others wait for its answer', () => {
    const n = nvr()
    const first = n.gate(T0)
    expect(first).toMatchObject({ decision: 'probe', claimed: true, version: V, baselined: false })
    expect(n.gate(T0 + 1000)).toMatchObject({ decision: 'wait', claimed: false })
    expect(n.gate(T0 + 1000, { claim: false })).toMatchObject({ decision: 'wait' })
    n.report('ok', T0 + 2000)
    expect(n.gate(T0 + 3000)).toMatchObject({ decision: 'go', baselined: true })
  })

  it('a peek (no claim) does not take the attempt', () => {
    const n = nvr()
    expect(n.gate(T0, { claim: false })).toMatchObject({ decision: 'probe', claimed: false })
    expect(n.gate(T0, { claim: true })).toMatchObject({ decision: 'probe', claimed: true })
  })

  it('a refused login leaves the NVR alone for the window, then allows one attempt; each refusal doubles the window', () => {
    const n = nvr()
    n.gate(T0)
    n.report('refused', T0)
    expect(n.gate(T0 + min(14))).toMatchObject({ decision: 'refused', until: T0 + min(15), level: 1 })
    const again = n.gate(T0 + min(15))
    expect(again).toMatchObject({ decision: 'probe', claimed: true })
    expect(n.gate(T0 + min(15))).toMatchObject({ decision: 'wait' })
    n.report('refused', T0 + min(15))
    expect(n.gate(T0 + min(44))).toMatchObject({ decision: 'refused', until: T0 + min(45), level: 2 })
    n.gate(T0 + min(45))
    n.report('refused', T0 + min(45))
    expect(n.gate(T0 + min(104))).toMatchObject({ decision: 'refused', level: 3, until: T0 + min(105) })
  })

  it('an attempt that was already on its way when the first refusal came does not double the window again', () => {
    const n = nvr()
    n.gate(T0)
    n.report('refused', T0)
    n.report('refused', T0 + 500)
    expect(n.gate(T0 + 1000)).toMatchObject({ decision: 'refused', level: 1, until: T0 + min(15) })
  })

  it('a timeout ("unknown") gives the attempt back without any back-off', () => {
    const n = nvr()
    n.gate(T0)
    n.report('unknown', T0 + 100)
    expect(n.gate(T0 + 200)).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
  })

  it('an attempt nobody reported expires after a minute', () => {
    const n = nvr()
    n.gate(T0)
    expect(n.gate(T0 + 59_000)).toMatchObject({ decision: 'wait' })
    expect(n.gate(T0 + 60_000)).toMatchObject({ decision: 'probe', claimed: true })
  })

  it('a new saved login (password, user name or address) starts again at once; the same login does not', () => {
    const n = nvr()
    n.gate(T0)
    n.report('refused', T0)
    n.setVersion('v2')
    expect(n.gate(T0 + 1000)).toMatchObject({ decision: 'probe', claimed: true, level: 0, version: 'v2' })
    // A late report about the old login changes nothing.
    expect(n.report('refused', T0 + 2000, V)).toBe(false)
    n.report('ok', T0 + 3000)
    expect(n.gate(T0 + 4000)).toMatchObject({ decision: 'go' })
  })

  it('three refused logins of one saved login within 30 minutes pause the NVR until the oldest is 30 minutes old', () => {
    const n = nvr()
    for (let i = 0; i < 3; i++) {
      n.gate(T0 + min(i))
      n.report('refused', T0 + min(i))
      n.tryAgain()
    }
    expect(n.gate(T0 + min(5))).toMatchObject({ decision: 'paused', until: T0 + min(30) })
    expect(n.gate(T0 + min(30) + 1)).toMatchObject({ decision: 'probe', claimed: true })
  })

  // Final fix X round 2 (review M-10; ruling NB-10): a NEW saved login (a corrected password) is a fresh state: it lifts the pause and is
  // tried at once; if it is refused too, the next window is the first one again (15 minutes).
  it('a new saved login lifts the 3-in-30-minutes pause and starts at the first window', () => {
    const n = nvr()
    for (let i = 0; i < 3; i++) {
      n.gate(T0 + min(i))
      n.report('refused', T0 + min(i))
      n.tryAgain()
    }
    expect(n.gate(T0 + min(4))).toMatchObject({ decision: 'paused' })
    n.setVersion('v-corrected')
    expect(n.gate(T0 + min(5))).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
    n.report('refused', T0 + min(5))
    expect(n.gate(T0 + min(6))).toMatchObject({ decision: 'refused', level: 1, until: T0 + min(20) })
  })

  // Final fix X round 2 (review I-2, M-4; ruling NB-8): ONE classifier for every path. Only an answer that came after the password was
  // actually sent (a Digest login) says anything about the login.
  it('the shared classifier: a refusal, a 403 or a success count only after the password was sent', () => {
    expect(classifyLoginAnswer({ status: 'refused', credentialsSent: true })).toBe('refused')
    expect(classifyLoginAnswer({ status: 'forbidden', credentialsSent: true })).toBe('ok')
    expect(classifyLoginAnswer({ status: 'success', credentialsSent: true })).toBe('ok')
    expect(classifyLoginAnswer({ status: 'forbidden', credentialsSent: false })).toBe('unknown') // a 403 before any login (IP filter, lock page)
    expect(classifyLoginAnswer({ status: 'success', credentialsSent: false })).toBe('unknown') // a 200 nobody logged in for
    expect(classifyLoginAnswer({ status: 'refused', credentialsSent: false })).toBe('unknown') // a 401 we never answered (Basic only, unusable password)
    expect(classifyLoginAnswer({ status: 'other', credentialsSent: true })).toBe('unknown')
    expect(classifyRtspCode(401, true)).toBe('refused')
    expect(classifyRtspCode(401, false)).toBe('unknown')
    expect(classifyRtspCode(200, true)).toBe('ok')
    expect(classifyRtspCode(200, false)).toBe('unknown')
    expect(classifyRtspCode(404, true)).toBe('ok')
    expect(classifyRtspCode(0, true)).toBe('unknown')
  })

  it('an administrator\'s "Try again" ends the window and its level, not the 3-in-30-minutes pause', () => {
    const n = nvr()
    n.gate(T0)
    n.report('refused', T0)
    n.tryAgain()
    expect(n.gate(T0 + 1000)).toMatchObject({ decision: 'probe', claimed: true, level: 0 })
    n.report('refused', T0 + 2000)
    n.tryAgain()
    n.gate(T0 + 3000)
    n.report('refused', T0 + 3000)
    n.tryAgain()
    expect(n.gate(T0 + 4000)).toMatchObject({ decision: 'paused' })
  })

  it('a proven login older than the caller\'s limit needs a new proof (live video), any proven login is enough otherwise', () => {
    const n = nvr()
    n.gate(T0)
    n.report('ok', T0)
    expect(n.gate(T0 + min(11), { freshSec: 600 })).toMatchObject({ decision: 'probe', claimed: true })
    expect(n.gate(T0 + min(11), { freshSec: null })).toMatchObject({ decision: 'go' })
    expect(n.gate(T0 + min(11), { freshSec: 600 })).toMatchObject({ decision: 'wait' })
  })

  it('no saved password: never contacted', () => {
    expect(nvr(null).gate(T0)).toMatchObject({ decision: 'no_password', version: null, claimed: false })
  })

  it('a success clears the level, so the next refusal starts again at 15 minutes', () => {
    const n = nvr()
    n.gate(T0)
    n.report('refused', T0)
    n.gate(T0 + min(15))
    n.report('ok', T0 + min(15))
    n.report('refused', T0 + min(20))
    expect(n.gate(T0 + min(21))).toMatchObject({ decision: 'refused', level: 1, until: T0 + min(35) })
  })
})
