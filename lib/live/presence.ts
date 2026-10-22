import { idleMinutesFor, type SessionPolicy } from '@/lib/auth/session-policy'

// P4-L1 review round 1, I-2: the Live screens stop by themselves when nobody has been at the screen for the person's idle limit (the
// same limit as the sign-in, P3-1: 60 minutes for administrators, 8 hours for everybody else). Pure, so it can be tested with a fake
// clock; components/live/usePresence.ts feeds it the real input events.

export const MSG_STILL_THERE = 'Are you still there?'

export function presenceIdleMs(role: string | null | undefined, policy: SessionPolicy): number {
  return idleMinutesFor(role, policy) * 60_000
}

export type Presence = { input(): void; present(): boolean; msLeft(): number }

export function createPresence(o: { idleMs: number; now?: () => number }): Presence {
  const now = o.now ?? Date.now
  let last = now()
  return {
    input() {
      last = now()
    },
    present() {
      return now() - last <= o.idleMs
    },
    msLeft() {
      return Math.max(0, o.idleMs - (now() - last))
    },
  }
}
