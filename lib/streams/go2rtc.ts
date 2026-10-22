// Talks to go2rtc's HTTP API (loopback only). The stream source contains camera credentials, so nothing thrown here ever carries
// the address, the source, the name or the underlying error: callers get a plain sentence and nothing that could be logged by mistake.

import { logger } from '@/lib/observability/logger'
import { isProductionMode } from '@/lib/runtime-mode'
import { sourceRefusal } from '@/lib/security/targets'
import { basicAuthHeader, go2rtcApiAuth, type Go2rtcAuth } from '@/lib/streams/go2rtc-auth'

const NAME = /^[A-Za-z0-9_-]{1,200}$/
/** The only stream names the pruner may remove: live (cam_<id>_sub|main) and playback (pb_<id>_<start>) streams made by this app. */
const PRUNABLE = /^(cam|pb)_[0-9a-f-]{36}_(sub|main|\d+)$/
const MSG_REGISTER = 'The video server did not accept the stream.'
const MSG_REMOVE = 'The video server did not remove the stream.'
const MSG_READ = 'The video server did not answer.'
const MSG_ADDRESS = 'The video server address is not valid.'
const MSG_NO_LOGIN = 'The video server login is not set up.'

export const GO2RTC_TIMEOUT_MS = 5000
/** One stream's entry is small; anything bigger than this is not go2rtc talking. */
export const MAX_STREAM_BYTES = 1024 * 1024
/** The whole list holds every stream of every organisation, with its source; it is only read to prune. */
export const MAX_LIST_BYTES = 16 * 1024 * 1024
/** A stream nobody watched for this long (and that this process has not registered again) may be pruned. */
export const PRUNE_IDLE_MS = 30 * 60_000
export const PRUNE_EVERY_MS = 60_000
export const PRUNE_MAX_REMOVALS = 50
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** When this process last registered or saw a watched stream, per go2rtc address and name. Several requests share it. */
const lastUsed = new Map<string, number>()
const lastPrune = new Map<string, number>()
/** Registrations in progress, so that requests for the same stream at the same moment share one. */
const inFlight = new Map<string, Promise<void>>()

/** Only a go2rtc on this machine: stream sources carry camera passwords and must never be sent anywhere else. */
function loopbackOrigin(baseUrl: string): string {
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    throw new Error(MSG_ADDRESS)
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK_HOSTS.has(u.hostname) || u.username !== '' || u.password !== '') throw new Error(MSG_ADDRESS)
  return u.origin
}

type Read = { present: boolean; busy: boolean; urls: string[] }

export class Go2rtcClient {
  private readonly base: string
  // A true private field: logging or inspecting a client never shows the API password.
  readonly #authorization: string | null

  /**
   * `auth` (P2-6, D-13): go2rtc's API credentials; left out, they come from GO2RTC_API_USERNAME / GO2RTC_API_PASSWORD (both or neither);
   * null: none.
   */
  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly timeoutMs: number = GO2RTC_TIMEOUT_MS,
    auth?: Go2rtcAuth | null,
  ) {
    this.base = loopbackOrigin(baseUrl)
    const a = auth === undefined ? go2rtcApiAuth() : auth
    // Review round 1 (I-2): in production the login is required (an API without it lists NVR sources with passwords).
    if (!a && isProductionMode()) throw new Error(MSG_NO_LOGIN)
    this.#authorization = a ? basicAuthHeader(a) : null
  }

  /** The body as text, refusing anything over `cap` bytes without reading the rest. */
  private async readCapped(res: Response, cap: number): Promise<string> {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      await res.body?.cancel().catch(() => {})
      throw new Error(MSG_READ)
    }
    if (!res.body) return ''
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > cap) throw new Error(MSG_READ)
        chunks.push(value)
      }
    } catch {
      await reader.cancel().catch(() => {})
      throw new Error(MSG_READ)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** One call to go2rtc; the answer is returned whatever its status. A network failure, timeout or redirect becomes `message`. */
  private async send(method: string, pathAndQuery: string, message: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${pathAndQuery}`, {
        method, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual', cache: 'no-store',
        ...(this.#authorization ? { headers: { Authorization: this.#authorization } } : {}),
      })
    } catch {
      throw new Error(message)
    }
  }

  private key(name: string): string {
    return `${this.base}|${name}`
  }

  /** One stream, read on its own (GET /api/streams?src=<name>: only that stream, 404 when go2rtc does not have it). */
  private async read(name: string): Promise<Read> {
    const res = await this.send('GET', `/api/streams?src=${encodeURIComponent(name)}`, MSG_READ)
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return { present: false, busy: false, urls: [] }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(MSG_READ)
    }
    let stream: unknown
    try {
      stream = JSON.parse(await this.readCapped(res, MAX_STREAM_BYTES))
    } catch {
      throw new Error(MSG_READ)
    }
    if (typeof stream !== 'object' || stream === null || Array.isArray(stream)) throw new Error(MSG_READ)
    return { present: true, busy: streamBusy(stream), urls: producerUrls(stream) }
  }

  /** Sends a change and trusts nothing but what is read back; `ok` decides from the new state whether it worked. */
  private async change(method: 'PUT' | 'DELETE', pathAndQuery: string, name: string, message: string, ok: (now: Read) => boolean): Promise<void> {
    const res = await this.send(method, pathAndQuery, message)
    await res.body?.cancel().catch(() => {})
    // go2rtc runs with a read-only config: it applies the change in memory and then answers 400 because it cannot save the file.
    // So 2xx and 400 are "maybe"; any other status is a failure at once.
    if (!res.ok && res.status !== 400) throw new Error(message)
    let now: Read
    try {
      now = await this.read(name)
    } catch {
      throw new Error(message)
    }
    if (!ok(now)) throw new Error(message)
  }

  /**
   * Registers a stream, unless go2rtc already has it from this very source. Registering again replaces go2rtc's stream with a new one:
   * viewers already watching stay on the old one, and the next viewer starts a second connection to the camera (an NVR allows only a few).
   * So an unchanged stream is left alone, and a changed source (a new password) is registered again and must then be listed with the new
   * source: a 400 that did not apply fails the registration. go2rtc lists a running generated source (the demo picture) without its
   * address, so a caller that knows its source never changes can pass `keepExisting`: any stream of that name is then left alone.
   * Requests for the same stream at the same moment share one registration.
   */
  register(name: string, src: string, opts: { keepExisting?: boolean } = {}): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name) || typeof src !== 'string' || src === '') return Promise.reject(new Error(MSG_REGISTER))
    // P2-6 (D-13): only rtsp:// to a registered NVR endpoint, or the demo picture outside production; nothing is sent otherwise.
    if (sourceRefusal(src)) {
      logger.warn({ event: 'go2rtc_source_refused', stream: name }) // never the source: it holds a password
      return Promise.reject(new Error(MSG_REGISTER))
    }
    const key = `${this.key(name)}|${opts.keepExisting === true ? 'keep' : 'exact'}|${src}`
    const running = inFlight.get(key)
    if (running) return running
    const job = this.registerNow(name, src, opts.keepExisting === true).finally(() => inFlight.delete(key))
    inFlight.set(key, job)
    return job
  }

  private async registerNow(name: string, src: string, keepExisting: boolean): Promise<void> {
    let before: Read
    try {
      before = await this.read(name)
    } catch {
      throw new Error(MSG_REGISTER)
    }
    if (before.present && (keepExisting || before.urls.includes(src))) {
      lastUsed.set(this.key(name), Date.now())
      return
    }
    // A stream that was not there is accepted as listed; one that was there with another source must now show the new one.
    const path = `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`
    await this.change('PUT', path, name, MSG_REGISTER, (now) => now.present && (!before.present || now.urls.includes(src)))
    lastUsed.set(this.key(name), Date.now())
  }

  async remove(name: string): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(MSG_REMOVE)
    await this.change('DELETE', `/api/streams?src=${encodeURIComponent(name)}`, name, MSG_REMOVE, (now) => !now.present)
    lastUsed.delete(this.key(name))
  }

  /**
   * One stream's state, read on its own: whether go2rtc has it and whether anything is using it (a viewer, or a source that is already
   * connected). Throws when the answer cannot be read (callers then treat the stream as busy). Never returns the source.
   */
  async inspect(name: string): Promise<{ present: boolean; busy: boolean }> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(MSG_READ)
    const { present, busy } = await this.read(name)
    return { present, busy }
  }

  async has(name: string): Promise<boolean> {
    if (typeof name !== 'string' || !NAME.test(name)) return false
    return (await this.read(name)).present
  }

  /** Every stream go2rtc has and whether anybody is watching it (GET /api/streams). Sources are never returned. */
  async list(): Promise<{ name: string; busy: boolean }[]> {
    const res = await this.send('GET', '/api/streams', MSG_READ)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(MSG_READ)
    }
    let all: unknown
    try {
      all = JSON.parse(await this.readCapped(res, MAX_LIST_BYTES))
    } catch {
      throw new Error(MSG_READ)
    }
    if (typeof all !== 'object' || all === null || Array.isArray(all)) throw new Error(MSG_READ)
    return Object.entries(all).map(([name, s]) => {
      const consumers = typeof s === 'object' && s !== null ? (s as { consumers?: unknown }).consumers : undefined
      return { name, busy: Array.isArray(consumers) && consumers.length > 0 }
    })
  }

  /**
   * Keeps go2rtc's stream list from growing for ever: removes streams made by this app that nobody has watched for `idleMs`.
   * Never removes a stream with a viewer, a name that is not one of ours, or more than `max` in one go; a stream seen for the first time
   * only starts its clock. At most one pass a minute per go2rtc. Failures are ignored. Returns how many were removed.
   */
  async prune(o: { now?: number; idleMs?: number; max?: number; everyMs?: number } = {}): Promise<number> {
    const now = o.now ?? Date.now()
    const last = lastPrune.get(this.base)
    if (last !== undefined && now - last < (o.everyMs ?? PRUNE_EVERY_MS)) return 0
    lastPrune.set(this.base, now)
    let streams: { name: string; busy: boolean }[]
    try {
      streams = await this.list()
    } catch {
      return 0
    }
    const idleMs = o.idleMs ?? PRUNE_IDLE_MS
    const max = o.max ?? PRUNE_MAX_REMOVALS
    let removed = 0
    for (const s of streams) {
      if (removed >= max) break
      if (!PRUNABLE.test(s.name)) continue
      const k = this.key(s.name)
      const seen = lastUsed.get(k)
      if (s.busy || seen === undefined) {
        lastUsed.set(k, now) // watched now, or first seen: the clock starts here
        continue
      }
      if (now - seen < idleMs) continue
      try {
        await this.remove(s.name)
        removed++
      } catch {
        // left for the next pass
      }
    }
    // Forget names go2rtc no longer has.
    const present = new Set(streams.map((s) => this.key(s.name)))
    for (const k of [...lastUsed.keys()]) if (k.startsWith(`${this.base}|`) && !present.has(k)) lastUsed.delete(k)
    return removed
  }
}

/**
 * A stream is in use when it has a consumer (a viewer), or one of its producers is already connected: go2rtc lists a producer that is not
 * running with its address only, and adds more fields (connection, media, counters) once it runs.
 */
function streamBusy(stream: unknown): boolean {
  const s = typeof stream === 'object' && stream !== null ? (stream as { consumers?: unknown; producers?: unknown }) : {}
  if (Array.isArray(s.consumers) && s.consumers.length > 0) return true
  return Array.isArray(s.producers) && s.producers.some((p) => typeof p === 'object' && p !== null && Object.keys(p).some((k) => k !== 'url'))
}

/** The source addresses go2rtc lists for one stream. Never logged or returned: they can hold a camera password. */
function producerUrls(stream: unknown): string[] {
  const producers = typeof stream === 'object' && stream !== null ? (stream as { producers?: unknown }).producers : undefined
  if (!Array.isArray(producers)) return []
  return producers.map((p) => (typeof p === 'object' && p !== null ? (p as { url?: unknown }).url : undefined)).filter((u): u is string => typeof u === 'string')
}

export const pruneStreams = (client: Go2rtcClient, o?: Parameters<Go2rtcClient['prune']>[0]): Promise<number> => client.prune(o)

/**
 * Removes the live streams (cam_<id>_sub, cam_<id>_main) of cameras that were archived or moved to another NVR channel (review P2-5b
 * M-4): go2rtc keeps a stream's source until it is registered again, so a viewer reconnecting through the gateway would otherwise reach
 * the camera's OLD channel, which may now carry another camera. The next viewer opens the stream again through openStreams (the
 * camera's current route). Playback streams are left: they show the recording of the time they were opened for. Never throws; a
 * failure is logged with the event name only (the source holds a password).
 */
export async function dropLiveStreams(client: Go2rtcClient, cameraIds: readonly string[]): Promise<void> {
  for (const id of cameraIds) {
    for (const kind of ['sub', 'main'] as const) {
      const name = `cam_${id}_${kind}`
      try {
        if (await client.has(name)) await client.remove(name)
      } catch {
        logger.warn({ event: 'live_stream_drop_failed', camera: id, kind })
      }
    }
  }
}
