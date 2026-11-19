import type { Actor, AdminClient, Result } from '@/lib/admin/types'
import { mapLimit } from '@/lib/async/pool'
import { IT_VIEW } from '@/lib/auth/capabilities'
import { camerasFor, recorderFor } from '@/lib/auth/resource'
import { MSG_MONITORING_OFF, MSG_NOT_MAPPED, readRecorderPassword, resolveCameraRoutes, type RouteAnswer } from '@/lib/inventory/recorders'
import { realProbes } from '@/lib/monitor/probes'
import type { Probes } from '@/lib/monitor/types'
import {
  gateLoginPatiently, LIVE_LOGIN_FRESH_SEC, LoginTicket, mayLogIn, MSG_CAMERA_NOT_AVAILABLE, MSG_LOGIN_STATE_UNREADABLE, MSG_NVR_LOGIN_CHECKING,
  proveVideoLogin, refusedWords,
} from '@/lib/nvr/login-guard'
import { logger } from '@/lib/observability/logger'
import { getSecret } from '@/lib/secrets'
import { checkRecorderTarget } from '@/lib/security/targets'
import type { Go2rtcClient } from '@/lib/streams/go2rtc'
import { maxStreamsPerUser } from '@/lib/streams/concurrency'
import { createLiveSessions, releaseLiveSessions } from '@/lib/streams/registry'
import { buildRtspUrl, demoSource, isDemoRecorder } from '@/lib/streams/source'
import { signStreamToken, streamName, TOKEN_LIFETIME_SEC, verifyStreamToken } from '@/lib/streams/token'

// Opens live streams for the cameras a person may watch live: registers each in go2rtc under its stream name and signs a token for it.
// The RTSP address (with the camera password) exists only inside this function, on its way to go2rtc. What comes back holds no
// password and no address, only the token the browser hands to the gateway.

export type OpenedStream = { cameraId: string; name: string; storeCode: string; channel: number; token: string; kind: 'sub' | 'main' }
/**
 * `paused`: cameras left out because the person already has LIVE_MAX_STREAMS_PER_USER live streams open (P4-L1); only when any.
 * `unavailable` (final fix X, NB-2): cameras of an NVR whose login stands refused, with the words to show on the tile; only when any.
 */
export type OpenedStreams = { streams: OpenedStream[]; paused?: string[]; unavailable?: { cameraId: string; message: string }[] }

/** The most streams one request may open (a 6 by 6 wall). */
export const MAX_STREAMS_PER_REQUEST = 36
export const MSG_NOT_SET_UP = 'Live video is not set up yet.'
export const MSG_UNAVAILABLE = 'The video server is not available.'
const MSG_NONE = 'Choose at least one camera.'
const MSG_TOO_MANY = `You can open at most ${MAX_STREAMS_PER_REQUEST} cameras at once.`
export const MSG_FAILED_OPEN = 'Could not open the video. Please try again.'
const MSG_FAILED = MSG_FAILED_OPEN
const REGISTER_PARALLEL = 6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type OpenDeps = {
  /** The media path's own database client (P2-6: media_service, `createMediaClient`): routes, media sessions, NVR logins for `live`. */
  admin: AdminClient
  /** The person's own signed-in client: it answers which cameras they may watch live. */
  rls: AdminClient
  go2rtc: Go2rtcClient
  /** The RTSP DESCRIBE that proves an NVR login before go2rtc dials it (default: the guarded real probe; final fix X). */
  rtsp?: Probes['rtsp']
  env?: Record<string, string | undefined>
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number
}

export type RenewedToken = { cameraId: string; token: string }
/** What the wall let go of (P4-L1 review I-1): those cameras' unused tokens are revoked and no longer count against the cap. */
export type StreamRelease = { cameraIds: string[]; kind: 'sub' | 'main' }
/**
 * `client` (fix round 2, N-6): the id of the browser window (one per page load) that asks. Its sessions carry it, and a release only
 * ever revokes that window's own unused tokens, never another window's token for the same camera.
 */
export type StreamOptions = { release?: StreamRelease[]; client?: string }

const cleanIds = (ids: unknown): string[] =>
  Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))] : []

/** The window id the browser sent, when it is one (anything else: none). */
export const cleanClient = (c: unknown): string | null => (typeof c === 'string' && UUID.test(c) ? c.toLowerCase() : null)

/** The stream names to release, from what the browser sent (ids only; at most two requests' worth). */
function releasedStreams(o: Pick<StreamOptions, 'release'> | undefined): string[] {
  if (!o || !Array.isArray(o.release)) return []
  return o.release.slice(0, 4).flatMap((r) => (r && (r.kind === 'sub' || r.kind === 'main') ? cleanIds(r.cameraIds).slice(0, MAX_STREAMS_PER_REQUEST).map((c) => streamName({ c, k: r.kind })) : []))
}

/** The most tokens one leave release may name (a 6 by 6 wall and its large picture, twice). */
export const MAX_RELEASE_TOKENS = 76

/**
 * Fix round 2 (N-1): a page that is left (pagehide, hidden, route change) hands back the live tokens it holds, so the unused ones (the
 * one-minute renewal's) stop counting against the person's cap at once instead of for up to 90 s. Only tokens this server signed, for
 * live video and for this person, count; their media sessions are revoked when never used. So a release reaches neither another window's
 * token for the same camera (N-6) nor a token handed out after the page was left (a next wall on the same camera); a socket that is open
 * is never ended here (the page closes its sockets itself), and nothing is opened or read. When it cannot be done the tokens simply run
 * out (90 s).
 */
export async function releaseStreams(
  deps: Pick<OpenDeps, 'admin' | 'now'>,
  actor: Pick<Actor, 'id' | 'orgId'>,
  tokens: unknown,
): Promise<Result<{ released: number }>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  const now = (deps.now ?? Date.now)()
  const list = Array.isArray(tokens) ? tokens.slice(0, MAX_RELEASE_TOKENS) : []
  const sids = [...new Set(list.flatMap((t) => {
    const c = typeof t === 'string' ? verifyStreamToken(t, now, secret) : null
    return c && c.u === actor.id && (c.k === 'sub' || c.k === 'main') ? [c.sid] : []
  }))]
  if (sids.length === 0) return { ok: true, released: 0 }
  try {
    return { ok: true, released: await releaseLiveSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, sids }) }
  } catch {
    logger.error({ event: 'release_streams_failed' })
    return { ok: false, error: MSG_FAILED }
  }
}

/**
 * P2-4 review m-11: the live wall's one-minute renewal. Only what a token needs: cctv.live for each camera (the person's own client),
 * the live sessions (the database checks the person, the capability and that the camera can still be streamed — an NVR that was
 * switched off is left out — and, P4-L1 review I-1, the person's stream cap: a renewal of a stream they hold always works, a token for
 * a stream beyond the cap is not given, the camera comes back as `paused`) and the signed tokens. No route, no NVR login, no go2rtc
 * request: the streams were registered by the wall's last full opening (openStreams, every 8 minutes and for every camera that failed).
 */
export async function renewStreams(
  deps: Pick<OpenDeps, 'admin' | 'rls' | 'env' | 'now'>,
  actor: Pick<Actor, 'id' | 'orgId'>,
  cameraIds: string[],
  kind: 'sub' | 'main',
  opts?: StreamOptions,
): Promise<Result<{ tokens: RenewedToken[]; paused?: string[] }>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  if (kind !== 'sub' && kind !== 'main') return { ok: false, error: MSG_FAILED }
  if (!Array.isArray(cameraIds) || cameraIds.length === 0) return { ok: false, error: MSG_NONE }
  if (cameraIds.length > MAX_STREAMS_PER_REQUEST) return { ok: false, error: MSG_TOO_MANY }
  const wanted = cleanIds(cameraIds)
  if (wanted.length === 0) return { ok: false, error: MSG_NONE }
  const allowed = await camerasFor(deps.rls, 'cctv.live', wanted)
  if (!allowed.ok) return { ok: false, error: MSG_FAILED }
  const mayWatch = wanted.filter((id) => allowed.ids.includes(id))
  if (mayWatch.length === 0) return { ok: true, tokens: [] }
  let made: Awaited<ReturnType<typeof createLiveSessions>>
  try {
    made = await createLiveSessions(deps.admin, {
      orgId: actor.orgId, userId: actor.id, cameras: mayWatch.map((id) => ({ id, stream: streamName({ c: id, k: kind }) })),
      max: maxStreamsPerUser(deps.env ?? process.env), release: releasedStreams(opts), client: cleanClient(opts?.client),
    })
  } catch {
    // Fail closed (review I-1): the cap could not be checked, so nothing new is handed out.
    logger.error({ event: 'renew_streams_sessions_failed' })
    return { ok: false, error: MSG_FAILED }
  }
  const exp = Math.floor((deps.now ?? Date.now)() / 1000) + TOKEN_LIFETIME_SEC
  const tokens = mayWatch.flatMap((id) => {
    const sid = made.sids.get(id)
    return sid ? [{ cameraId: id, token: signStreamToken({ sid, u: actor.id, c: id, k: kind, exp }, secret) }] : []
  })
  return made.paused.length > 0 ? { ok: true, tokens, paused: made.paused } : { ok: true, tokens }
}

export async function openStreams(
  deps: OpenDeps,
  actor: Pick<Actor, 'id' | 'orgId'>,
  cameraIds: string[],
  kind: 'sub' | 'main',
  opts?: StreamOptions,
): Promise<Result<OpenedStreams>> {
  const secret = getSecret('stream_token')
  if (!secret) return { ok: false, error: MSG_NOT_SET_UP }
  if (kind !== 'sub' && kind !== 'main') return { ok: false, error: MSG_FAILED }
  if (!Array.isArray(cameraIds) || cameraIds.length === 0) return { ok: false, error: MSG_NONE }
  if (cameraIds.length > MAX_STREAMS_PER_REQUEST) return { ok: false, error: MSG_TOO_MANY }

  // Anything that is not an id is dropped; so are repeats. One spelling (lower case) is used from here on.
  const wanted = cleanIds(cameraIds)
  if (wanted.length === 0) return { ok: false, error: MSG_NONE }

  // The person's own client decides which cameras they may watch live (cctv.live; P2-1, directive AC-2): a camera they may not watch
  // simply does not come back. Only for those, the NVR address and login are read with the service role (they are not readable by
  // signed-in people any more, AC-10), and only in the person's own organisation.
  const allowed = await camerasFor(deps.rls, 'cctv.live', wanted)
  if (!allowed.ok) return { ok: false, error: MSG_FAILED }
  const mayWatch = allowed.ids
  if (mayWatch.length === 0) return { ok: true, streams: [] }
  // P2-5b: each camera is reached through the recorder of its ACTIVE channel mapping — that NVR's address, video port, login and
  // password, and the channel of the mapping. Owner addition: nothing is opened towards an NVR whose monitoring is switched off (no
  // credential read, no go2rtc call); a camera without a mapping cannot be opened at all.
  let answers
  try {
    answers = await resolveCameraRoutes(deps.admin, actor.orgId, mayWatch)
  } catch {
    logger.error({ event: 'open_streams_read_failed' })
    return { ok: false, error: MSG_FAILED }
  }
  const listed = wanted.map((id) => answers.get(id)).filter((a): a is RouteAnswer => a !== undefined)
  if (listed.length === 0) return { ok: true, streams: [] }
  const routable = listed.flatMap((a) => (a.kind === 'ok' ? [a.route] : []))
  if (routable.length === 0) return { ok: false, error: listed.some((a) => a.kind === 'off') ? MSG_MONITORING_OFF : MSG_NOT_MAPPED }

  const env = deps.env ?? process.env

  // Final fix X (review C I-2; NB-2) and round 2 (review I-1, M-1, M-5, M-6; NB-7, NB-9): the shared NVR login state is asked FIRST, per
  // NVR, before any media session is made, any password read or any go2rtc source registered. An NVR whose login stands refused (or
  // paused), is being checked by another path right now, or whose state cannot be read gets no session (so its cameras never take a
  // place under the person's stream cap, however often the wall asks again), no password read and no source: its cameras come back in
  // `unavailable` with plain words (the NVR detail only for people with the IT view of that NVR; "Camera not available." for everybody
  // else), and the wall asks again in 30 s, which contacts nothing while the back-off lasts.
  type Why = 'refused' | 'checking' | 'unreadable' | 'unproven'
  const why = new Map<string, Why>()
  const tickets = new Map<string, LoginTicket>()
  const addresses = new Map<string, string>()
  const blocked = new Set<string>() // no saved password or a refused address: left out without a word, as before
  const recordersAll = [...new Map(routable.map((r) => [r.recorder.id, r.recorder])).values()]
  await mapLimit(recordersAll, 4, async (rec) => {
    if (isDemoRecorder(rec, env)) return
    // P2-6 (SO-4): the NVR's address must pass the outbound target check; the source given to go2rtc then carries the checked address.
    const target = await checkRecorderTarget(rec, { env })
    if (!target.ok) {
      logger.warn({ event: 'open_streams_target_refused', location: rec.code, recorder: rec.id })
      blocked.add(rec.id)
      return
    }
    addresses.set(rec.id, target.address)
    let gate
    try {
      gate = await gateLoginPatiently(deps.admin, rec.id, { path: 'live', freshSec: LIVE_LOGIN_FRESH_SEC })
    } catch {
      logger.error({ event: 'open_streams_login_state_failed', location: rec.code, recorder: rec.id })
      why.set(rec.id, 'unreadable')
      return
    }
    if (gate.decision === 'refused' || gate.decision === 'paused') why.set(rec.id, 'refused')
    else if (gate.decision === 'no_password') blocked.add(rec.id)
    else if (!mayLogIn(gate)) why.set(rec.id, 'checking')
    else tickets.set(rec.id, new LoginTicket(deps.admin, rec.id, gate, 'live'))
  })
  const candidates = routable.filter((r) => !why.has(r.recorder.id) && !blocked.has(r.recorder.id))

  // P2-4 (D-3, AC-14): one media session per stream, made by the database after checking cctv.live for this person once more (the
  // registry the gateway asks when the socket arrives and every 15 s afterwards). A camera it refuses is left out like any other
  // camera one may not watch. P4-L1 review I-1: in the same call and under one lock per person, the database applies the person's
  // stream cap (LIVE_MAX_STREAMS_PER_USER, default 25): it counts the distinct streams the person holds — open sockets AND tokens that
  // can still connect — and answers the cameras beyond it as `paused` (the wall says "Paused to save bandwidth"): no session, no NVR
  // password read, no go2rtc call for them. When it cannot be asked at all nothing is opened and no password is read (fail closed).
  const closeAll = async () => {
    for (const t of tickets.values()) await t.close()
  }
  let made: Awaited<ReturnType<typeof createLiveSessions>> = { sids: new Map(), paused: [] }
  if (candidates.length > 0) {
    try {
      made = await createLiveSessions(deps.admin, {
        orgId: actor.orgId, userId: actor.id, cameras: candidates.map((r) => ({ id: r.camera.id, stream: streamName({ c: r.camera.id, k: kind }) })),
        max: maxStreamsPerUser(env), release: releasedStreams(opts), client: cleanClient(opts?.client),
      })
    } catch {
      logger.error({ event: 'open_streams_sessions_failed' })
      await closeAll()
      return { ok: false, error: MSG_FAILED }
    }
  }
  const sids = made.sids
  const registered = candidates.filter((r) => sids.has(r.camera.id))

  // One password read per recorder, and only for recorders that need one (a demo NVR has no real camera behind it). When this request
  // holds the ONE attempt (a login never proven, or proven more than 10 minutes ago) it proves the login with one RTSP DESCRIBE first:
  // refused → nothing registered; no answer (a slow or hung NVR) → round 2 (I-1, NB-7): at most ONE source is registered for that NVR,
  // as the one claimed attempt (the claim is kept, so every other caller waits), the other tiles say "Camera not available." until a
  // login is proven. A ticket of an NVR that ends up with nothing to open is given back (M-5).
  const passwords = new Map<string, string>()
  const firstChannel = new Map<string, number>()
  for (const r of registered) if (!firstChannel.has(r.recorder.id)) firstChannel.set(r.recorder.id, r.camera.channel)
  await mapLimit([...tickets.entries()], 4, async ([recId, ticket]) => {
    const rec = recordersAll.find((x) => x.id === recId)!
    if (!firstChannel.has(recId)) return void (await ticket.close()) // every camera of it paused by the cap: nothing tried
    const read = await readRecorderPassword(deps.admin, rec.id, 'live', actor.id)
    if (!read.ok) logger.error({ event: 'open_streams_credential_failed', location: rec.code, recorder: rec.id, errorCode: read.code })
    const password = read.ok ? read.password : null
    if (!password) {
      await ticket.close()
      blocked.add(rec.id)
      return
    }
    const proof = await proveVideoLogin(ticket, () => (deps.rtsp ?? realProbes.rtsp)({ host: addresses.get(rec.id)!, port: rec.rtsp_port, username: rec.username, password, channel: firstChannel.get(rec.id)! }))
    if (proof === 'refused') return void why.set(rec.id, 'refused')
    if (proof === 'unknown') why.set(rec.id, 'unproven')
    passwords.set(rec.id, password)
  })

  // Who gets which words; which sessions are given back (cameras not opened never count against the cap).
  const unavailable: { cameraId: string; message: string }[] = []
  const giveBack: string[] = []
  const itView = new Map<string, boolean>()
  const words = async (recId: string, w: Why): Promise<string> => {
    if (w === 'unproven') return MSG_CAMERA_NOT_AVAILABLE
    if (!itView.has(recId)) itView.set(recId, await itViewOfRecorder(deps.rls, recId))
    if (!itView.get(recId)) return MSG_CAMERA_NOT_AVAILABLE
    // Round 3 (NB-12): an NVR that waits because of the gateway's fail-safe has its own words (not "login refused").
    return w === 'refused' ? await refusedWords(deps.admin, recId) : w === 'checking' ? MSG_NVR_LOGIN_CHECKING : MSG_LOGIN_STATE_UNREADABLE
  }
  const toOpen: typeof registered = []
  const oneOnly = new Set<string>()
  for (const r of routable) {
    const w = why.get(r.recorder.id)
    const session = sids.get(r.camera.id)
    if (w === 'unproven' && session && !oneOnly.has(r.recorder.id)) {
      oneOnly.add(r.recorder.id) // the one source that dials as the claimed attempt
      toOpen.push(r)
      continue
    }
    if (w) {
      unavailable.push({ cameraId: r.camera.id, message: await words(r.recorder.id, w) })
      if (session) giveBack.push(session)
      continue
    }
    if (session) toOpen.push(r)
  }
  if (giveBack.length > 0) await releaseLiveSessions(deps.admin, { orgId: actor.orgId, userId: actor.id, sids: giveBack }).catch(() => 0)
  const withPaused = (streams: OpenedStream[]): OpenedStreams => {
    const out: OpenedStreams = made.paused.length > 0 ? { streams, paused: made.paused } : { streams }
    return unavailable.length > 0 ? { ...out, unavailable } : out
  }
  if (toOpen.length === 0) return { ok: true, ...withPaused([]) }

  const now = deps.now ?? Date.now
  const exp = Math.floor(now() / 1000) + TOKEN_LIFETIME_SEC
  let failed = 0
  const opened = await mapLimit(toOpen, REGISTER_PARALLEL, async ({ camera: c, recorder: rec }): Promise<OpenedStream | null> => {
    try {
      let src: string
      const demo = isDemoRecorder(rec, env)
      if (demo) src = demoSource(c.channel, c.id)
      else {
        const password = passwords.get(rec.id)
        const address = addresses.get(rec.id)
        if (!password || !address) return null // no saved NVR password (or a refused address): this camera cannot be opened (the others still can)
        src = buildRtspUrl({ host: address, port: rec.rtsp_port, username: rec.username, password, channel: c.channel, kind })
      }
      // The stream is named by the camera, never by the channel: a remapped camera keeps its stream name (and its viewers' tokens).
      const name = streamName({ c: c.id, k: kind })
      await deps.go2rtc.register(name, src, { keepExisting: demo })
      const token = signStreamToken({ sid: sids.get(c.id)!, u: actor.id, c: c.id, k: kind, exp }, secret)
      return { cameraId: c.id, name: c.name, storeCode: c.code, channel: c.channel, token, kind }
    } catch {
      failed++
      logger.error({ event: 'open_stream_failed', location: c.code, recorder: rec.id, channel: c.channel, kind }) // no address, no error text: they can carry a password
      return null
    }
  })
  // Streams nobody has watched for a long time are removed from go2rtc (at most once a minute; never waits, never fails the request).
  void deps.go2rtc.prune({ now: now() }).catch(() => {})
  const streams = opened.filter((s): s is OpenedStream => s !== null)
  if (streams.length === 0 && failed > 0 && unavailable.length === 0) return { ok: false, error: MSG_UNAVAILABLE }
  return { ok: true, ...withPaused(streams) }
}

/** Whether the person has the IT view of this NVR (it.inventory.view or it.monitoring.view covering it), asked as the person. */
async function itViewOfRecorder(rls: AdminClient, recorderId: string): Promise<boolean> {
  for (const cap of IT_VIEW) {
    const r = await recorderFor(rls, cap, recorderId)
    if (r.ok && r.allowed) return true
  }
  return false
}
