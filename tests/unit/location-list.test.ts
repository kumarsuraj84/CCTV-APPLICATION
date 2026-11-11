import { describe, expect, it } from 'vitest'
import { locationCountsText, locationListFilter, parseLocationState } from '@/lib/live/location-list'
import type { StoreStatusRow } from '@/lib/queries/status'

// Final fix Y (final review C M-10, M-12): the camera column of the Locations list says every state the other screens say (never a bare
// "0 / 8" for cameras nobody checked or that are switched off), and the Home tiles' ?state= filters show the locations they counted.

const row = (o: Partial<StoreStatusRow>): StoreStatusRow => ({
  store_id: 's', cameras_total: 8, cameras_live: 0, cameras_down: 0, cameras_recorder_unreachable: 0, cameras_unknown: 0, cameras_stale: 0,
  cameras_monitoring_off: 0, nvr_status: null, nvr_down_since: null, nvr_checked_at: null, nvr_stale: false, ...o,
})

describe('the Locations list (C M-10, M-12)', () => {
  it('says what is live, offline, not reachable, not checked and switched off', () => {
    expect(locationCountsText(undefined)).toEqual({ text: '—', bad: false, quiet: true })
    expect(locationCountsText(row({ cameras_total: 0 }))).toEqual({ text: 'No cameras', bad: false, quiet: true })
    expect(locationCountsText(row({ cameras_unknown: 8 })).text).toBe('8 cameras: 0 live, 8 not checked yet')
    expect(locationCountsText(row({ cameras_monitoring_off: 8 })).text).toBe('8 cameras: 0 live, 8 switched off')
    const mixed = locationCountsText(row({ cameras_live: 3, cameras_down: 2, cameras_recorder_unreachable: 1, cameras_stale: 1, cameras_unknown: 1 }))
    expect(mixed).toEqual({ text: '8 cameras: 3 live, 2 offline, 1 recorder not reachable, 1 not checked lately, 1 not checked yet', bad: true, quiet: false })
    expect(locationCountsText(row({ cameras_live: 8 }))).toEqual({ text: '8 cameras: 8 live', bad: false, quiet: false })
  })

  it('the state filter of the Home tiles', () => {
    expect(parseLocationState('offline')).toBe('offline')
    expect(parseLocationState('nonsense')).toBeNull()
    expect(parseLocationState(undefined)).toBeNull()
    expect(locationListFilter(null, undefined)).toBe(true)
    expect(locationListFilter('offline', row({ cameras_down: 1 }))).toBe(true)
    expect(locationListFilter('offline', row({ cameras_live: 8 }))).toBe(false)
    expect(locationListFilter('unreachable', row({ cameras_recorder_unreachable: 2 }))).toBe(true)
    expect(locationListFilter('stale', row({ cameras_stale: 1 }))).toBe(true)
    expect(locationListFilter('not_checked', row({ cameras_unknown: 1 }))).toBe(true)
    expect(locationListFilter('not_checked', undefined)).toBe(false)
  })
})
