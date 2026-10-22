// A pretend NVR, camera port and devices on this computer only (127.0.0.1), so the whole app can be shown without any hardware.
// Run: npm run fake:nvr                 (add --flip to make camera 5 go off and on every 90 seconds, --port=NNNN to choose the NVR port)
// There is no option to listen on another address: the servers in tests/helpers/fake-servers.ts bind 127.0.0.1 and nothing else.
import { startFakeNvr, startFakeRtsp, startFakeTcp } from '../tests/helpers/fake-servers'
import {
  DEMO_NVR_PASSWORD,
  DEMO_NVR_USER,
  FAKE_ATTENDANCE_2_PORT,
  FAKE_ATTENDANCE_PORT,
  FAKE_ERP_PORT,
  FAKE_RTSP_PORT,
  LOOPBACK,
  parseFakeNvrArgs,
} from './lib/demo'

const NAMES = ['Entrance', 'Billing counter', 'Stockroom', 'Back door', 'Parking', 'Trial room']

/** Whatever is listening right now, so that it can be closed again on a stop or on a failure. */
const running: { close: () => Promise<void> }[] = []
let flipTimer: NodeJS.Timeout | undefined

async function closeAll(): Promise<void> {
  clearInterval(flipTimer)
  const open = running.splice(0)
  await Promise.allSettled(open.map((s) => s.close()))
}

async function main() {
  // The fake servers report a busy port as an error event. Say it in plain words, show the details, close what is open and end by itself:
  // with nothing left listening the process finishes with the exit code set below (no process.exit, which can crash node on Windows).
  process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error('A port is already in use: is the pretend NVR already running? Stop it first, or choose another NVR port with --port=NNNN.')
    console.error(e.stack ?? String(e))
    process.exitCode = 1
    void closeAll()
  })

  let options
  try {
    options = parseFakeNvrArgs(process.argv.slice(2), process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
    return
  }
  const { port, flip } = options
  // Documentation addresses (192.0.2.x): the NVR reports them as camera addresses, and nothing ever connects to them.
  const statuses: Record<number, boolean> = { 1: true, 2: true, 3: false, 4: true, 5: true, 6: true }
  const nvr = await startFakeNvr({
    port,
    username: DEMO_NVR_USER,
    password: DEMO_NVR_PASSWORD,
    statuses,
    channels: NAMES.map((name, i) => ({ channel: i + 1, name, ip: `192.0.2.${11 + i}` })),
  })
  running.push(nvr)
  const rtsp = await startFakeRtsp('refuse', FAKE_RTSP_PORT)
  running.push(rtsp)
  const erp = await startFakeTcp(FAKE_ERP_PORT)
  running.push(erp)
  const attendance = await startFakeTcp(FAKE_ATTENDANCE_PORT)
  running.push(attendance)
  const attendance2 = await startFakeTcp(FAKE_ATTENDANCE_2_PORT)
  running.push(attendance2)
  console.log(
    `Pretend NVR on ${nvr.host}:${nvr.port} (user ${DEMO_NVR_USER}), camera port ${rtsp.port}, devices on ${erp.port}, ${attendance.port} and ${attendance2.port}. Only this computer (${LOOPBACK}) can reach them.`,
  )
  console.log('Camera 3 is offline. Press Ctrl+C to stop.')
  if (flip) {
    flipTimer = setInterval(() => {
      statuses[5] = !statuses[5]
      nvr.setStatuses({ ...statuses })
      console.log(`Camera 5 is now ${statuses[5] ? 'online' : 'offline'}.`)
    }, 90_000)
  }
  let stopping = false
  const stop = () => {
    if (stopping) process.exit(130) // a second Ctrl+C: leave at once
    stopping = true
    void closeAll()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop)
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exitCode = 1
  void closeAll()
})
