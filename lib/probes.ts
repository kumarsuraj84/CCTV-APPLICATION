import childProcess from 'node:child_process'
import net, { isIP } from 'node:net'
import path from 'node:path'

export type ProbeResult = { ok: boolean; error?: string }

// Letters, digits, "-" and "_" inside a label; one optional trailing dot (a fully written name).
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)*\.?$/
// A name whose last part is all digits or starts with 0x is read by the system as a number ("2130706433", "0x7f.1", "127.1"), not as a name.
const NUMERIC_LAST_LABEL = /(^|\.)(\d+|0x[0-9a-f]*)$/i

/**
 * True for a canonical IP address or a plain host name. Rejects anything that could carry a credential, a path, a port, a line break,
 * a command option (leading "-") or a numeric/hex spelling of an address.
 */
export function isValidHost(h: string): boolean {
  if (typeof h !== 'string' || h.length === 0 || h.length > 253) return false
  if (isIP(h) !== 0) return !h.includes('%')
  return HOSTNAME.test(h) && !NUMERIC_LAST_LABEL.test(h.replace(/\.$/, ''))
}

export const isValidPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535

export const clampMs = (ms: number, fallback: number): number => (Number.isFinite(ms) ? Math.min(30_000, Math.max(100, Math.round(ms))) : fallback)

/** Plain wording for a failed connection. Never includes a raw error code or system text. */
export function describeTcpError(e: { code?: string; message?: string }): string {
  if (typeof e.message === 'string' && e.message.startsWith('Egress guard')) return e.message // test-only wording: names the address, nothing else
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'The port refused the connection.'
    case 'ETIMEDOUT':
      return 'No answer in time.'
    case 'ENOTFOUND':
      return 'That name cannot be found.'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'The address cannot be reached.'
    case 'ECONNRESET':
      return 'The connection was reset.'
    default:
      return 'The connection failed.'
  }
}

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
    socket.on('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: describeTcpError(e) }))
  })
}

export function buildPingArgs(platform: NodeJS.Platform | string, host: string, timeoutMs: number): string[] {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host]
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host]
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]
}

/** What a spawned ping must offer: exit and error events, a way to stop it, and (to see the reply) its output. */
export type PingChild = Pick<childProcess.ChildProcess, 'on' | 'kill'> & {
  stdout?: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown } | null
}
export type IcmpDeps = {
  platform?: NodeJS.Platform | string
  spawn?: (cmd: string, args: string[]) => PingChild
}

/** Largest part of the ping program's output that is kept. A real reply is a few hundred bytes. */
export const MAX_PING_OUTPUT = 4096

/** The program to start: on Windows the system's own ping.exe by full path, so a look-alike earlier on the search path is never run. */
export function pingCommand(platform: NodeJS.Platform | string, env: Record<string, string | undefined> = process.env): string {
  if (platform !== 'win32') return 'ping'
  return path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')
}

const defaultSpawn = (cmd: string, args: string[]): PingChild => childProcess.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true })

/**
 * One ping. Only for devices with no port to test. The address must be a literal IP (checked here, before anything is run), so it can
 * never act as a command option. The program is started with an argument list and no shell.
 * A reply counts only when the program exits with 0 AND its output shows a real echo reply (a "TTL=" or "ttl=" field): Windows ping
 * exits with 0 when a router answers "Destination host unreachable", which must not make a down device look live.
 */
export function icmpCheck(host: string, timeoutMs = 2000, deps: IcmpDeps = {}): Promise<ProbeResult> {
  if (typeof host !== 'string' || host.startsWith('-') || host.includes('%') || isIP(host) === 0) return Promise.resolve({ ok: false, error: 'That is not an IP address.' })
  const wait = clampMs(timeoutMs, 2000)
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? defaultSpawn
  return new Promise((resolve) => {
    let child: PingChild | undefined
    let done = false
    let output = ''
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
      child = spawn(pingCommand(platform), buildPingArgs(platform, host, wait))
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Egress guard')) return finish({ ok: false, error: e.message })
      return finish({ ok: false, error: 'The ping program is not available on this computer.' })
    }
    // Keep reading after the cap so the program never blocks on a full pipe; only the first part is kept.
    child.stdout?.on('data', (chunk) => {
      if (output.length < MAX_PING_OUTPUT) output += chunk.toString().slice(0, MAX_PING_OUTPUT - output.length)
    })
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, error: e.code === 'ENOENT' ? 'The ping program is not available on this computer.' : 'The ping could not be run.' }),
    )
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: 'No reply to the ping.' })
      finish(/ttl[=:]/i.test(output) ? { ok: true } : { ok: false, error: 'The device did not answer the ping.' })
    })
  })
}
