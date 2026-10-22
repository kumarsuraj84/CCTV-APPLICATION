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

  /** One call to go2rtc. Any failure (network, timeout, redirect, non-2xx) becomes `message`; the response body is dropped unread. */
  private async call(method: string, pathAndQuery: string, message: string): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${pathAndQuery}`, { method, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual', cache: 'no-store' })
    } catch {
      throw new Error(message)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(message)
    }
    return res
  }

  async register(name: string, src: string): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name) || typeof src !== 'string' || src === '') throw new Error(MSG_REGISTER)
    const res = await this.call('PUT', `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, MSG_REGISTER)
    await res.body?.cancel().catch(() => {})
  }

  async remove(name: string): Promise<void> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(MSG_REMOVE)
    const res = await this.call('DELETE', `/api/streams?src=${encodeURIComponent(name)}`, MSG_REMOVE)
    await res.body?.cancel().catch(() => {})
  }

  async has(name: string): Promise<boolean> {
    if (typeof name !== 'string' || !NAME.test(name)) return false
    const res = await this.call('GET', '/api/streams', MSG_READ)
    let list: unknown
    try {
      list = JSON.parse(await this.readCapped(res))
    } catch {
      throw new Error(MSG_READ)
    }
    if (typeof list !== 'object' || list === null || Array.isArray(list)) throw new Error(MSG_READ)
    return Object.hasOwn(list, name)
  }
}
