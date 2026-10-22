import { isIP } from 'node:net'
import { DigestInputError, DigestUnsupportedError, digestFetch } from '@/lib/nvr/digest'
import { parseChannels, parseChannelStatus, parseVideoInputChannels, type NvrChannel } from '@/lib/nvr/isapi'

export type NvrEndpoint = { host: string; port: number; username: string; password: string }
export type NvrErrorKind = 'unreachable' | 'timeout' | 'auth' | 'forbidden' | 'bad_response'
/** Extra detail for a bad_response: the NVR only offers login methods this app refuses to use (such as Basic), or lists no cameras at all. */
export type NvrErrorReason = 'unsupported_login' | 'no_channels'

export class NvrError extends Error {
  constructor(public kind: NvrErrorKind, message: string, public reason?: NvrErrorReason) {
    super(message)
    this.name = 'NvrError'
  }
}

const MESSAGES: Record<NvrErrorKind, string> = {
  auth: 'The NVR refused the user name or password.',
  forbidden: 'The NVR user is not allowed to read camera status.',
  unreachable: 'The NVR did not answer.',
  timeout: 'The NVR took too long to answer.',
  bad_response: 'The NVR gave an answer this app does not understand.',
}

/** Plain wording for screens and for the stored "why" of a failed check. Never includes passwords or raw network errors. */
export function describeNvrError(e: unknown): string {
  if (!(e instanceof NvrError)) return 'The NVR check failed.'
  if (e.kind === 'bad_response' && e.reason === 'unsupported_login') return 'The NVR does not offer a supported login method.'
  if (e.kind === 'bad_response' && e.reason === 'no_channels') return 'The NVR did not list any cameras.'
  return MESSAGES[e.kind]
}

export type NvrClientOptions = { timeoutMs?: number; fetchImpl?: typeof fetch }

/** Largest answer read from an NVR. ISAPI answers are a few kilobytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024
/** Largest request body sent to an NVR (search and calendar requests are a few hundred bytes). */
export const MAX_REQUEST_BYTES = 8 * 1024
/** Longest a download (a recording sent by the NVR) may take, from the first request to the last byte. */
export const MAX_DOWNLOAD_MS = 30 * 60_000
/** Most bytes read from one download. */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000
/** Only ISAPI paths made of plain path characters: no space, control character, query, fragment or backslash. */
const SAFE_PATH = /^\/ISAPI\/[A-Za-z0-9._~/-]*$/

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const validHost = (h: string) => h.length > 0 && h.length <= 253 && (isIP(h) !== 0 ? !h.includes('%') : HOSTNAME.test(h))
const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535

/** Reads at most MAX_RESPONSE_BYTES, as a stream, so a hostile or broken NVR cannot make this process buffer without limit. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new NvrError('bad_response', 'answer too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const drop = (res: Response) => res.body?.cancel().catch(() => {})

export class NvrClient {
  // True private fields: logging, JSON or util.inspect of a client never shows the password.
  readonly #ep: NvrEndpoint
  readonly #opts: NvrClientOptions

  constructor(ep: NvrEndpoint, opts: NvrClientOptions = {}) {
    this.#ep = { host: ep.host, port: ep.port, username: ep.username, password: ep.password }
    this.#opts = { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl }
  }

  /** One deadline for a whole operation: every request of it and the reading of every answer. A caller that makes several requests for one operation passes the same signal to each. */
  deadline(): AbortSignal {
    return AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  private async get(path: string, signal: AbortSignal): Promise<string> {
    return this.request('GET', path, undefined, signal)
  }

  /**
   * POSTs one small XML document (at most 8 KB) to an ISAPI path and returns the answer text. Same login (Digest only), same limit on the
   * answer, same errors and same deadline rules as the reads. Pass a signal from `deadline()` to share one deadline between several posts.
   */
  async post(path: string, xml: string, signal: AbortSignal = this.deadline()): Promise<string> {
    return this.request('POST', path, xml, signal)
  }

  /**
   * POSTs one small XML document (at most 8 KB) and returns the answer as a stream of bytes, for a download that is far larger than
   * any ISAPI answer (a recording). Same login (Digest only), same path rule, same body cap and same typed errors as `post`, with these differences:
   *
   *  - Everything that can be an error before the first byte is: a refused login, a status other than 200, a Content-Length above the
   *    limit, or an answer that is text (XML, JSON, HTML: an NVR reports some failures as a 200 with a status document) instead of a recording
   *    all END THE CALL with an NvrError. Only then is the stream handed back.
   *  - There are two deadlines, both on one signal: `timeoutMs` (default 8 s) for the connection, the login and the headers, and then
   *    `maxMs` (default 30 minutes, MAX_DOWNLOAD_MS) for the whole transfer. When either passes, the transfer is cut.
   *  - The bytes are counted: more than `maxBytes` (default 2 GB, MAX_DOWNLOAD_BYTES) cuts the transfer too.
   *  - Once the stream has been handed back there is no way to send an error document: a failure after that point (the NVR resets the
   *    connection, a deadline passes, the byte limit is reached) makes the stream fail with an NvrError when it is read, and the reader
   *    decides what that means for what it has already passed on.
   *  - `signal` is the caller's own cancel (for example "the person closed the page"): it cuts the transfer at once. Cancelling the stream
   *    does the same and releases the connection.
   *
   * Nothing in an error carries the address, the login or the path.
   */
  async postStream(path: string, xml: string, o: { signal?: AbortSignal; maxBytes?: number; maxMs?: number } = {}): Promise<ReadableStream<Uint8Array>> {
    this.check('POST', path, xml)
    const maxBytes = o.maxBytes ?? MAX_DOWNLOAD_BYTES
    const maxMs = o.maxMs ?? MAX_DOWNLOAD_MS
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxMs) || maxMs <= 0) throw new Error('Invalid NVR download limits.')
    const url = this.url(path)

    const stop = new AbortController()
    const state: { why: 'timeout' | 'cancelled' | 'too-large' | null } = { why: null }
    const cut = (reason: NonNullable<typeof state.why>) => {
      state.why ??= reason
      stop.abort()
    }
    const onCaller = () => cut('cancelled')
    const headerTimer = setTimeout(() => cut('timeout'), this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const totalTimer = setTimeout(() => cut('timeout'), maxMs)
    headerTimer.unref?.()
    totalTimer.unref?.()
    const release = () => {
      clearTimeout(headerTimer)
      clearTimeout(totalTimer)
      o.signal?.removeEventListener('abort', onCaller)
    }
    if (o.signal?.aborted) onCaller()
    else o.signal?.addEventListener('abort', onCaller, { once: true })

    let res: Response
    try {
      const ep = this.#ep
      res = await digestFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml, username: ep.username, password: ep.password, signal: stop.signal }, this.#opts.fetchImpl)
      if (res.status !== 200) {
        await drop(res)
        throw this.statusError(res.status)
      }
      const type = res.headers.get('content-type') ?? ''
      const length = Number(res.headers.get('content-length'))
      if (/xml|json|html|^text\//i.test(type)) {
        await drop(res)
        throw new NvrError('bad_response', 'the NVR answered with a document, not a recording')
      }
      if (Number.isFinite(length) && length > maxBytes) {
        await drop(res)
        throw new NvrError('bad_response', 'download too large')
      }
      if (!res.body) throw new NvrError('bad_response', 'empty answer')
    } catch (e) {
      release()
      stop.abort()
      if (state.why === 'cancelled') throw new NvrError('unreachable', 'cancelled')
      throw this.toNvrError(e)
    }
    clearTimeout(headerTimer)

    const reader = res.body.getReader()
    let total = 0
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              release()
              controller.close()
              return
            }
            total += value.byteLength
            if (total > maxBytes) {
              cut('too-large')
              release()
              await reader.cancel().catch(() => {})
              controller.error(new NvrError('bad_response', 'download too large'))
              return
            }
            controller.enqueue(value)
          } catch {
            release()
            stop.abort()
            controller.error(state.why === 'timeout' ? new NvrError('timeout', 'download too slow') : new NvrError('unreachable', 'download interrupted'))
          }
        },
        async cancel() {
          cut('cancelled')
          release()
          await reader.cancel().catch(() => {})
        },
      },
      { highWaterMark: 0 }, // nothing is read from the NVR until the reader asks: the reader's pace is the NVR's pace
    )
  }

  /** Programming mistakes (not NVR trouble): plain errors that never echo the path or the body. */
  private check(method: 'GET' | 'POST', path: string, body: string | undefined) {
    if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('..')) throw new Error('Invalid NVR request path.')
    if (method === 'POST' && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)) throw new Error('Invalid NVR request body.')
  }

  private url(path: string): string {
    const ep = this.#ep
    if (!validHost(ep.host) || !validPort(ep.port)) throw new NvrError('unreachable', 'invalid NVR address')
    const host = isIP(ep.host) === 6 ? `[${ep.host}]` : ep.host
    return `http://${host}:${ep.port}${path}`
  }

  private statusError(status: number): NvrError {
    if (status === 401) return new NvrError('auth', 'login refused')
    if (status === 403) return new NvrError('forbidden', 'not allowed')
    return new NvrError('bad_response', `status ${status}`)
  }

  private toNvrError(e: unknown): NvrError {
    if (e instanceof NvrError) return e
    if (e instanceof DigestUnsupportedError) return new NvrError('bad_response', 'no supported login method offered', 'unsupported_login')
    if (e instanceof DigestInputError) return new NvrError('bad_response', 'login details cannot be used')
    const name = (e as { name?: string }).name
    return new NvrError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', 'request failed')
  }

  private async request(method: 'GET' | 'POST', path: string, body: string | undefined, signal: AbortSignal): Promise<string> {
    this.check(method, path, body)
    const ep = this.#ep
    const url = this.url(path)
    try {
      const res = await digestFetch(
        url,
        { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/xml' }, body, username: ep.username, password: ep.password, signal },
        this.#opts.fetchImpl,
      )
      if (res.status !== 200) {
        await drop(res)
        throw this.statusError(res.status)
      }
      return await readCapped(res)
    } catch (e) {
      throw this.toNvrError(e)
    }
  }

  /** channel -> online, from the NVR's own view of its cameras. */
  async channelStatus(): Promise<Map<number, boolean>> {
    const map = parseChannelStatus(await this.get('/ISAPI/ContentMgmt/InputProxy/channels/status', this.deadline()))
    if (map.size === 0) throw new NvrError('bad_response', 'no channel status in the answer')
    return map
  }

  /** Channel numbers, names and (when the NVR knows them) camera addresses. */
  async channels(): Promise<NvrChannel[]> {
    const signal = this.deadline()
    try {
      const list = parseChannels(await this.get('/ISAPI/ContentMgmt/InputProxy/channels', signal))
      if (list.length > 0) return list
    } catch (e) {
      // Only "this list is not available or not understood" falls back to the older list.
      if (!(e instanceof NvrError) || e.kind !== 'bad_response' || e.reason) throw e
    }
    const older = parseVideoInputChannels(await this.get('/ISAPI/System/Video/inputs/channels', signal))
    if (older.length === 0) throw new NvrError('bad_response', 'no channels in the answer', 'no_channels')
    return older
  }
}
