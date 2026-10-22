import { describe, expect, it } from 'vitest'
import { activitySeen, INPUT_COOKIE, PRESENCE_EVENTS, readInputAt } from '@/lib/auth/input-activity'
import { createPresence, presenceIdleMs } from '@/lib/live/presence'
import { sessionPolicy } from '@/lib/auth/session-policy'

// P4-L1 review round 1, I-2 (P3-1 review M-6): an unattended Live screen must not keep a sign-in alive. Only real input — a key, a
// pointer, a touch, a wheel — counts as activity: the token renewals of the wall and the 60 s refresh do not. (1) The Live screens stop
// renewing and refreshing after the person's idle limit without input and ask "Are you still there?". (2) The proxy dates the session's
// activity from the last real input the browser reports (cookie drishti-input), so a background request never moves it forward.

describe('presence on the Live screens', () => {
  it('is present until the idle limit passes without input; input starts it again', () => {
    let t = 1_000_000
    const p = createPresence({ idleMs: 60_000, now: () => t })
    expect(p.present()).toBe(true)
    t += 59_999
    expect(p.present()).toBe(true)
    t += 2
    expect(p.present()).toBe(false)
    p.input()
    expect(p.present()).toBe(true)
    expect(p.msLeft()).toBe(60_000)
  })

  it('uses the same limits as the sign-in (P3-1): 60 minutes for administrators, 8 hours for everybody else', () => {
    const policy = sessionPolicy({})
    expect(presenceIdleMs('admin', policy)).toBe(60 * 60_000)
    expect(presenceIdleMs('platform_owner', policy)).toBe(60 * 60_000)
    expect(presenceIdleMs('operator', policy)).toBe(480 * 60_000)
    expect(presenceIdleMs('user', policy)).toBe(480 * 60_000)
    expect(presenceIdleMs('admin', sessionPolicy({ SESSION_IDLE_MINUTES_ADMIN: '15' }))).toBe(15 * 60_000)
  })

  it('counts keyboard, pointer, touch and wheel only: a tab coming back is not input', () => {
    expect([...PRESENCE_EVENTS].sort()).toEqual(['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'])
    expect(PRESENCE_EVENTS).not.toContain('visibilitychange' as never)
    expect(INPUT_COOKIE).toBe('drishti-input')
  })
})

describe('session activity dated by real input (proxy)', () => {
  const now = 2_000_000_000
  it('reads the browser\'s last-input time: whole seconds only, never in the future', () => {
    expect(readInputAt(String(now - 30), now)).toBe(now - 30)
    expect(readInputAt(String(now + 500), now)).toBe(now)
    for (const bad of [undefined, '', 'x', '-5', '1.5', '99999999999999']) expect(readInputAt(bad, now), String(bad)).toBeNull()
  })

  it('a background request (renewal, refresh) with no new input does not move the activity forward', () => {
    const known = { seen: now - 600 }
    expect(activitySeen({ now, inputAt: now - 900, known })).toBe(now - 600)
    expect(activitySeen({ now, inputAt: now - 600, known })).toBe(now - 600)
  })

  it('real input moves it to the time of that input', () => {
    expect(activitySeen({ now, inputAt: now - 5, known: { seen: now - 600 } })).toBe(now - 5)
  })

  it('a new sign-in (no record yet) starts now; no input report at all keeps the old rule (the request itself)', () => {
    expect(activitySeen({ now, inputAt: now - 9999, known: null })).toBe(now)
    expect(activitySeen({ now, inputAt: null, known: { seen: now - 600 } })).toBe(now)
  })
})
