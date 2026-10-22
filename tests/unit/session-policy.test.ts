import { describe, expect, it } from 'vitest'
import { decodeActivity, encodeActivity } from '@/lib/auth/session-activity'
import { claimsOf, freshAuthRefusal, MSG_CONFIRM_FIRST, mfaGate, sessionExpiry, sessionPolicy } from '@/lib/auth/session-policy'

// P3-1 brief items 1 and 7: the session rules as pure functions (the truth tables), used by proxy.ts, the profile gate and every
// sensitive Server Action.

describe('session policy from the environment', () => {
  it('defaults: 12 hours at most, 60 minutes idle for administrators, 8 hours idle for everybody else, fresh sign-in within 10 minutes', () => {
    expect(sessionPolicy({})).toEqual({ maxHours: 12, idleMinutesAdmin: 60, idleMinutes: 480, freshMinutes: 10 })
  })
  it('reads the four settings and refuses silly values (keeps the default)', () => {
    expect(sessionPolicy({ SESSION_MAX_HOURS: '8', SESSION_IDLE_MINUTES_ADMIN: '30', SESSION_IDLE_MINUTES: '120', FRESH_AUTH_MINUTES: '5' }))
      .toEqual({ maxHours: 8, idleMinutesAdmin: 30, idleMinutes: 120, freshMinutes: 5 })
    for (const bad of ['0', '-1', 'x', '1.5', '100000']) {
      expect(sessionPolicy({ SESSION_MAX_HOURS: bad, SESSION_IDLE_MINUTES_ADMIN: bad, SESSION_IDLE_MINUTES: bad, FRESH_AUTH_MINUTES: bad }), bad)
        .toEqual({ maxHours: 12, idleMinutesAdmin: 60, idleMinutes: 480, freshMinutes: 10 })
    }
  })
})

describe('session expiry (idle and absolute lifetime)', () => {
  const now = 1_800_000_000
  const p = { maxHours: 12, idleMinutes: 60 }
  it('is fine while active and younger than the lifetime', () => {
    expect(sessionExpiry({ now, signedInAt: now - 3600, lastSeen: now - 59 * 60, ...p })).toBeNull()
  })
  it('idle: no request for longer than the idle limit', () => {
    expect(sessionExpiry({ now, signedInAt: now - 7200, lastSeen: now - 61 * 60, ...p })).toBe('idle')
  })
  it('absolute: older than the lifetime, however active', () => {
    expect(sessionExpiry({ now, signedInAt: now - 12 * 3600 - 1, lastSeen: now - 5, ...p })).toBe('absolute')
  })
  it('without a record of activity: a session older than the idle limit counts as idle (deleting the record does not help)', () => {
    expect(sessionExpiry({ now, signedInAt: now - 61 * 60, lastSeen: null, ...p })).toBe('idle')
    expect(sessionExpiry({ now, signedInAt: now - 10 * 60, lastSeen: null, ...p })).toBeNull()
  })
  it('without a known sign-in time only the idle rule applies', () => {
    expect(sessionExpiry({ now, signedInAt: null, lastSeen: now - 10, ...p })).toBeNull()
    expect(sessionExpiry({ now, signedInAt: null, lastSeen: now - 3601 - 60, ...p })).toBe('idle')
  })
})

describe('the access token claims (session id, sign-in time, last authentication, assurance level)', () => {
  const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`
  it('reads amr timestamps: the earliest is the sign-in, the latest the last authentication', () => {
    const c = claimsOf(jwt({ session_id: 's1', aal: 'aal2', amr: [{ method: 'totp', timestamp: 2000 }, { method: 'password', timestamp: 1000 }] }))
    expect(c).toEqual({ sessionId: 's1', aal2: true, signedInAt: 1000, lastAuthAt: 2000 })
  })
  it('anything unreadable gives nothing', () => {
    for (const t of ['', 'abc', 'a.b.c', jwt({ amr: 'x' }), jwt({ session_id: 5 })]) {
      const c = claimsOf(t)
      expect(c.sessionId === null || typeof c.sessionId === 'string', t).toBe(true)
      expect(c.aal2).toBe(false)
    }
    expect(claimsOf('a.b.c')).toEqual({ sessionId: null, aal2: false, signedInAt: null, lastAuthAt: null })
  })
})

describe('the activity record (signed cookie, bound to the session)', () => {
  const key = 'k'.repeat(40)
  it('round-trips and is bound to its session and key', () => {
    const v = encodeActivity({ sid: '7f6c2f0e-2f5f-4c38-8a4c-3a6d8f3a1b2c', seen: 1_800_000_000, idle: 60 }, key)
    expect(decodeActivity(v, key)).toEqual({ sid: '7f6c2f0e-2f5f-4c38-8a4c-3a6d8f3a1b2c', seen: 1_800_000_000, idle: 60 })
    expect(decodeActivity(v, 'z'.repeat(40))).toBeNull()
  })
  it('a changed time, limit or session fails', () => {
    const v = encodeActivity({ sid: 's1', seen: 100, idle: 60 }, key)
    const [ver, sid, seen, idle, mac] = v.split('.')
    expect(decodeActivity([ver, sid, String(Number(seen) + 1000), idle, mac].join('.'), key)).toBeNull()
    expect(decodeActivity([ver, sid, seen, '99999', mac].join('.'), key)).toBeNull()
    expect(decodeActivity([ver, 's2', seen, idle, mac].join('.'), key)).toBeNull()
    for (const junk of [undefined, '', 'v1', 'v1.a.b.c.d', 'v2.s1.100.60.x']) expect(decodeActivity(junk, key)).toBeNull()
  })
})

describe('the multi-factor gate (truth table)', () => {
  const base = { enforced: false, privileged: false, aal2: false, hasFactor: false }
  it('a person with a verified factor must always finish it (whether or not it is required)', () => {
    expect(mfaGate({ ...base, hasFactor: true })).toBe('challenge')
    expect(mfaGate({ ...base, hasFactor: true, enforced: true, privileged: true })).toBe('challenge')
    expect(mfaGate({ ...base, hasFactor: true, aal2: true })).toBe('ok')
  })
  it('switched on: administrators and holders of MFA capabilities without a factor must enrol', () => {
    expect(mfaGate({ ...base, enforced: true, privileged: true })).toBe('enrol')
    expect(mfaGate({ ...base, enforced: true, privileged: true, aal2: true, hasFactor: true })).toBe('ok')
  })
  it('switched on: viewers may go on without (optional for them, ruling D-10a)', () => {
    expect(mfaGate({ ...base, enforced: true, privileged: false })).toBe('ok')
  })
  it('switched off (the local default): nobody is made to enrol', () => {
    expect(mfaGate({ ...base, privileged: true })).toBe('ok')
  })
})

describe('fresh sign-in for sensitive actions', () => {
  const now = 1_800_000_000
  const session = (lastAuthAt: number | null) => ({ session: { lastAuthAt } })
  it('allows the action within N minutes of the last sign-in or code', () => {
    expect(freshAuthRefusal(session(now - 9 * 60), { now, freshMinutes: 10 })).toBeNull()
    expect(freshAuthRefusal(session(now - 10 * 60), { now, freshMinutes: 10 })).toBeNull()
  })
  it('refuses with plain words after that, or when it cannot be known', () => {
    expect(freshAuthRefusal(session(now - 10 * 60 - 1), { now, freshMinutes: 10 })).toBe(MSG_CONFIRM_FIRST)
    expect(freshAuthRefusal(session(null), { now, freshMinutes: 10 })).toBe(MSG_CONFIRM_FIRST)
    expect(freshAuthRefusal({}, { now, freshMinutes: 10 })).toBe(MSG_CONFIRM_FIRST)
    expect(freshAuthRefusal(session(now + 3600), { now, freshMinutes: 10 })).toBe(MSG_CONFIRM_FIRST) // a time in the future is not believed
  })
})
