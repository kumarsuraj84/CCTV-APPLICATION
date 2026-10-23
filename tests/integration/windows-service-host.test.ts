// P5.4 brief item 1: the Windows service host (deploy/windows/service-host/DrishtiServiceHost.cs) — what sc.exe registers for each
// Drishti service — compiled with the .NET Framework's own C# compiler (no download, no install) and run in its console mode with a
// stand-in program (tests/helpers/fake-service-program.mjs; no network). Nothing is installed: no service, account or registry entry.
// Proves: settings from the env file reach the program (values never logged), a clean stop by Ctrl+C, a restart after a crash, log
// rolling, and the forced end of a program that ignores the stop, together with what it started.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const FAKE = path.join(ROOT, 'tests', 'helpers', 'fake-service-program.mjs')
const windows = process.platform === 'win32' && existsSync(CSC)
const SETTING = 'p54-a-setting-that-must-never-be-logged-0123456789'

let dir = ''
let exe = ''
beforeAll(() => {
  if (!windows) return
  dir = mkdtempSync(path.join(os.tmpdir(), 'drishti-host-'))
  exe = path.join(dir, 'DrishtiServiceHost.exe')
  execFileSync(CSC, ['/nologo', '/target:exe', '/optimize+', `/out:${exe}`, '/reference:System.ServiceProcess.dll', path.join(ROOT, 'deploy', 'windows', 'service-host', 'DrishtiServiceHost.cs')], { stdio: 'pipe' })
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Starts the host in console mode for one stand-in program; stop() asks it to stop and resolves with its exit code. */
function host(name: string, fakeArgs: string[], o: { maxBytes?: number; keep?: number; stopTimeoutSec?: number } = {}) {
  const logdir = path.join(dir, name)
  const env = path.join(dir, `${name}.env`)
  writeFileSync(env, `# test\r\nDRISHTI_TEST_SETTING="${SETTING}"\r\n`)
  const conf = path.join(dir, `${name}.conf`)
  writeFileSync(conf, [
    `name=${name}`, `exe=${process.execPath}`, `arg=${FAKE}`, ...fakeArgs.map((a) => `arg=${a}`), `workdir=${dir}`, `envfile=${env}`, `logdir=${logdir}`,
    `logmaxbytes=${o.maxBytes ?? 1048576}`, `logkeep=${o.keep ?? 3}`, `stoptimeoutsec=${o.stopTimeoutSec ?? 10}`, 'restartdelaysec=1', 'restartmaxdelaysec=2',
  ].join('\r\n'))
  const child = spawn(exe, ['--console', conf], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
  const logText = () => readdirSync(logdir).filter((f) => f.endsWith('.log')).sort().map((f) => readFileSync(path.join(logdir, f), 'utf8')).join('\n')
  return {
    logdir,
    logText,
    async waitFor(text: string, ms = 15_000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (existsSync(logdir) && logText().includes(text)) return
        await sleep(100)
      }
      throw new Error(`"${text}" did not appear in the log of ${name}: ${existsSync(logdir) ? logText().slice(-2000) : 'no log folder'}`)
    },
    async stop(): Promise<number | null> {
      writeFileSync(path.join(logdir, 'stop.request'), '')
      return Promise.race([exited, sleep(30_000).then(() => {
        child.kill()
        return -1
      })])
    },
  }
}

describe.skipIf(!windows)('Windows service host (P5.4, console mode, nothing installed)', () => {
  it('passes the env file to the program without logging a value, and stops it cleanly with Ctrl+C', async () => {
    const h = host('clean', [])
    await h.waitFor('fake_started')
    expect(h.logText()).toContain('"settingPresent":true')
    expect(h.logText()).toContain(`"settingLength":${SETTING.length}`)
    expect(await h.stop()).toBe(0)
    const text = h.logText()
    expect(text).toContain('fake_stopped_cleanly')
    expect(text).toContain('Ctrl+C sent')
    expect(text).not.toContain(SETTING)
  }, 40_000)

  it('starts the program again when it ends by itself', async () => {
    const h = host('crash', ['--crash-after-ms', '300'])
    await h.waitFor('ended by itself (exit code 3)')
    await sleep(2500)
    expect(h.logText().match(/fake_started/g)!.length).toBeGreaterThanOrEqual(2)
    await h.stop()
  }, 40_000)

  it('rolls its log by size and keeps only the configured number of files', async () => {
    const h = host('roll', ['--spam', '2500'], { maxBytes: 65536, keep: 3 })
    await h.waitFor('"n":2499')
    await h.stop()
    const files = readdirSync(h.logdir).filter((f) => f.endsWith('.log')).sort()
    expect(files).toEqual(['roll.1.log', 'roll.2.log', 'roll.log'])
    for (const f of files) expect(statSync(path.join(h.logdir, f)).size).toBeLessThan(65536 + 4096)
  }, 40_000)

  it('ends a program that ignores the stop after its timeout, together with what it started', async () => {
    const pidFile = path.join(dir, 'grandchild.pid')
    const h = host('stubborn', ['--ignore-sigint', '--grandchild', pidFile], { stopTimeoutSec: 2 })
    await h.waitFor('fake_started')
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100)
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(grandchild)).toBe(true)
    expect(await h.stop()).toBe(1)
    expect(h.logText()).toContain('fake_ignored_sigint')
    expect(h.logText()).toContain('did not stop in time')
    await sleep(500)
    expect(alive(grandchild)).toBe(false)
  }, 40_000)
})
