import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getRollups, sumCameras, sumRecorders, type CameraCounts, type RecorderCounts, type RollupCard } from '@/lib/live/rollups'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

/**
 * P4-L1 brief item 1: the Home dashboard's roll-ups per region and per cluster, from status_rollups as the person (any CCTV right for the
 * camera figures; NVR figures only with the IT view) and the region and cluster names the person may see (row security). A region or
 * cluster without anything the person may see in it has no row, so it gets no card.
 */
export async function loadHomeRollups(supabase: Client): Promise<{ regions: RollupCard[]; clusters: RollupCard[]; cameras: CameraCounts; recorders: RecorderCounts | null; locations: number }> {
  const [rollups, regions, clusters] = await Promise.all([
    getRollups(supabase),
    fetchAll((from, to) => supabase.from('regions').select('id, code, name').is('archived_at', null).order('code').order('id').range(from, to)),
    fetchAll((from, to) => supabase.from('clusters').select('id, code, name').is('archived_at', null).order('code').order('id').range(from, to)),
  ])
  const of = new Map(rollups.map((r) => [`${r.level}:${r.id}`, r]))
  const cards = (level: 'region' | 'cluster', rows: { id: string; code: string; name: string }[]): RollupCard[] =>
    rows.flatMap((n) => {
      const r = of.get(`${level}:${n.id}`)
      return r ? [{ id: n.id, code: n.code, name: n.name, counts: r.cameras, recorders: r.recorders }] : []
    })
  // Totals: the sum of the location rows (each camera and each NVR is in exactly one location).
  const places = rollups.filter((r) => r.level === 'location')
  return {
    regions: cards('region', regions), clusters: cards('cluster', clusters), cameras: sumCameras(places), recorders: sumRecorders(places),
    locations: places.filter((r) => r.cameras.total > 0).length,
  }
}
