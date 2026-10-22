// Finding ports on this computer that nothing listens on, for the demo targets that must show as offline.
import net from 'node:net'
import { LOOPBACK } from './demo'

/** True only when a connection to the port is refused at once, i.e. nothing is listening. A connection that works, or hangs, is not "closed". */
export function isPortClosed(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: LOOPBACK, port })
    const done = (closed: boolean) => {
      socket.destroy()
      resolve(closed)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED'))
  })
}

/** Asks the system for a free port and gives it back. */
async function freeCandidate(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => resolve((server.address() as net.AddressInfo).port))
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** `count` different ports (1024 or higher, not in `avoid`) that are verified closed. Throws, in plain words, when it cannot find them. */
export async function findClosedPorts(count: number, avoid: ReadonlySet<number> = new Set()): Promise<number[]> {
  const found: number[] = []
  for (let attempt = 0; attempt < 50 && found.length < count; attempt++) {
    const port = await freeCandidate()
    if (port < 1024 || avoid.has(port) || found.includes(port)) continue
    if (await isPortClosed(port)) found.push(port)
  }
  if (found.length < count) throw new Error('Could not find unused ports on this computer for the demo targets that must show as offline.')
  return found
}
