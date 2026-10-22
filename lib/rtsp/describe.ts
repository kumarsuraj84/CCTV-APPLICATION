import net, { isIP } from 'node:net'
import { buildDigestHeader, DigestInputError, parseDigestChallenge } from '@/lib/nvr/digest'
import { clampMs, isValidHost, isValidPort } from '@/lib/probes'
import { connectRefusal } from '@/lib/security/targets'

export type RtspTarget = { host: string; port: number; username: string; password: string; channel: number; timeoutMs?: number }

/** Largest answer read from a camera. An RTSP answer's status line and headers are a few hundred bytes. */
export const MAX_RTSP_RESPONSE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5000

class RtspTimeout extends Error {}
class RtspTooLarge extends Error {}

/**
 * The status line of an answer, safe to keep: only a plain RTSP status line, no control characters. The protocol token and the
 * three-digit code are kept exactly as they are; if the password appears in the reason phrase it is replaced by "***".
 */
function statusLine(text: string, password: string): string {
  const first = text.split('\r\n')[0]
  const m = /^(RTSP\/1\.\d \d{3})(?: ([\x20-\x7e]{0,80}))?$/.exec(first)
  if (!m) return text.length === 0 ? 'The camera sent no answer.' : 'The camera sent an answer this app does not understand.'
  const reason = m[2] === undefined ? '' : password ? m[2].split(password).join('***') : m[2]
  return reason ? `${m[1]} ${reason}` : m[1]
}

/**
 * One DESCRIBE on the camera's sub-stream (Hikvision: channel*100 + 2). Returns the final status code (0 = no answer) and what happened.
 * The login is Digest only: the password is never sent in clear. The password is never written into the URL, the trace or an error.
 */
export async function rtspDescribe(t: RtspTarget): Promise<{ code: number; trace: string[] }> {
  if (!isValidHost(t.host) || !isValidPort(t.port) || !Number.isInteger(t.channel) || t.channel < 1 || t.channel > 4096) {
    return { code: 0, trace: ['The camera address is not valid.'] }
  }
  // P2-6 (SO-4): the backstop in front of every socket (lib/security/targets.ts).
  const refused = connectRefusal(t.host)
  if (refused) return { code: 0, trace: [refused] }
  const hostInUri = isIP(t.host) === 6 ? `[${t.host}]` : t.host
  const uri = `rtsp://${hostInUri}:${t.port}/Streaming/Channels/${t.channel}02`
  const timeout = t.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampMs(t.timeoutMs, DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeout // one deadline for the whole check, both requests together

  const ask = (auth?: string) =>
    new Promise<string>((resolve, reject) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return reject(new RtspTimeout())
      const socket = net.connect({ host: t.host, port: t.port })
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const end = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        fn()
      }
      const timer = setTimeout(() => end(() => reject(new RtspTimeout())), remaining)
      socket.once('connect', () =>
        socket.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: network-hub\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`),
      )
      socket.on('data', (d: Buffer) => {
        chunks.push(d)
        size += d.length
        const text = Buffer.concat(chunks).toString('latin1')
        if (text.includes('\r\n\r\n')) return end(() => resolve(text.slice(0, text.indexOf('\r\n\r\n'))))
        if (size > MAX_RTSP_RESPONSE_BYTES) end(() => reject(new RtspTooLarge()))
      })
      socket.once('close', () => end(() => resolve(Buffer.concat(chunks).toString('latin1'))))
      socket.on('error', (e: NodeJS.ErrnoException) => end(() => reject(e)))
    })

  const code = (text: string) => Number(/^RTSP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0)
  const trace: string[] = []
  try {
    let text = await ask()
    trace.push(statusLine(text, t.password))
    if (code(text) === 401) {
      // All WWW-Authenticate lines, so a Digest offer is found even when Basic is listed first. Basic is never answered.
      const header = [...text.matchAll(/^WWW-Authenticate:[ \t]*(.*)$/gim)].map((m) => m[1]).join(', ')
      const challenge = parseDigestChallenge(header)
      if (challenge) {
        let header401: string
        try {
          header401 = buildDigestHeader(challenge, { username: t.username, password: t.password, method: 'DESCRIBE', uri })
        } catch (e) {
          if (!(e instanceof DigestInputError)) throw e
          trace.push('The login details cannot be used.')
          return { code: 401, trace }
        }
        text = await ask(header401)
        trace.push('digest: ' + statusLine(text, t.password))
      } else {
        trace.push('The camera does not offer a supported login method.')
      }
    }
    return { code: code(text), trace }
  } catch (e) {
    if (e instanceof RtspTimeout) trace.push('The camera took too long to answer.')
    else if (e instanceof RtspTooLarge) trace.push('The camera sent an answer that was too large.')
    else if (e instanceof Error && e.message.startsWith('Egress guard')) trace.push(e.message)
    else {
      const c = (e as NodeJS.ErrnoException).code
      trace.push(c === 'ECONNREFUSED' ? 'The camera port refused the connection.' : `The check failed (${typeof c === 'string' && /^[A-Z0-9_]+$/.test(c) ? c : 'error'}).`)
    }
    return { code: 0, trace }
  }
}

export async function rtspOk(t: RtspTarget): Promise<boolean> {
  return (await rtspDescribe(t)).code === 200
}
