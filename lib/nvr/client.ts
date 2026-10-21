import { isIP } from 'node:net'
import { digestFetch } from '@/lib/nvr/digest'
import { parseChannels, parseChannelStatus, parseVideoInputChannels, type NvrChannel } from '@/lib/nvr/isapi'

export type NvrEndpoint = { host: string; port: number; username: string; password: string }
export type NvrErrorKind = 'unreachable' | 'timeout' | 'auth' | 'forbidden' | 'bad_response'

export class NvrError extends Error {
  constructor(public kind: NvrErrorKind, message: string) {
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
  return e instanceof NvrError ? MESSAGES[e.kind] : 'The NVR check failed.'
}

export type NvrClientOptions = { timeoutMs?: number; fetchImpl?: typeof fetch }

export class NvrClient {
  constructor(private ep: NvrEndpoint, private opts: NvrClientOptions = {}) {}

  private async get(path: string): Promise<string> {
    const host = isIP(this.ep.host) === 6 ? `[${this.ep.host}]` : this.ep.host
    let res: Response
    try {
      res = await digestFetch(`http://${host}:${this.ep.port}${path}`, { username: this.ep.username, password: this.ep.password, timeoutMs: this.opts.timeoutMs }, this.opts.fetchImpl)
    } catch (e) {
      const name = (e as { name?: string }).name
      throw new NvrError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', 'request failed')
    }
    if (res.status === 401) throw new NvrError('auth', 'login refused')
    if (res.status === 403) throw new NvrError('forbidden', 'not allowed')
    if (res.status !== 200) throw new NvrError('bad_response', `status ${res.status}`)
    return res.text()
  }

  /** channel -> online, from the NVR's own view of its cameras. */
  async channelStatus(): Promise<Map<number, boolean>> {
    const map = parseChannelStatus(await this.get('/ISAPI/ContentMgmt/InputProxy/channels/status'))
    if (map.size === 0) throw new NvrError('bad_response', 'no channel status in the answer')
    return map
  }

  /** Channel numbers, names and (when the NVR knows them) camera addresses. */
  async channels(): Promise<NvrChannel[]> {
    try {
      const list = parseChannels(await this.get('/ISAPI/ContentMgmt/InputProxy/channels'))
      if (list.length > 0) return list
    } catch (e) {
      if (!(e instanceof NvrError) || e.kind !== 'bad_response') throw e
    }
    return parseVideoInputChannels(await this.get('/ISAPI/System/Video/inputs/channels'))
  }
}
