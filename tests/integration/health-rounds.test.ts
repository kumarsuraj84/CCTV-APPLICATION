import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getWorkerStatus } from '@/lib/monitor/health'
import type { Database } from '@/types/database'
import { adminClient } from '../setup/fixtures'

type WorkerRow = Database['public']['Tables']['worker_state']['Row']

describe('worker status: the times of the last rounds (I4)', () => {
  let saved: WorkerRow
  beforeAll(async () => {
    saved = (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
  })

  it('carries the last devices round and the last cameras round, or null when there has been none', async () => {
    const a = adminClient()
    await a.from('worker_state').update({ last_devices_round_at: null, last_cameras_round_at: null }).eq('id', 1)
    expect(await getWorkerStatus(a)).toMatchObject({ lastDevicesRoundAt: null, lastCamerasRoundAt: null })
    const d = '2026-06-01T10:00:00+00:00'
    const c = '2026-06-01T10:04:00+00:00'
    await a.from('worker_state').update({ last_devices_round_at: d, last_cameras_round_at: c }).eq('id', 1)
    const s = await getWorkerStatus(a)
    expect(new Date(s.lastDevicesRoundAt!).toISOString()).toBe(new Date(d).toISOString())
    expect(new Date(s.lastCamerasRoundAt!).toISOString()).toBe(new Date(c).toISOString())
  })
})
