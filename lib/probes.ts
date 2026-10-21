import childProcess from 'node:child_process'
import net, { isIP } from 'node:net'

export type ProbeResult = { ok: boolean; error?: string }

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
// A name whose last part is all digits or starts with 0x is read by the system as a number ("2130706433", "0x7f.1", "127.1"), not as a name.
const NUMERIC_LAST_LABEL = /(^|\.)(\d+|0x[0-9a-f]*)$/i

/**
 * True for a canonical IP address or a plain host name. Rejects anything that could carry a credential, a path, a port, a line break,
 * a command option (leading "-") or a numeric/hex spelling of an address.
 */
export function isValidHost(h: string): boolean {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false
  if (isIP(h) !== 0) return !h.includes('%')
  return HOSTNAME.test(h) && !NUMERIC_LAST_LABEL.test(h)
}

export const isValidPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535

const clampMs = (ms: number, fallback: number): number => (Number.isFinite(ms) ? Math.min(30_000, Math.max(100, Math.round(ms))) : fallback)

/** Is something listening on this address and port? Never throws. */
export function tcpCheck(host: string, port: number, timeoutMs = 3000): Promise<ProbeResult> {
  if (!isValidHost(host) || !isValidPort(port)) return Promise.resolve({ ok: false, error: 'That address or port is not valid.' })
  return new Promise((resolve) => {
    let done = false
    let socket: net.Socket | undefined
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      socket?.destroy()
      resolve(r)
    }
    try {
      socket = net.connect({ host, port })
    } catch {
      return finish({ ok: false, error: 'The connection failed.' })
    }
    socket.setTimeout(clampMs(timeoutMs, 3000))
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, error: 'No answer in time.' }))
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (e.message.startsWith('Egress guard')) return finish({ ok: false, error: e.message })
      if (e.code === 'ECONNREFUSED') return finish({ ok: false, error: 'The port refused the connection.' })
      if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return finish({ ok: false, error: 'The address cannot be reached.' })
      finish({ ok: false, error: `The connection failed (${/^[A-Z0-9_]+$/.test(e.code ?? '') ? e.code : 'error'}).` })
    })
  })
}

export function buildPingArgs(platform: NodeJS.Platform | string, host: string, timeoutMs: number): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host]
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host]
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]
}

export type IcmpDeps = {
  platform?: NodeJS.Platform | string
  spawn?: (cmd: string, args: string[]) => Pick<childProcess.ChildProcess, 'on' | 'kill'>
}

/**
 * One ping. Only for devices with no port to test. The address must be a literal IP (checked here, before anything is run), so it can
 * never act as a command option. The program is started with an argument list and no shell.
 */
export function icmpCheck(host: string, timeoutMs = 2000, deps: IcmpDeps = {}): Promise<ProbeResult> {
  if (typeof host !== 'string' || host.startsWith('-') || host.includes('%') || isIP(host) === 0) return Promise.resolve({ ok: false, error: 'That is not an IP address.' })
  const wait = clampMs(timeoutMs, 2000)
  const spawn = deps.spawn ?? ((cmd: string, args: string[]) => childProcess.spawn(cmd, args, { stdio: 'ignore', shell: false, windowsHide: true }))
  return new Promise((resolve) => {
    let child: ReturnType<NonNullable<IcmpDeps['spawn']>> | undefined
    let done = false
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        // already gone
      }
      finish({ ok: false, error: 'No reply to the ping.' })
    }, wait + 1000)
    try {
      child = spawn('ping', buildPingArgs(deps.platform ?? process.platform, host, wait))
    } catch {
      return finish({ ok: false, error: 'The ping program is not available on this computer.' })
    }
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, error: e.code === 'ENOENT' ? 'The ping program is not available on this computer.' : 'The ping could not be run.' }),
    )
    child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: 'No reply to the ping.' }))
  })
}
