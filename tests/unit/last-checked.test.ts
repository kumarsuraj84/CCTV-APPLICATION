import { describe, expect, it } from 'vitest'
import { describeRounds, lastCheckedAt } from '@/lib/monitor/last-checked'

const w = (over: Partial<Parameters<typeof lastCheckedAt>[0]> = {}) => ({ lastDevicesRoundAt: null, lastCamerasRoundAt: null, runFinishedAt: null, ...over })

describe('lastCheckedAt (Home: "Last checked")', () => {
  it('is nothing when nothing has finished yet', () => {
    expect(lastCheckedAt(w())).toBeNull()
  })

  it('is the most recent of the devices round, the cameras round and the last full check', () => {
    const a = '2026-10-22T10:00:00Z'
    const b = '2026-10-22T10:05:00Z'
    const c = '2026-10-22T10:09:00Z'
    expect(lastCheckedAt(w({ lastDevicesRoundAt: a, lastCamerasRoundAt: b }))).toEqual(new Date(b))
    expect(lastCheckedAt(w({ lastDevicesRoundAt: b, lastCamerasRoundAt: a }))).toEqual(new Date(b))
    expect(lastCheckedAt(w({ lastDevicesRoundAt: a, lastCamerasRoundAt: b, runFinishedAt: c }))).toEqual(new Date(c))
    expect(lastCheckedAt(w({ lastDevicesRoundAt: b, runFinishedAt: a }))).toEqual(new Date(b)) // an older full check does not win
    expect(lastCheckedAt(w({ runFinishedAt: a }))).toEqual(new Date(a))
  })

  it('ignores times it cannot read', () => {
    expect(lastCheckedAt(w({ lastDevicesRoundAt: 'garbage', lastCamerasRoundAt: '2026-10-22T10:00:00Z' }))).toEqual(new Date('2026-10-22T10:00:00Z'))
  })
})

describe('describeRounds (Monitoring page)', () => {
  it('says in plain words when each kind of round last finished, separately', () => {
    const text = describeRounds(w({ lastDevicesRoundAt: '2026-10-22T04:30:00Z', lastCamerasRoundAt: null }))
    expect(text.devices).toBe('Last round finished 22 Oct 2026, 10:00')
    expect(text.cameras).toBe('No round has finished yet')
  })
})
