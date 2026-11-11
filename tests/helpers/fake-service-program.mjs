// A stand-in for a Drishti program under the Windows service host (tests/windows-lab/windows-service-host.lab.test.ts). It never
// touches the network. Behaviour from its arguments:
//   --crash-after-ms N   exit with code 3 after N ms (the host must start it again)
//   --spam N             write N lines of ~200 characters at once (the host's log must roll)
//   --spam-every-ms N    write a line of ~450 characters every N ms
//   --grandchild FILE    start a node grandchild that writes its pid to FILE and sleeps (the host must end it with the stop)
//   --ignore-sigint      do not stop on Ctrl+C (the host must end it after its stop timeout)
// It always reports whether DRISHTI_TEST_SETTING came from the env file (never its value) and stops cleanly on Ctrl+C (SIGINT).
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const val = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const log = (o) => console.log(JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...o }))

log({ event: 'fake_started', settingPresent: typeof process.env.DRISHTI_TEST_SETTING === 'string', settingLength: (process.env.DRISHTI_TEST_SETTING ?? '').length })
const spam = Number(val('--spam') ?? 0)
for (let i = 0; i < spam; i++) log({ event: 'fake_spam', n: i, filler: 'x'.repeat(160) })
// --spam-every-ms N: a line every N ms for as long as it runs (the host's log keeps reaching its size limit).
const every = Number(val('--spam-every-ms') ?? 0)
let tick = 0
if (every > 0) setInterval(() => log({ event: 'fake_tick', n: tick++, filler: 'y'.repeat(400) }), every)
const grandchildFile = val('--grandchild')
if (grandchildFile) {
  const g = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  g.unref()
  writeFileSync(`${grandchildFile}.parent`, String(process.pid))
}
const crash = Number(val('--crash-after-ms') ?? 0)
if (crash > 0) setTimeout(() => {
  log({ event: 'fake_crashing' })
  process.exit(3)
}, crash)
if (!args.includes('--ignore-sigint')) {
  process.on('SIGINT', () => {
    log({ event: 'fake_stopped_cleanly' })
    process.exit(0)
  })
} else process.on('SIGINT', () => log({ event: 'fake_ignored_sigint' }))
setInterval(() => {}, 1000)
