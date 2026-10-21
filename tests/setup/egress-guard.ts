// Tests must never reach a real network. What this guard covers, and what it does not:
//
// COVERED
//  - Every outgoing TCP/TLS connection that is not to loopback, whatever library opens it (fetch/undici, the Supabase client,
//    raw net/tls sockets): it patches net.Socket.prototype.connect, which all of them go through. The refusal looks like an
//    ordinary connection error ("Egress guard: ...") on the socket.
//  - ping / tracert / pathping / traceroute started through any child_process entry point (spawn, spawnSync, execFile,
//    execFileSync, exec, execSync, with or without a shell), by default import, named import or namespace import
//    (syncBuiltinESMExports makes the named bindings see the wrapped functions). Every non-flag, non-numeric argument is treated
//    as a host and must be loopback; anything unclear is refused (fail closed). The error is thrown synchronously.
//
// NOT COVERED
//  - UDP (node:dgram), direct dns.* lookups, and sockets created with a custom `lookup` function (the host check sees the
//    name given to connect(), not what a custom lookup resolves it to). A custom-lookup bypass is a known gap.
//  - Other programs that reach the network (curl, powershell Test-Connection, ...), and `localhost` resolving to a non-loopback
//    address through an unusual hosts file.
//
// Fakes listen on 127.0.0.1.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { promisify } from 'node:util'

const isLoopback = (host: string) => {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h)
}

function targetHost(rawArgs: unknown[]): string | null {
  // net.connect() and tls.connect() call socket.connect() with one already-normalised array: [options, callback].
  const args = Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs
  const first = args[0]
  if (first && typeof first === 'object') {
    const o = first as { host?: string; path?: string }
    return o.path ? null : (o.host ?? 'localhost')
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null // a unix socket path
  return typeof args[1] === 'string' ? (args[1] as string) : 'localhost'
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args)
  if (host !== null && !isLoopback(host)) {
    const err = new Error(`Egress guard: tests may only connect to loopback addresses (refused ${host})`)
    process.nextTick(() => this.destroy(err)) // looks like an ordinary connection failure to the caller
    return this
  }
  return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args)
} as typeof net.Socket.prototype.connect

// ── ping and friends ─────────────────────────────────────────────────────────
const NETWORK_TOOL = /^(ping|tracert|pathping|traceroute)(\.exe)?$/i

/** Every word of the command line(s), split on whitespace and on shell operators, with quotes removed. */
function words(parts: unknown[]): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') continue
    for (const piece of part.split(/(&&|\|\||[;|&\r\n])/)) {
      if (/^(&&|\|\||[;|&\r\n])$/.test(piece)) out.push(piece)
      else out.push(...piece.split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, '')).filter(Boolean))
    }
  }
  return out
}

function assertNoPingOutsideLoopback(parts: unknown[]) {
  let inTool = false
  for (const w of words(parts)) {
    if (/^(&&|\|\||[;|&\r\n])$/.test(w)) {
      inTool = false
      continue
    }
    const base = w.split(/[\\/]/).pop() ?? w
    if (NETWORK_TOOL.test(base)) {
      inTool = true
      continue
    }
    if (!inTool || w.startsWith('-') || /^\d+$/.test(w)) continue // flags and their numeric values (-n 1, -w 1000)
    if (!isLoopback(w)) throw new Error(`Egress guard: tests may not ping or trace addresses outside loopback (refused ${w})`)
  }
}

const KEY = Symbol.for('cctv.egressGuard')
const cp = childProcess as unknown as Record<string, ((...a: unknown[]) => unknown) & { [KEY]?: true; [promisify.custom]?: (...a: unknown[]) => unknown }>

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[name]
  if (original[KEY]) continue // already wrapped (setup file loaded twice)
  const wrapper = function (this: unknown, ...a: unknown[]) {
    assertNoPingOutsideLoopback(a.filter((x) => typeof x === 'string' || Array.isArray(x)).flat())
    return original.apply(this, a)
  } as typeof original
  wrapper[KEY] = true
  const custom = original[promisify.custom]
  if (custom) {
    wrapper[promisify.custom] = function (this: unknown, ...a: unknown[]) {
      assertNoPingOutsideLoopback(a.filter((x) => typeof x === 'string' || Array.isArray(x)).flat())
      return custom.apply(this, a)
    }
  }
  cp[name] = wrapper
}
// Make `import { spawn } from 'node:child_process'` and `import * as cp ...` see the wrapped functions too.
syncBuiltinESMExports()
