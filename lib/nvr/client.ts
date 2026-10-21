import { isIP } from 'node:net'
import { DigestInputError, DigestUnsupportedError, digestFetch } from '@/lib/nvr/digest'
import { parseChannels, parseChannelStatus, parseVideoInputChannels, type NvrChannel } from '@/lib/nvr/isapi'

export type NvrEndpoint = { host: string; port: number; username: string; password: string }
export type NvrErrorKind = 'unreachable' | 'timeout' | 'auth' | 'forbidden' | 'bad_response'
/** Extra detail for a bad_response: the NVR only offers login methods this app refuses to use (such as Basic). */
export type NvrErrorReason = 'unsupported_login'

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
  return MESSAGES[e.kind]
}

export type NvrClientOptions = { timeoutMs?: number; fetchImpl?: typeof fetch }

/** Largest answer read from an NVR. ISAPI answers are a few kilobytes. */
export const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 8000

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

  /** One deadline for a whole operation: every request of it and the reading of every answer. */
  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  private async get(path: string, signal: AbortSignal): Promise<string> {
    const ep = this.#ep
    if (!validHost(ep.host) || !validPort(ep.port)) throw new NvrError('unreachable', 'invalid NVR address')
    const host = isIP(ep.host) === 6 ? `[${ep.host}]` : ep.host
    try {
      const res = await digestFetch(`http://${host}:${ep.port}${path}`, { username: ep.username, password: ep.password, signal }, this.#opts.fetchImpl)
      if (res.status !== 200) {
        await drop(res)
        if (res.status === 401) throw new NvrError('auth', 'login refused')
        if (res.status === 403) throw new NvrError('forbidden', 'not allowed')
        throw new NvrError('bad_response', `status ${res.status}`)
      }
      return await readCapped(res)
    } catch (e) {
      if (e instanceof NvrError) throw e
      if (e instanceof DigestUnsupportedError) throw new NvrError('bad_response', 'no supported login method offered', 'unsupported_login')
      if (e instanceof DigestInputError) throw new NvrError('bad_response', 'login details cannot be used')
      const name = (e as { name?: string }).name
      throw new NvrError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', 'request failed')
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
    if (older.length === 0) throw new NvrError('bad_response', 'no channels in the answer')
    return older
  }
}
