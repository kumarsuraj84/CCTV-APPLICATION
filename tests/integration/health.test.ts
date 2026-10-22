import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getWorkerHealth, getWorkerStatus } from '@/lib/monitor/health'
import type { Database } from '@/types/database'
import { adminClient } from '../setup/fixtures'

type WorkerRow = Database['public']['Tables']['worker_state']['Row']

describe('worker health', () => {
  let saved: WorkerRow
  beforeAll(async () => {
    saved = (await adminClient().from('worker_state').select('*').eq('id', 1).single()).data!
  })
  afterAll(async () => {
    await adminClient().from('worker_state').update(saved).eq('id', 1)
  })

  it('is ok with a fresh heartbeat and not ok with an old or missing one', async () => {
    const a = adminClient()
    const now = new Date('2026-06-01T10:00:00Z')
    await a.from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 4000).toISOString() }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: true, heartbeatAgeSec: 4 })
    await a.from('worker_state').update({ last_heartbeat: new Date(now.getTime() - 120_000).toISOString() }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: false, heartbeatAgeSec: 120 })
    await a.from('worker_state').update({ last_heartbeat: null }).eq('id', 1)
    expect(await getWorkerHealth(a, now)).toEqual({ ok: false, heartbeatAgeSec: null })
  })

  it('shows whether a run is in progress', async () => {
    const a = adminClient()
    const now = new Date('2026-06-01T10:00:00Z')
    await a.from('worker_state').update({
      last_heartbeat: now.toISOString(), run_started_at: new Date(now.getTime() - 20_000).toISOString(), run_finished_at: null, progress_done: 3, progress_total: 10,
    }).eq('id', 1)
    expect(await getWorkerStatus(a, now)).toMatchObject({ ok: true, running: true, progressDone: 3, progressTotal: 10 })
    await a.from('worker_state').update({ run_finished_at: new Date(now.getTime() - 1000).toISOString() }).eq('id', 1)
    expect((await getWorkerStatus(a, now)).running).toBe(false)
  })
})
