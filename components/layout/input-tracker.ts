'use client'

import { INPUT_COOKIE, PRESENCE_EVENTS } from '@/lib/auth/input-activity'

// P4-L1 review round 1, I-2: the browser's record of the person's last REAL input (a key, a pointer press or move, a touch, a wheel),
// shared by everything on the page: the input cookie the proxy reads (lib/auth/input-activity.ts: background requests then never keep a
// sign-in alive) and the Live screens' presence check (components/live/usePresence.ts). Loading a page counts as input: somebody
// opened it. A tab coming back into view does not.

const COOKIE_EVERY_MS = 15_000
let last = Date.now()
let installed = false
let cookieAt = 0
const listeners = new Set<() => void>()

function writeCookie(force = false) {
  const now = Date.now()
  if (!force && now - cookieAt < COOKIE_EVERY_MS) return
  cookieAt = now
  const https = typeof location !== 'undefined' && location.protocol === 'https:'
  document.cookie = `${INPUT_COOKIE}=${Math.floor(now / 1000)}; path=/; samesite=lax${https ? '; secure' : ''}`
}

function onInput() {
  last = Date.now()
  writeCookie()
  for (const l of listeners) l()
}

/** Starts listening (once per page). */
export function installInputTracker(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  last = Date.now()
  writeCookie(true)
  for (const e of PRESENCE_EVENTS) document.addEventListener(e, onInput, { passive: true, capture: true })
}

export const lastInputAt = (): number => last

/** Calls `cb` on every real input; returns the unsubscribe. */
export function onRealInput(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
