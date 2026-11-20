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
/**
 * `authSent` (final fix X round 2, review M-4): the final answer came after the password was sent (a Digest login). A 401 with authSent
 * false (no Digest offered, or a login value a header cannot carry) refused nobody's password.
 */
export async function rtspDescribe(t: RtspTarget): Promise<{ code: number; trace: string[]; authSent: boolean }> {
  if (!isValidHost(t.host) || !isValidPort(t.port) || !Number.isInteger(t.channel) || t.channel < 1 || t.channel > 4096) {
    return { code: 0, trace: ['The camera address is not valid.'], authSent: false }
  }
  // P2-6 (SO-4): the backstop in front of every socket (lib/security/targets.ts).
  const refused = connectRefusal(t.host)
  if (refused) return { code: 0, trace: [refused], authSent: false }
  const hostInUri = isIP(t.host) === 6 ? `[${t.host}]` : t.host
  const uri = `rtsp://${hostInUri}:${t.port}/Streaming/Channels/${t.channel}02`
  const timeout = t.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : clampMs(t.timeoutMs, DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeout // one deadline for the whole check, both requests together

  // The login answer goes over the SAME connection as the challenge it answers. Real Hikvision NVRs tie the Digest challenge (the nonce)
  // to the TCP connection: an answer sent on a new connection is refused with 401 even when the password is right, which showed up as
  // "Login refused" for every NVR (seen on HO and ABD, 2026-11-20: same login, 200 on the same connection, 401 on a new one). Only when
  // the camera has closed the connection after its challenge (some cameras do) is a new one opened, as before.
  let conn: net.Socket | null = null
  let seq = 0
  const closeConn = () => {
    conn?.destroy()
    conn = null
  }
  const ask = (auth: string | undefined, waitForBody: boolean, allowFresh = true): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return reject(new RtspTimeout())
      const reused = conn !== null && !conn.destroyed && conn.writable && !conn.readableEnded
      const socket = reused ? conn! : net.connect({ host: t.host, port: t.port })
      if (!reused) socket.on('error', () => {}) // between two requests nobody else listens; a failure shows on the next one
      conn = socket
      let buf = Buffer.alloc(0)
      let settled = false
      const finish = (fn: () => void, keep: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('close', onClose)
        socket.off('error', onError)
        if (!keep) {
          socket.destroy()
          if (conn === socket) conn = null
        }
        fn()
      }
      const timer = setTimeout(() => finish(() => reject(new RtspTimeout()), false), remaining)
      const send = () =>
        socket.write(`DESCRIBE ${uri} RTSP/1.0\r\nCSeq: ${++seq}\r\nAccept: application/sdp\r\nUser-Agent: network-hub\r\n${auth ? `Authorization: ${auth}\r\n` : ''}\r\n`)
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        const text = buf.toString('latin1')
        const at = text.indexOf('\r\n\r\n')
        if (at >= 0) {
          const head = text.slice(0, at)
          if (waitForBody) {
            // The challenge may carry a body; it is read (and dropped) so the next answer on this connection starts clean.
            const len = Number(/^Content-Length:[ \t]*(\d{1,6})[ \t]*$/im.exec(head)?.[1] ?? 0)
            if (len > MAX_RTSP_RESPONSE_BYTES) return finish(() => reject(new RtspTooLarge()), false)
            if (buf.length < at + 4 + len) return
          }
          return finish(() => resolve(head), true)
        }
        if (buf.length > MAX_RTSP_RESPONSE_BYTES) finish(() => reject(new RtspTooLarge()), false)
      }
      const onClose = () => {
        // A reused connection the camera had already closed, before any answer: start again on a new one (once).
        if (reused && allowFresh && buf.length === 0) {
          finish(() => ask(auth, waitForBody, false).then(resolve, reject), false)
          return
        }
        finish(() => resolve(buf.toString('latin1')), false)
      }
      const onError = (e: NodeJS.ErrnoException) => {
        if (reused && allowFresh && buf.length === 0) {
          finish(() => ask(auth, waitForBody, false).then(resolve, reject), false)
          return
        }
        finish(() => reject(e), false)
      }
      socket.on('data', onData)
      socket.once('close', onClose)
      socket.on('error', onError)
      if (reused) send()
      else socket.once('connect', send)
    })

  const code = (text: string) => Number(/^RTSP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0)
  const trace: string[] = []
  let authSent = false
  try {
    let text = await ask(undefined, true)
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
          return { code: 401, trace, authSent: false }
        }
        authSent = true
        // One turn of the event loop: a camera that closes the connection right after its challenge has its FIN noticed by now, and the
        // answer goes to a new connection instead of a closing one (it would be sent twice otherwise).
        await new Promise<void>((resolve) => setImmediate(resolve))
        text = await ask(header401, false)
        trace.push('digest: ' + statusLine(text, t.password))
      } else {
        trace.push('The camera does not offer a supported login method.')
      }
    }
    return { code: code(text), trace, authSent }
  } catch (e) {
    if (e instanceof RtspTimeout) trace.push('The camera took too long to answer.')
    else if (e instanceof RtspTooLarge) trace.push('The camera sent an answer that was too large.')
    else if (e instanceof Error && e.message.startsWith('Egress guard')) trace.push(e.message)
    else {
      const c = (e as NodeJS.ErrnoException).code
      trace.push(c === 'ECONNREFUSED' ? 'The camera port refused the connection.' : `The check failed (${typeof c === 'string' && /^[A-Z0-9_]+$/.test(c) ? c : 'error'}).`)
    }
    return { code: 0, trace, authSent }
  } finally {
    closeConn()
  }
}

export async function rtspOk(t: RtspTarget): Promise<boolean> {
  return (await rtspDescribe(t)).code === 200
}
