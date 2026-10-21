// Tests must never reach a real network. This refuses every outgoing connection that is not to loopback, whatever library opens it
// (fetch, the Supabase client, raw sockets) and every ping to a non-loopback address. Fakes listen on 127.0.0.1.
import childProcess from 'node:child_process'
import net from 'node:net'

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)

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

const originalSpawn = childProcess.spawn
childProcess.spawn = function (command: string, ...rest: unknown[]) {
  const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : []
  if (/(^|[\\/])ping(\.exe)?$/i.test(command) && args.some((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) && !isLoopback(a))) {
    throw new Error('Egress guard: tests may not ping addresses outside loopback')
  }
  return (originalSpawn as (...a: unknown[]) => childProcess.ChildProcess)(command, ...rest)
} as typeof childProcess.spawn
