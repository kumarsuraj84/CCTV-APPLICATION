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

async function main() {
  // The fake servers report a busy port as an error event; say it in plain words instead of a stack trace.
  process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? 'A port is already in use: is the pretend NVR already running? Stop it first, or choose another NVR port with --port=NNNN.' : String(e.message))
    process.exit(1)
  })
  let options
  try {
    options = parseFakeNvrArgs(process.argv.slice(2), process.env)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
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
  const rtsp = await startFakeRtsp('refuse', FAKE_RTSP_PORT)
  const erp = await startFakeTcp(FAKE_ERP_PORT)
  const attendance = await startFakeTcp(FAKE_ATTENDANCE_PORT)
  const attendance2 = await startFakeTcp(FAKE_ATTENDANCE_2_PORT)
  console.log(
    `Pretend NVR on ${LOOPBACK}:${nvr.port} (user ${DEMO_NVR_USER}), camera port ${rtsp.port}, devices on ${erp.port}, ${attendance.port} and ${attendance2.port}. Only this computer can reach them.`,
  )
  console.log('Camera 3 is offline. Press Ctrl+C to stop.')
  let timer: NodeJS.Timeout | undefined
  if (flip) {
    timer = setInterval(() => {
      statuses[5] = !statuses[5]
      nvr.setStatuses({ ...statuses })
      console.log(`Camera 5 is now ${statuses[5] ? 'online' : 'offline'}.`)
    }, 90_000)
  }
  let stopping = false
  const stop = async () => {
    if (stopping) process.exit(130)
    stopping = true
    clearInterval(timer)
    await Promise.all([nvr.close(), rtsp.close(), erp.close(), attendance.close(), attendance2.close()])
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => void stop())
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
