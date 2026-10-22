// Talks to go2rtc's HTTP API (loopback only). The stream source contains camera credentials, so nothing thrown here ever carries
// the address, the source, the name or the underlying error: callers get a plain sentence and nothing that could be logged by mistake.

const NAME = /^[A-Za-z0-9_-]{1,200}$/
const MSG_REGISTER = 'The video server did not accept the stream.'
const MSG_REMOVE = 'The video server did not remove the stream.'
const MSG_READ = 'The video server did not answer.'
const MSG_ADDRESS = 'The video server address is not valid.'

export const GO2RTC_TIMEOUT_MS = 5000
/** The stream list is small; anything bigger than this is not go2rtc talking. */
export const MAX_LIST_BYTES = 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

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

export class Go2rtcClient {
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly timeoutMs: number = GO2RTC_TIMEOUT_MS,
  ) {
    this.base = loopbackOrigin(baseUrl)
  }

  /** The body as text, refusing anything over MAX_LIST_BYTES without reading the rest. */
  private async readCapped(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_LIST_BYTES) {
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
        if (total > MAX_LIST_BYTES) throw new Error(MSG_READ)
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
      return await this.fetchImpl(`${this.base}${pathAndQuery}`, { method, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual', cache: 'no-store' })
    } catch {
      throw new Error(message)
    }
  }

  /** One call to go2rtc. Any failure (network, timeout, redirect, non-2xx) becomes `message`; the response body is dropped unread. */
  private async call(method: string, pathAndQuery: string, message: string): Promise<Response> {
    const res = await this.send(method, pathAndQuery, message)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(message)
    }
    return res
  }

  /**
   * A change to the stream list. go2rtc runs with a read-only config file: it applies the change in memory but then answers 400 because it
   * cannot save the file, so the status alone proves nothing. 2xx and 400 are "maybe": the list is read back and decides. Any other status
   * (or no answer) is a failure, and so is a list that is not as asked.
   */
  private async change(method: 'PUT' | 'DELETE', pathAndQuery: string, name: string, wanted: boolean, message: string): Promise<void> {
    const res = await this.send(method, pathAndQuery, message)
    await res.body?.cancel().catch(() => {})
    if (!res.ok && res.status !== 400) throw new Error(message)
    let present: boolean
    try {
      present = await this.has(name)
    } catch {
      throw new Error(message)
    }
    if (present !== wanted) throw new Error(message)
  }

  /**
   * Registers a stream, unless go2rtc already has it from this very source. Registering again replaces go2rtc's stream with a new one:
   * viewers already watching stay on the old one, and the next viewer starts a second connection to the camera (an NVR allows only a few).
   * So an unchanged stream is left alone, and a changed source (a new password) is registered again. go2rtc lists a running generated
   * source (the demo picture) without its address, so a caller that knows its source never changes can pass `keepExisting`: any stream of
   * that name is then left alone.
   */
  async register(name: string, src: string, opts: { keepExisting?: boolean } = {}): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name) || typeof src !== 'string' || src === '') throw new Error(MSG_REGISTER)
    let listed: Record<string, unknown>
    try {
      listed = await this.list()
    } catch {
      throw new Error(MSG_REGISTER)
    }
    if (Object.hasOwn(listed, name) && (opts.keepExisting === true || producerUrls(listed[name]).includes(src))) return
    await this.change('PUT', `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, name, true, MSG_REGISTER)
  }

  async remove(name: string): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(MSG_REMOVE)
    await this.change('DELETE', `/api/streams?src=${encodeURIComponent(name)}`, name, false, MSG_REMOVE)
  }

  /** The streams go2rtc has, by name (GET /api/streams). Whatever is wrong with the answer becomes the plain message. */
  private async list(): Promise<Record<string, unknown>> {
    const res = await this.call('GET', '/api/streams', MSG_READ)
    let list: unknown
    try {
      list = JSON.parse(await this.readCapped(res))
    } catch {
      throw new Error(MSG_READ)
    }
    if (typeof list !== 'object' || list === null || Array.isArray(list)) throw new Error(MSG_READ)
    return list as Record<string, unknown>
  }

  async has(name: string): Promise<boolean> {
    if (typeof name !== 'string' || !NAME.test(name)) return false
    return Object.hasOwn(await this.list(), name)
  }
}

/** The source addresses go2rtc lists for one stream. Never logged or returned: they can hold a camera password. */
function producerUrls(stream: unknown): string[] {
  const producers = typeof stream === 'object' && stream !== null ? (stream as { producers?: unknown }).producers : undefined
  if (!Array.isArray(producers)) return []
  return producers.map((p) => (typeof p === 'object' && p !== null ? (p as { url?: unknown }).url : undefined)).filter((u): u is string => typeof u === 'string')
}
