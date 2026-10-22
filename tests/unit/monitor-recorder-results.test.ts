import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCameras } from '@/lib/monitor/checks'
import { cleanResults } from '@/lib/monitor/supabase-db'
import { MemoryDb } from '../helpers/memory-db'
import { deps, NOW, recorder } from '../helpers/monitor-fixtures'

afterEach(() => vi.restoreAllMocks())

const R1 = '11111111-1111-4111-8111-111111111111'
const C1 = '22222222-2222-4222-8222-222222222222'

// Review P2-5b M-3: a camera result says which NVR produced it, so that a result from a camera's PREVIOUS NVR (a round that started
// before the camera was moved) is ignored by monitor_apply_results instead of marking the camera down.
describe('camera results name their NVR', () => {
  it('every camera result of a round carries the recorder id: a normal round, a known-down NVR and an unusable address', async () => {
    const rounds = [
      recorder({ id: 'r-normal' }),
      recorder({ id: 'r-down', knownDown: true }),
      recorder({ id: 'r-bad', ip: 'not a host' }),
    ]
    for (const job of rounds) {
      const db = new MemoryDb()
      db.recorders = [job]
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await checkCameras(deps(db, { rtsp: async () => ({ code: 200 }) }))
      expect(db.results().length, job.id).toBe(3)
      expect(db.results().map((r) => r.recorder), job.id).toEqual([job.id, job.id, job.id])
    }
  })

  it('camera addresses an NVR reports are saved for the cameras of THAT NVR only', async () => {
    const db = new MemoryDb()
    db.recorders = [recorder({ id: 'r1' })]
    await checkCameras(deps(db, {
      rtsp: async () => ({ code: 200 }),
      nvr: () => ({ channelStatus: async () => new Map([[1, true]]), channels: async () => [{ channel: 1, name: 'A', ip: '192.0.2.9' }] }),
    }))
    expect(db.ipsSaved).toEqual([{ orgId: 'o1', rows: [{ cameraId: 'c1', ip: '192.0.2.9', recorderId: 'r1' }] }])
  })

  it('the last gate keeps the recorder id (a UUID only) on camera results and nowhere else', () => {
    const at = NOW.toISOString()
    expect(cleanResults([{ type: 'camera', id: C1, recorder: R1, ok: true, at }])).toEqual([{ type: 'camera', id: C1, recorder: R1, ok: true, at }])
    expect(cleanResults([{ type: 'camera', id: C1, recorder: 'not-a-uuid', ok: true, at }])).toEqual([])
    expect(cleanResults([{ type: 'recorder', id: R1, recorder: R1, ok: true, at }])).toEqual([{ type: 'recorder', id: R1, ok: true, at }])
  })
})
