import type { LoginGate } from '@/lib/nvr/login-policy'
import { MSG_NVR_LOGIN_CHECKING } from '@/lib/nvr/login-guard'

// The words of the NVR login back-off on the administrators' screens (ruling R9; P2-5c-1 review I-3; fix round 2 A-N3).
//
// Final fix X (release 1 review C I-1; ruling NB-1): the back-off itself is no longer kept here. Since migration 0048 there is ONE
// back-off for every process, in the database (nvr_login_state; rules in lib/nvr/login-policy.ts, calls in lib/nvr/login-guard.ts),
// shared by the worker, "Find cameras", "find cameras for all", the connection test, live video, playback and the gateway. It escalates
// (15 minutes doubling to 6 hours), survives restarts, and still pauses an NVR after 3 refused logins within 30 minutes whatever the
// login (A-N3), so saving one wrong password after another cannot lock its account.

export const MSG_LOGIN_BACKOFF = 'The NVR refused this login a short while ago. To protect its account it is not asked again for a while; check the saved user name and password.'
export const LOGIN_REFUSALS_ALLOWED = 3
export const LOGIN_REFUSAL_WINDOW_SEC = 1800
export const MSG_LOGIN_PAUSED =
  'This NVR refused 3 logins in the last 30 minutes. To keep its account from being locked it is not asked again for a while. Saving a corrected password tries it at once; otherwise check the user name and password on the NVR itself.'

/** Why an administrator's action may not log in to this NVR now (plain words), or null when it may. */
export function loginBlockMessage(g: LoginGate): string | null {
  if (g.decision === 'refused') return MSG_LOGIN_BACKOFF
  if (g.decision === 'paused') return MSG_LOGIN_PAUSED
  if (g.decision === 'wait' || (g.decision === 'probe' && !g.claimed)) return MSG_NVR_LOGIN_CHECKING
  return null
}
