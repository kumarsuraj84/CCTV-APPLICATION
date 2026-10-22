import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { cameraState } from '@/lib/live/rollups'
import { getStates, MSG_RECORDER_NOT_REACHABLE, NVR_DOWN_CAMERA_ERROR, outageLabel, statusLabel } from '@/lib/queries/status'

// P4-L1 review round 1, I-3 (directive MC-4, RELEASE-1 item 4): ONE rule on every screen. A camera that is down only because its NVR
// cannot be reached (the checker's method nvr_down; its reason "Recorder not reachable." in camera words, or the checker's own words for
// the IT view) reads "Recorder not reachable": not "Offline", not red. The worker keeps writing what it writes; the readers decide.

function client(rows: { target_id: string; status: string }[], reasons: Record<string, string>) {
  return {
    from: () => ({ select: () => ({
      eq: () => ({ in: async (_c: string, ids: string[]) => ({ data: rows.filter((r) => ids.includes(r.target_id)).map((r) => ({ ...r, down_since: '2026-10-23T00:00:00Z', last_checked_at: '2026-10-23T00:00:00Z', last_up_at: null })), error: null }) }),
      // recorder_status (switched-off NVRs): none here
      in: () => ({ eq: async () => ({ data: [], error: null }) }),
    }) }),
    rpc: async (fn: string, args: { p_ids: string[] }) =>
      fn === 'status_reasons' ? { data: args.p_ids.map((id) => ({ target_id: id, reason: reasons[id] ?? null })), error: null } : { data: [], error: null },
  } as unknown as SupabaseClient
}

describe('recorder not reachable is not offline (review I-3)', () => {
  it('getStates gives a camera behind an unreachable NVR its own state, for the CCTV words and for the IT view\'s words', async () => {
    const c = client(
      [{ target_id: 'a', status: 'down' }, { target_id: 'b', status: 'down' }, { target_id: 'c', status: 'down' }, { target_id: 'd', status: 'up' }],
      { a: MSG_RECORDER_NOT_REACHABLE, b: NVR_DOWN_CAMERA_ERROR, c: 'The camera is not responding.' },
    )
    const s = await getStates(c as never, 'camera', ['a', 'b', 'c', 'd'])
    expect([s.get('a')?.status, s.get('b')?.status, s.get('c')?.status, s.get('d')?.status]).toEqual(['unreachable', 'unreachable', 'down', 'up'])
    // A recorder (or device) that is down is down: the rule is about cameras only.
    const r = await getStates(client([{ target_id: 'n', status: 'down' }], { n: NVR_DOWN_CAMERA_ERROR }) as never, 'recorder', ['n'])
    expect(r.get('n')?.status).toBe('down')
  })

  it('the words and the badge: "Recorder not reachable", amber, never the red offline look', () => {
    expect(statusLabel('unreachable')).toBe('Recorder not reachable')
    const html = renderToStaticMarkup(<StatusBadge status="unreachable" />)
    expect(html).toContain('Recorder not reachable')
    expect(html).not.toMatch(/red|destructive/)
    expect(html).toMatch(/title="[^"]*recorder[^"]*"/i)
    expect(html).not.toMatch(/NVR/)
    expect(cameraState({ status: 'unreachable', stale: false, reason: null })).toBe('unreachable')
  })

  it('outage lists say why: a camera outage caused by its NVR is "Recorder not reachable", any other is "Offline"', () => {
    expect(outageLabel({ kind: 'camera', cause: 'nvr_down', endedAt: null })).toBe('Recorder not reachable')
    expect(outageLabel({ kind: 'camera', cause: null, endedAt: null })).toBe('Offline')
    expect(outageLabel({ kind: 'recorder', cause: null, endedAt: null })).toBe('Offline')
    expect(outageLabel({ kind: 'camera', cause: 'nvr_down', endedAt: '2026-10-23T01:00:00Z' })).toBe('Live')
  })
})
