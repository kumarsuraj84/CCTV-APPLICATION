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

/**
 * Ports the demo points at where nothing listens, so that those targets show as offline. These are only the defaults; the seed checks
 * that nothing listens and uses other, verified free ports (scripts/lib/ports.ts) for the rows it writes.
 */
export const DEAD_NVR_HTTP_PORT = 8082
export const DEAD_NVR_RTSP_PORT = 8555
export const DEAD_DEVICE_PORT = 9199
export type DeadPorts = { nvrHttp: number; nvrRtsp: number; device: number }
export const DEFAULT_DEAD_PORTS: DeadPorts = { nvrHttp: DEAD_NVR_HTTP_PORT, nvrRtsp: DEAD_NVR_RTSP_PORT, device: DEAD_DEVICE_PORT }

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
}
export type DemoDevicePlan = { type: 'server' | 'attendance' | 'footfall'; name: string; storeCode: string | null; port: number }

/** The sample stores and devices. Every address is 127.0.0.1; names say DEMO so that they are never mistaken for real ones. */
export function demoPlan(nvrPort: number = DEFAULT_NVR_PORT, dead: DeadPorts = DEFAULT_DEAD_PORTS): { stores: DemoStorePlan[]; devices: DemoDevicePlan[] } {
  const nvr = parseNvrPort(nvrPort)
  const open = new Set([nvr, FAKE_RTSP_PORT, FAKE_ERP_PORT, FAKE_ATTENDANCE_PORT, FAKE_ATTENDANCE_2_PORT])
  const closed = [dead.nvrHttp, dead.nvrRtsp, dead.device]
  if (new Set(closed).size !== 3 || closed.some((p) => open.has(p))) {
    throw new Error('The ports for the offline demo targets must differ from each other and from the ports the pretend servers use.')
  }
  return {
    stores: [
      { code: 'DEMO1', name: 'Demo Store Patna', city: 'Patna', zone: 'BR', httpPort: nvr, rtspPort: FAKE_RTSP_PORT, cameras: 6 },
      // Nothing listens on these two ports: the NVR is down.
      { code: 'DEMO2', name: 'Demo Store Ranchi', city: 'Ranchi', zone: 'Jharkhand', httpPort: dead.nvrHttp, rtspPort: dead.nvrRtsp, cameras: 4 },
      { code: 'DEMO3', name: 'Demo Store Gaya', city: 'Gaya', zone: 'BR', httpPort: nvr, rtspPort: FAKE_RTSP_PORT, cameras: 4 },
    ],
    devices: [
      { type: 'server', name: 'Demo ERP server', storeCode: null, port: FAKE_ERP_PORT },
      { type: 'attendance', name: 'Demo attendance machine', storeCode: 'DEMO1', port: FAKE_ATTENDANCE_PORT },
      { type: 'footfall', name: 'Demo footfall counter', storeCode: 'DEMO1', port: dead.device }, // nothing listens: offline
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

export const DEMO_ROLES = ['user', 'operator', 'manager', 'admin', 'platform_owner'] as const
export type DemoRole = (typeof DEMO_ROLES)[number]
export const DEMO_ROLE_LABELS: Record<DemoRole, string> = {
  user: 'Viewer',
  operator: 'Operator',
  manager: 'Manager',
  admin: 'Administrator',
  platform_owner: 'Platform owner',
}
export const demoEmail = (role: DemoRole) => `demo.${role.replace('_', '-')}@demo.example.test`

/** One grant line of the demo: these capabilities at these stores (by code), or for the whole demo organisation. */
export type DemoGrant = { capabilities: string[]; scope: 'organization' | { stores: string[] } }

/** What administrators get: the same set the migration gives existing administrators (P2-1, migrated:admin). */
export const ADMIN_BASELINE = [
  'cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'wifi.inventory.view',
  'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
]

/**
 * The demo people's access, all as explicit grants (P2-1): no role gives access by itself. The viewer watches and plays back DEMO1 and
 * DEMO2; the operator also sees the IT side of all three stores and may start checks; the manager covers the BR zone stores (DEMO1,
 * DEMO3), CCTV and IT read, not the whole organisation; administrators get the administrator set for the organisation.
 */
export function demoGrants(role: DemoRole, storeCodes: readonly string[]): DemoGrant[] {
  const pick = (...codes: string[]) => ({ stores: codes.filter((c) => storeCodes.includes(c)) })
  switch (role) {
    case 'user':
      return [{ capabilities: ['cctv.live', 'cctv.playback'], scope: pick('DEMO1', 'DEMO2') }]
    case 'operator':
      return [{ capabilities: ['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate'], scope: pick('DEMO1', 'DEMO2', 'DEMO3') }]
    case 'manager':
      return [{ capabilities: ['cctv.live', 'cctv.playback', 'it.inventory.view', 'it.monitoring.view'], scope: pick('DEMO1', 'DEMO3') }]
    case 'admin':
    case 'platform_owner':
      return [{ capabilities: [...ADMIN_BASELINE], scope: 'organization' }]
  }
}

/** Reset deletes an organisation only when it is the demo one: the exact slug and a name that says DEMO. */
export const isDemoOrg = (o: { slug: string; name: string }): boolean => o.slug === DEMO_SLUG && o.name.startsWith('DEMO')
