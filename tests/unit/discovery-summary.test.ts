import { describe, expect, it } from 'vitest'
import { discoverySummary } from '@/lib/monitor/discovery-summary'
import type { LocationDiscovery } from '@/lib/monitor/discovery'

const base = (recorders: LocationDiscovery['recorders']): LocationDiscovery & { ok: true } => {
  const sum = (k: 'cameras' | 'created' | 'updated' | 'mapped' | 'moved') => recorders.reduce((n, r) => n + (r.ok ? r.result[k] : 0), 0)
  return { ok: true, cameras: sum('cameras'), created: sum('created'), updated: sum('updated'), mapped: sum('mapped'), moved: sum('moved'), recorders }
}
const result = (over: Partial<Extract<LocationDiscovery['recorders'][number], { ok: true }>['result']> = {}) => ({
  recorderId: 'r', locationId: 'l', cameras: 3, created: 1, updated: 2, mapped: 0, moved: 0, reconciliation: [], ...over,
})

// Review P2-5b M-8: the "Find cameras" message said every item "may have moved to another NVR" (also a renamed or missing camera) and
// never showed the list. It now says what each item is, per NVR, in plain words.
describe('the "Find cameras" summary', () => {
  it('counts and says nothing more when there is nothing to look at', () => {
    expect(discoverySummary(base([{ recorderId: 'r', name: 'NVR', ok: true, result: result() }]))).toEqual({ message: 'Found 3 cameras (1 new).', details: [] })
  })

  it('says what each item is, with the NVR\'s name, and counts moved cameras and NVRs that could not be asked', () => {
    const s = discoverySummary(base([
      {
        recorderId: 'a', name: 'Ground', ok: true, result: result({
          moved: 1,
          reconciliation: [
            { kind: 'possible_move', channel: 5, reportedName: 'Door', cameraId: 'c1', cameraName: 'Door', because: 'same_name' },
            { kind: 'missing', channel: 9, cameraId: 'c2', cameraName: 'Old till' },
            { kind: 'renamed', channel: 2, cameraId: 'c3', from: 'Till', to: 'Till 2' },
            { kind: 'channel_taken', channel: 3, cameraId: 'c4', cameraName: 'Back', takenBy: 'c5' },
          ],
        }),
      },
      { recorderId: 'b', name: 'First floor', ok: false, error: 'The NVR did not answer.' },
    ]))
    expect(s.message).toBe('Found 3 cameras (1 new, 1 moved to another channel). 4 things need a look. 1 NVR could not be asked.')
    expect(s.details).toEqual([
      'Ground, channel 5 ("Door"): may be the existing camera "Door"; nothing was added.',
      'Ground, channel 9: camera "Old till" is no longer listed by the NVR; it was kept.',
      'Ground, channel 2: "Till" is now called "Till 2" by the NVR.',
      'Ground, channel 3: the restored camera "Back" was on this channel, which another camera now uses; it was left unlinked.',
      'First floor: The NVR did not answer.',
    ])
  })

  // P2-5c-1 (re-review N-1 / N-2): a restored camera that discovery could not place is listed too, never left aside silently.
  it('lists a restored camera it could not place, pointing to the reconciliation list', () => {
    const s = discoverySummary(base([{ recorderId: 'a', name: 'Ground', ok: true, result: result({ reconciliation: [{ kind: 'unplaced', channel: 3, cameraId: 'c9', cameraName: 'Camera 03' }] }) }]))
    // Final fix X (release 1 review C M-30): the old words advised a link that linkFinding refuses for an "unplaced" camera
    // (MSG_UNPLACED_LINK); they now give the three things that can be done.
    expect(s.details).toEqual(['Ground: the restored camera "Camera 03" (last on channel 3) could not be placed; on the Reconciliation page merge it with the camera the NVR shows now, link it to a channel in the mapping editor, or take it off the list.'])
  })
})
