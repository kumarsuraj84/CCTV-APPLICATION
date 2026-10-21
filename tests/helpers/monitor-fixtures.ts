import type { Deps } from '@/lib/monitor/checks'
import { loadMonitorConfig } from '@/lib/monitor/config'
import type { Probes, StoreJob } from '@/lib/monitor/types'
import type { MemoryDb } from './memory-db'

export const NOW = new Date('2026-05-01T08:00:00Z')
export const cfg = loadMonitorConfig({})

export function deps(db: MemoryDb, probes: Partial<Probes> = {}, clock: () => Date = () => NOW): Deps {
  const base: Probes = {
    tcp: async () => ({ ok: true }),
    icmp: async () => ({ ok: true }),
    rtsp: async () => ({ code: 0 }),
    nvr: () => ({ channelStatus: async () => new Map(), channels: async () => [] }),
  }
  return { db, probes: { ...base, ...probes }, cfg, clock }
}

/** What an RTSP check answers: 200 when the camera is live, 0 when nothing answered. */
export const rsp = (ok: boolean) => ({ code: ok ? 200 : 0 })

export const store = (over: Partial<StoreJob> = {}): StoreJob => ({
  id: 's1', org_id: 'o1', code: 'S1', ip: '127.0.0.1', rtsp_port: 554, http_port: 80, username: 'viewer', password: 'pw', nvr_status: 'up', nvr_checked_at: NOW.toISOString(),
  cameras: [{ id: 'c1', channel: 1, camera_ip: null }, { id: 'c2', channel: 2, camera_ip: null }, { id: 'c3', channel: 3, camera_ip: null }],
  ...over,
})
