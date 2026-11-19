import type { AdminClient } from '@/lib/admin/types'
import { loadMonitorConfig } from '@/lib/monitor/config'
import { NvrError } from '@/lib/nvr/client'
import { classifyLoginAnswer, classifyRtspCode, type BackoffConfig, type LoginDecision, type LoginGate, type LoginOutcome, type LoginPath } from '@/lib/nvr/login-policy'
import { logger } from '@/lib/observability/logger'

// Final fix X (release 1 review C I-1, I-2; ruling NB-1): the ONE NVR login back-off of every process, in the database
// (nvr_login_state; rules in lib/nvr/login-policy.ts). Every path that logs in to an NVR asks first (gateLogins) and says afterwards
// what the login did (LoginTicket): the worker's checks, "Find cameras", the connection test, live video (before a go2rtc source is
// registered), 1x playback, fast playback, the calendar and day searches and the downloads; the video gateway asks by session id
// (media_session_login_check) and passes on go2rtc's "wrong user/pass". When the state cannot be read nothing is sent to the NVR
// (fail closed): a wrong answer here could lock an NVR account.

export type { LoginDecision, LoginGate, LoginOutcome, LoginPath }

/** Live tiles and playback, for people with the IT view of the NVR (the plain state of directive item I-2). */
export const MSG_NVR_LOGIN_REFUSED = 'Login refused: ask an administrator to check the NVR password.'
/** The same for CCTV-only viewers: no NVR detail (defined with the tile, which shows it too). */
export { MSG_CAMERA_NOT_AVAILABLE } from '@/lib/streams/tile-connection'
/** Another part of the system is checking the NVR's login right now. */
export const MSG_NVR_LOGIN_CHECKING = 'The NVR login is being checked. Try again in a moment.'
/** Live video and 1x playback: a proven login older than this (10 minutes, two worker rounds) is proven again before go2rtc dials. */
export const LIVE_LOGIN_FRESH_SEC = 600
export const MSG_LOGIN_STATE_UNREADABLE = 'Could not check the NVR login state. Nothing was sent to the NVR; try again in a moment.'

type GateRow = { recorder_id: string; decision: LoginDecision; version: string | null; until: string | null; baselined: boolean; level: number; claimed: boolean }

const backoff = (): BackoffConfig => {
  const c = loadMonitorConfig()
  return { baseSec: c.nvrLoginBackoffSec, maxSec: c.nvrLoginBackoffMaxSec }
}

/**
 * Asks the database what may be done with these NVRs now (nvr_login_gate). `claim`: take the one attempt where a try is needed.
 * `freshSec`: a proven login older than this needs a new proof (live video: 600). Throws when the database cannot be asked.
 */
export async function gateLogins(client: AdminClient, recorderIds: readonly string[], o: { path: LoginPath; claim?: boolean; freshSec?: number | null }): Promise<Map<string, LoginGate>> {
  const out = new Map<string, LoginGate>()
  const ids = [...new Set(recorderIds)]
  for (let i = 0; i < ids.length; i += 1000) {
    const { data, error } = await client.rpc('nvr_login_gate', {
      p_recorders: ids.slice(i, i + 1000), p_path: o.path, p_claim: o.claim ?? true, ...(o.freshSec ? { p_fresh_sec: o.freshSec } : {}),
    })
    if (error || !Array.isArray(data)) throw new Error(`Could not read the NVR login state (${error?.code ?? 'no answer'}).`)
    for (const r of data as unknown as GateRow[]) {
      out.set(r.recorder_id, {
        decision: r.decision, version: r.version, until: r.until ? Date.parse(r.until) : null, baselined: r.baselined === true, level: r.level ?? 0, claimed: r.claimed === true,
      })
    }
  }
  return out
}

/** One recorder (see gateLogins); a recorder the database does not know comes back as no_password (never contacted). */
export async function gateLogin(client: AdminClient, recorderId: string, o: { path: LoginPath; claim?: boolean; freshSec?: number | null }): Promise<LoginGate> {
  return (await gateLogins(client, [recorderId], o)).get(recorderId) ?? { decision: 'no_password', version: null, until: null, baselined: false, level: 0, claimed: false }
}

/**
 * gateLogin, but a "wait" (another caller is trying right now) is asked again a few times (by default 6 times, half a second apart): a
 * person opening a wall while the worker checks that NVR waits a moment instead of failing.
 */
export async function gateLoginPatiently(
  client: AdminClient, recorderId: string, o: { path: LoginPath; freshSec?: number | null; tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<LoginGate> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let g = await gateLogin(client, recorderId, o)
  for (let i = 1; g.decision === 'wait' && i < (o.tries ?? 6); i++) {
    await sleep(o.delayMs ?? 500)
    g = await gateLogin(client, recorderId, o)
  }
  return g
}

/** Says what one login did (nvr_login_report). Never throws: a failed report is logged (the attempt then expires after a minute). */
export async function reportNvrLogin(client: AdminClient, recorderId: string, version: string, outcome: LoginOutcome, path: LoginPath, cfg: BackoffConfig = backoff()): Promise<void> {
  try {
    const { error } = await client.rpc('nvr_login_report', { p_recorder: recorderId, p_version: version, p_outcome: outcome, p_path: path, p_base_sec: cfg.baseSec, p_max_sec: cfg.maxSec })
    if (error) logger.error({ event: 'nvr_login_report_failed', recorder: recorderId, errorCode: error.code })
    else if (outcome === 'refused') logger.warn({ event: 'nvr_login_refused', recorder: recorderId, path, message: 'An NVR refused its saved login; every path leaves it alone for a while (the Monitoring page lists it).' })
  } catch (e) {
    logger.error({ event: 'nvr_login_report_failed', recorder: recorderId, errorName: e instanceof Error ? e.name : typeof e })
  }
}

/**
 * What an NVR error says about the login. auth (401 on the Digest login): refused. forbidden (403 AFTER the Digest login was accepted:
 * a viewer user may not read that one thing — release 1 review C I-3): the login works. Anything else (no answer, too slow, an odd
 * answer, a refused address): not known.
 */
export function outcomeOfNvrError(e: unknown): LoginOutcome {
  // Round 2 (review I-2; ruling NB-8): the shared classifier; only an answer after the password was sent counts (undefined: a fake or
  // an older caller that does not say, taken as sent).
  if (!(e instanceof NvrError)) return 'unknown'
  const credentialsSent = e.credentialsSent !== false
  if (e.kind === 'auth') return classifyLoginAnswer({ status: 'refused', credentialsSent })
  if (e.kind === 'forbidden') return classifyLoginAnswer({ status: 'forbidden', credentialsSent })
  return 'unknown'
}

/**
 * What an RTSP DESCRIBE answer says about the login: 401 refused, nothing (0) not known, any other answer: the login was accepted —
 * each only when the password was sent (round 2, review M-4: a 401 to a request that carried no login refused nobody).
 */
export const outcomeOfRtspCode = (code: number, authSent?: boolean): LoginOutcome => classifyRtspCode(code, authSent !== false)

/** Whether a client says its saved login was accepted (NvrClient.loginProven); a client that cannot say is taken as proven. */
const provenBy = (client: object): boolean => {
  const f = (client as { loginProven?: unknown }).loginProven
  return typeof f === 'function' ? (f as () => boolean).call(client) === true : true
}

/**
 * go2rtc's error text for a refused RTSP login (go2rtc 1.9: "wrong user/pass", or "user/pass not provided"; a raw 401 is matched too).
 * To be confirmed on the pilot's go2rtc build (pilot item, docs/drishti/runbooks/monitoring-rollout.md).
 */
export const isGo2rtcLoginRefusal = (text: string): boolean => /wrong user\/pass|user\/pass not provided|\b401\b|unauthori[sz]ed/i.test(text)

/**
 * One permission to log in, from a gate answer: settles once with the first outcome that says something (ok or refused); `close`
 * gives an unused attempt back. A "go" is reported too (it keeps the proof fresh for live video).
 */
export class LoginTicket {
  private settled = false
  constructor(
    private readonly client: AdminClient,
    readonly recorderId: string,
    readonly gate: LoginGate,
    private readonly path: LoginPath,
    private readonly cfg?: BackoffConfig,
  ) {}

  /** The first ok / refused counts; an "unknown" counts only for the one attempt (it gives it back). */
  async settle(outcome: LoginOutcome): Promise<void> {
    if (this.settled || this.gate.version === null) return
    if (outcome === 'unknown' && !this.gate.claimed) return
    this.settled = true
    await reportNvrLogin(this.client, this.recorderId, this.gate.version, outcome, this.path, this.cfg)
  }

  /** From an error of an NVR request (see outcomeOfNvrError). */
  fromError(e: unknown): Promise<void> {
    return this.settle(outcomeOfNvrError(e))
  }

  /** Nothing more will be sent: an attempt that said nothing is given back. */
  close(): Promise<void> {
    return this.settle('unknown')
  }
}

/**
 * Live video and 1x playback are dialled by go2rtc when a viewer connects, many at once (a wall of 16 tiles). So when the gate says
 * this caller holds the ONE attempt (a login never proven, or proven too long ago), the web server proves the login itself with one RTSP
 * DESCRIBE of one channel BEFORE any go2rtc source is registered, and reports it: a wrong password then costs one refused login, not
 * sixteen. Answers the outcome; 'ok' when there was nothing to prove (a fresh proof exists).
 */
export async function proveVideoLogin(ticket: LoginTicket, describe: () => Promise<{ code: number; authSent?: boolean }>): Promise<LoginOutcome> {
  if (!ticket.gate.claimed) return 'ok'
  let answer: { code: number; authSent?: boolean } = { code: 0, authSent: false }
  try {
    answer = await describe()
  } catch {
    answer = { code: 0, authSent: false }
  }
  const outcome = outcomeOfRtspCode(answer.code, answer.authSent)
  // Round 2 (review I-1; ruling NB-7): an inconclusive proof (no answer, or an answer nobody logged in for) keeps the claim: the caller
  // lets at most ONE go2rtc source dial as the attempt, and every other caller waits for the claim to end.
  if (outcome !== 'unknown') await ticket.settle(outcome)
  return outcome
}

/** True when the gate lets this caller log in now. */
export const mayLogIn = (g: LoginGate): boolean => g.decision === 'go' || (g.decision === 'probe' && g.claimed)

/**
 * An NVR client whose every request settles the ticket: a request that worked proves the login, an NVR error is judged by
 * outcomeOfNvrError. Methods are looked up when called (private fields of the client stay its own).
 */
export function guardNvrClient<T extends object>(client: T, ticket: LoginTicket): T {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const r = (value as (...a: unknown[]) => unknown).apply(target, args)
        if (!(r instanceof Promise)) return r
        return r.then(
          async (v) => {
            // Round 2 (review I-2): an answer nobody logged in for proves nothing (unknown gives the attempt back).
            await ticket.settle(classifyLoginAnswer({ status: 'success', credentialsSent: provenBy(target) }))
            return v
          },
          async (e) => {
            await ticket.fromError(e)
            throw e
          },
        )
      }
    },
  })
}
