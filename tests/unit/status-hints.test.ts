import { describe, expect, it } from 'vitest'
import { formatUptime, nvrLoginProblem, type StateRow } from '@/lib/queries/status'

const NOW = new Date('2026-10-22T10:00:00Z')
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const state = (over: Partial<StateRow> = {}): StateRow => ({ target_id: 'x', status: 'up', down_since: null, last_checked_at: minAgo(1), last_up_at: minAgo(1), error: null, ...over })

describe('nvrLoginProblem', () => {
  const nvrUp = state()
  it('is a problem when the NVR is live but no camera has a recent result', () => {
    expect(nvrLoginProblem({ nvr: nvrUp, cameraIds: ['a', 'b'], cameraStates: new Map(), now: NOW })).toBe(true)
    const old = new Map([['a', state({ last_checked_at: minAgo(60) })], ['b', state({ last_checked_at: minAgo(45) })]])
    expect(nvrLoginProblem({ nvr: nvrUp, cameraIds: ['a', 'b'], cameraStates: old, now: NOW })).toBe(true)
  })
  it('is not a problem when any camera was checked recently', () => {
    const some = new Map([['a', state({ last_checked_at: minAgo(3) })]])
    expect(nvrLoginProblem({ nvr: nvrUp, cameraIds: ['a', 'b'], cameraStates: some, now: NOW })).toBe(false)
  })
  it('is not a problem when the NVR is not live, has no cameras, or was not checked recently itself', () => {
    expect(nvrLoginProblem({ nvr: state({ status: 'down' }), cameraIds: ['a'], cameraStates: new Map(), now: NOW })).toBe(false)
    expect(nvrLoginProblem({ nvr: undefined, cameraIds: ['a'], cameraStates: new Map(), now: NOW })).toBe(false)
    expect(nvrLoginProblem({ nvr: nvrUp, cameraIds: [], cameraStates: new Map(), now: NOW })).toBe(false)
    expect(nvrLoginProblem({ nvr: state({ last_checked_at: minAgo(30) }), cameraIds: ['a'], cameraStates: new Map(), now: NOW })).toBe(false)
  })
})

describe('formatUptime', () => {
  it('shows one decimal and says when there is no data', () => {
    expect(formatUptime(99.5)).toBe('99.5%')
    expect(formatUptime(100)).toBe('100%')
    expect(formatUptime(98.14)).toBe('98.1%')
    expect(formatUptime(null)).toBe('No data')
    expect(formatUptime(undefined)).toBe('No data')
  })
})
