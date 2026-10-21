import net from 'node:net'
import { describe, expect, it } from 'vitest'

const tryConnect = (host: string, port: number) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ host, port })
    s.once('error', (e) => resolve(e.message))
    s.once('connect', () => {
      s.destroy()
      resolve('connected')
    })
  })

describe('egress guard', () => {
  it('refuses a connection to an address outside loopback', async () => {
    expect(await tryConnect('192.0.2.1', 80)).toContain('Egress guard')
    expect(await tryConnect('example.org', 80)).toContain('Egress guard')
    expect(await tryConnect('10.0.0.141', 8000)).toContain('Egress guard')
  })

  it('lets loopback connections through', async () => {
    const server = net.createServer((s) => s.end())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    expect(await tryConnect('127.0.0.1', port)).toBe('connected')
    expect(await tryConnect('localhost', port)).toMatch(/connected|ECONNREFUSED/)
    server.close()
  })
})
