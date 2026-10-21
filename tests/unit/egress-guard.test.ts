import * as cpNamespace from 'node:child_process'
import cpDefault, { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
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

const listenLoopback = async () => {
  const server = net.createServer((s) => s.end())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const close = () => new Promise<void>((r) => server.close(() => r()))
  return { port, close }
}

describe('egress guard', () => {
  it('refuses a connection to an address outside loopback', async () => {
    expect(await tryConnect('192.0.2.1', 80)).toContain('Egress guard')
    expect(await tryConnect('example.org', 80)).toContain('Egress guard')
    expect(await tryConnect('10.0.0.141', 8000)).toContain('Egress guard')
  })

  it('lets loopback connections through', async () => {
    const { port, close } = await listenLoopback()
    expect(await tryConnect('127.0.0.1', port)).toBe('connected')
    expect(await tryConnect('localhost', port)).toMatch(/connected|ECONNREFUSED/)
    await close()
  })

  it('checks the (port, host) form and does not trust names that only start like loopback', async () => {
    const viaPortHost = (port: number, host: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(port, host)
        s.once('error', (e) => resolve(e.message))
        s.once('connect', () => {
          s.destroy()
          resolve('connected')
        })
      })
    expect(await viaPortHost(80, '10.0.0.1')).toContain('Egress guard')
    expect(await viaPortHost(80, '127.0.0.1.evil.com')).toContain('Egress guard')
    expect(await viaPortHost(80, 'localhost.evil.com')).toContain('Egress guard')
    expect(await tryConnect('127.0.0.1.evil.com', 80)).toContain('Egress guard')
    expect(await tryConnect('localhost.evil.com', 80)).toContain('Egress guard')
    const { port, close } = await listenLoopback()
    expect(await viaPortHost(port, '127.0.0.1')).toBe('connected')
    await close()
  })
})

// Each entry runs `ping <host>` through one child_process entry point. The count flag differs by platform; Windows is -n.
const countFlag = process.platform === 'win32' ? '-n' : '-c'
const quiet = (child: cpNamespace.ChildProcess) => {
  child.on('error', () => {})
  return child
}
const callbacks = () => {}

type Entry = (api: typeof cpNamespace, host: string) => unknown
const entries: Record<string, Entry> = {
  spawn: (api, host) => quiet(api.spawn('ping', [countFlag, '1', host])),
  spawnSync: (api, host) => api.spawnSync('ping', [countFlag, '1', host]),
  execFile: (api, host) => quiet(api.execFile('ping', [countFlag, '1', host], callbacks)),
  execFileSync: (api, host) => api.execFileSync('ping', [countFlag, '1', host], { stdio: 'ignore' }),
  exec: (api, host) => quiet(api.exec(`ping ${countFlag} 1 ${host}`, callbacks)),
  execSync: (api, host) => api.execSync(`ping ${countFlag} 1 ${host}`, { stdio: 'ignore' }),
}

const apis: Record<string, typeof cpNamespace> = {
  'default import': cpDefault as unknown as typeof cpNamespace,
  'named import': { spawn, spawnSync, execFile, execFileSync, exec, execSync } as unknown as typeof cpNamespace,
  'namespace import': cpNamespace,
}

describe('egress guard for ping', () => {
  for (const [apiName, api] of Object.entries(apis)) {
    for (const [name, run] of Object.entries(entries)) {
      it(`${name} via ${apiName} refuses ping to a private address and to a host name`, () => {
        expect(() => run(api, '10.0.0.1')).toThrow(/Egress guard/)
        expect(() => run(api, 'example.org')).toThrow(/Egress guard/)
        expect(() => run(api, '2001:db8::1')).toThrow(/Egress guard/)
      })

      it(`${name} via ${apiName} does not refuse ping to loopback`, () => {
        // Only the guard is under test: the ping itself may succeed or fail.
        try {
          run(api, '127.0.0.1')
        } catch (e) {
          expect(String(e)).not.toMatch(/Egress guard/)
        }
      })
    }
  }

  it('refuses ping hidden behind a shell, a path, a second command or an options object', () => {
    expect(() => spawn('cmd', ['/c', 'ping', '-n', '1', '10.0.0.1'])).toThrow(/Egress guard/)
    expect(() => spawnSync('C:\\Windows\\System32\\PING.EXE', ['192.0.2.5'])).toThrow(/Egress guard/)
    expect(() => spawnSync('/bin/ping', ['192.0.2.5'])).toThrow(/Egress guard/)
    expect(() => execSync('echo hi && ping -n 1 10.0.0.1', { stdio: 'ignore' })).toThrow(/Egress guard/)
    expect(() => spawn('ping 10.0.0.1', { shell: true })).toThrow(/Egress guard/)
    expect(() => spawnSync('tracert', ['10.0.0.1'])).toThrow(/Egress guard/)
  })

  it('leaves other commands alone', () => {
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'])
    expect(out.toString()).toBe('ok')
    expect(spawnSync(process.execPath, ['-e', '0']).status).toBe(0)
    expect(execSync(`"${process.execPath}" -e "process.stdout.write('ok')"`).toString()).toBe('ok')
  })
})
