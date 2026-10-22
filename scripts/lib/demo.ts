// Shared by the two demo scripts (scripts/fake-nvr.ts and scripts/seed-demo.ts). Pure code, so it can be tested.
//
// Everything the demo connects to is on this computer: every address below is 127.0.0.1. A real store address must never appear here.
import { randomBytes } from 'node:crypto'

export const LOOPBACK = '127.0.0.1'

/** The one organisation the seed creates, found again by this slug. Reset deletes this organisation and nothing else. */
export const DEMO_SLUG = 'demo-sample-data'
export const DEMO_ORG_NAME = 'DEMO organisation (sample data)'

export const DEFAULT_NVR_PORT = 8081
export const FAKE_RTSP_PORT = 8554
export const FAKE_ERP_PORT = 9101
export const FAKE_ATTENDANCE_PORT = 9102
export const FAKE_ATTENDANCE_2_PORT = 9103

/** Ports the demo points at where nothing listens, so that those targets show as offline. */
export const DEAD_NVR_HTTP_PORT = 8082
export const DEAD_NVR_RTSP_PORT = 8555
export const DEAD_DEVICE_PORT = 9199

/** The login of the pretend NVR. It protects nothing: the fake only listens on this computer. */
export const DEMO_NVR_USER = 'viewer'
export const DEMO_NVR_PASSWORD = 'demo-pass'

const RESERVED_PORTS = new Set([FAKE_RTSP_PORT, FAKE_ERP_PORT, FAKE_ATTENDANCE_PORT, FAKE_ATTENDANCE_2_PORT, DEAD_NVR_HTTP_PORT, DEAD_NVR_RTSP_PORT, DEAD_DEVICE_PORT])

/** A port for the pretend NVR: a whole number from 1024 to 65535 that the demo does not use for anything else. */
export function parseNvrPort(value: string | number): number {
  const n = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('The port must be a whole number from 1024 to 65535.')
  if (RESERVED_PORTS.has(n)) throw new Error(`Port ${n} is used by another part of the demo. Choose a different one.`)
  return n
}

const ADDRESS_OPTIONS = /^--(host|hostname|bind|listen|address|interface|ip)\b/i

/**
 * The options of `npm run fake:nvr`: `--flip` and `--port=NNNN` (or `--port NNNN`, or FAKE_NVR_PORT). Nothing else is accepted. There is
 * deliberately no way to choose an address: the fake servers listen on 127.0.0.1 only, so only this computer can reach them.
 */
export function parseFakeNvrArgs(argv: string[], env: Record<string, string | undefined> = {}): { port: number; flip: boolean } {
  let port: number = env.FAKE_NVR_PORT ? parseNvrPort(env.FAKE_NVR_PORT) : DEFAULT_NVR_PORT
  let flip = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--flip') flip = true
    else if (a.startsWith('--port=')) port = parseNvrPort(a.slice('--port='.length))
    else if (a === '--port') port = parseNvrPort(argv[++i] ?? '')
    else if (ADDRESS_OPTIONS.test(a)) throw new Error('The pretend NVR only listens on 127.0.0.1 (this computer). It cannot be given another address.')
    else throw new Error(`Unknown option "${a}". Use --flip and --port=NNNN only.`)
  }
  return { port, flip }
}

export type DemoStorePlan = {
  code: string
  name: string
  city: string
  zone: string
  httpPort: number
  rtspPort: number
  cameras: number
  /** Which people (by role) may see this store; managers and administrators see everything anyway. */
  viewers: ('user' | 'agent')[]
}
export type DemoDevicePlan = { type: 'server' | 'attendance' | 'footfall'; name: string; storeCode: string | null; port: number }

/** The sample stores and devices. Every address is 127.0.0.1; names say DEMO so that they are never mistaken for real ones. */
export function demoPlan(nvrPort: number = DEFAULT_NVR_PORT): { stores: DemoStorePlan[]; devices: DemoDevicePlan[] } {
  const nvr = parseNvrPort(nvrPort)
  return {
    stores: [
      { code: 'DEMO1', name: 'Demo Store Patna', city: 'Patna', zone: 'BR', httpPort: nvr, rtspPort: FAKE_RTSP_PORT, cameras: 6, viewers: ['user', 'agent'] },
      // Nothing listens on these two ports: the NVR is down.
      { code: 'DEMO2', name: 'Demo Store Ranchi', city: 'Ranchi', zone: 'Jharkhand', httpPort: DEAD_NVR_HTTP_PORT, rtspPort: DEAD_NVR_RTSP_PORT, cameras: 4, viewers: ['user', 'agent'] },
      { code: 'DEMO3', name: 'Demo Store Gaya', city: 'Gaya', zone: 'BR', httpPort: nvr, rtspPort: FAKE_RTSP_PORT, cameras: 4, viewers: ['agent'] },
    ],
    devices: [
      { type: 'server', name: 'Demo ERP server', storeCode: null, port: FAKE_ERP_PORT },
      { type: 'attendance', name: 'Demo attendance machine', storeCode: 'DEMO1', port: FAKE_ATTENDANCE_PORT },
      { type: 'footfall', name: 'Demo footfall counter', storeCode: 'DEMO1', port: DEAD_DEVICE_PORT }, // nothing listens: offline
      { type: 'attendance', name: 'Demo attendance Gaya', storeCode: 'DEMO3', port: FAKE_ATTENDANCE_2_PORT },
    ],
  }
}

/** A random password that satisfies the app's rule (10 or more characters, with a letter and a number). Shown once, never stored by the script. */
export function makePassword(): string {
  for (;;) {
    const p = randomBytes(15).toString('base64url') // 20 characters
    if (/[A-Za-z]/.test(p) && /[0-9]/.test(p)) return p
  }
}

export const DEMO_ROLES = ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const
export const DEMO_ROLE_LABELS: Record<(typeof DEMO_ROLES)[number], string> = {
  user: 'Viewer',
  agent: 'Operator',
  manager: 'Manager',
  admin: 'Administrator',
  platform_owner: 'Platform owner',
}
export const demoEmail = (role: (typeof DEMO_ROLES)[number]) => `demo.${role.replace('_', '-')}@demo.example.test`

/** Reset deletes an organisation only when it is the demo one: the exact slug and a name that says DEMO. */
export const isDemoOrg = (o: { slug: string; name: string }): boolean => o.slug === DEMO_SLUG && o.name.startsWith('DEMO')
