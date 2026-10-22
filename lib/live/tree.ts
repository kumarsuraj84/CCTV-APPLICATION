import { sumCameras, sumRecorders, type CameraCounts, type RecorderCounts, type RollupRow } from '@/lib/live/rollups'

// P4-L1 brief item 1: the viewer's own Region → Cluster → Location tree for the Live landing. Pure: it is given the rows the person's
// own client could read (row security decides which regions, clusters and locations exist for them) and their roll-ups, and only
// arranges them. A location appears when it has a roll-up row (something the person may see in it); a cluster or region appears when
// one of its locations does. A location whose cluster the person may not see (or that has none) is listed on its own, and so is a
// cluster whose region they may not see: no "Unassigned" bucket is ever made (owner amendment to R-1).

export type NamedRow = { id: string; code: string; name: string }
export type TreeLocation = NamedRow & { city: string | null; counts: CameraCounts; recorders: RecorderCounts | null }
export type TreeCluster = NamedRow & { counts: CameraCounts; recorders: RecorderCounts | null; locations: TreeLocation[] }
export type TreeRegion = NamedRow & { counts: CameraCounts; recorders: RecorderCounts | null; clusters: TreeCluster[] }
/** `clusters`: clusters outside a visible region; `locations`: locations outside a visible cluster. */
export type LiveTree = { regions: TreeRegion[]; clusters: TreeCluster[]; locations: TreeLocation[] }

const byCode = <T extends NamedRow>(a: T, b: T) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function buildLiveTree(input: {
  regions: readonly NamedRow[]
  clusters: readonly (NamedRow & { region_id: string | null })[]
  locations: readonly (NamedRow & { city: string | null; cluster_id: string | null })[]
  rollups: readonly RollupRow[]
}): LiveTree {
  const roll = new Map(input.rollups.map((r) => [`${r.level}:${r.id}`, r]))
  const regionIds = new Set(input.regions.map((r) => r.id))
  const clusterIds = new Set(input.clusters.map((c) => c.id))

  const locsOf = new Map<string, TreeLocation[]>()
  const loose: TreeLocation[] = []
  for (const l of input.locations) {
    const r = roll.get(`location:${l.id}`)
    if (!r) continue
    const node: TreeLocation = { id: l.id, code: l.code, name: l.name, city: l.city, counts: r.cameras, recorders: r.recorders }
    if (l.cluster_id && clusterIds.has(l.cluster_id)) locsOf.set(l.cluster_id, [...(locsOf.get(l.cluster_id) ?? []), node])
    else loose.push(node)
  }

  const clustersOf = new Map<string, TreeCluster[]>()
  const looseClusters: TreeCluster[] = []
  for (const c of input.clusters) {
    const locations = (locsOf.get(c.id) ?? []).sort(byCode)
    if (locations.length === 0) continue
    const r = roll.get(`cluster:${c.id}`)
    const node: TreeCluster = { id: c.id, code: c.code, name: c.name, counts: r?.cameras ?? sumCameras(locations.map((l) => ({ cameras: l.counts }))), recorders: r ? r.recorders : sumRecorders(locations), locations }
    if (c.region_id && regionIds.has(c.region_id)) clustersOf.set(c.region_id, [...(clustersOf.get(c.region_id) ?? []), node])
    else looseClusters.push(node)
  }

  const regions: TreeRegion[] = []
  for (const g of input.regions) {
    const clusters = (clustersOf.get(g.id) ?? []).sort(byCode)
    if (clusters.length === 0) continue
    const r = roll.get(`region:${g.id}`)
    regions.push({ id: g.id, code: g.code, name: g.name, counts: r?.cameras ?? sumCameras(clusters.map((c) => ({ cameras: c.counts }))), recorders: r ? r.recorders : sumRecorders(clusters), clusters })
  }
  return { regions: regions.sort(byCode), clusters: looseClusters.sort(byCode), locations: loose.sort(byCode) }
}

/** Every location of the tree, wherever it sits. */
export function treeLocations(t: LiveTree): TreeLocation[] {
  return [...t.regions.flatMap((r) => r.clusters.flatMap((c) => c.locations)), ...t.clusters.flatMap((c) => c.locations), ...t.locations]
}

/** The whole tree's camera figures: the sum of its locations (each camera is in exactly one). */
export function treeCounts(t: LiveTree): CameraCounts {
  return sumCameras(treeLocations(t).map((l) => ({ cameras: l.counts })))
}

const matches = (q: string, ...values: (string | null)[]) => values.some((v) => v !== null && v.toLowerCase().includes(q))

/**
 * Search by location code, name or city (the path to each match is kept), or by a cluster's or region's code or name (everything below
 * it is kept). Counts stay the nodes' own. An empty search gives the tree back unchanged.
 */
export function filterTree(t: LiveTree, query: string): LiveTree {
  const q = query.trim().toLowerCase()
  if (q === '') return t
  const keepLoc = (l: TreeLocation) => matches(q, l.code, l.name, l.city)
  const keepCluster = (c: TreeCluster): TreeCluster | null => {
    if (matches(q, c.code, c.name)) return c
    const locations = c.locations.filter(keepLoc)
    return locations.length ? { ...c, locations } : null
  }
  const regions = t.regions.flatMap((r) => {
    if (matches(q, r.code, r.name)) return [r]
    const clusters = r.clusters.map(keepCluster).filter((c): c is TreeCluster => c !== null)
    return clusters.length ? [{ ...r, clusters }] : []
  })
  return { regions, clusters: t.clusters.map(keepCluster).filter((c): c is TreeCluster => c !== null), locations: t.locations.filter(keepLoc) }
}
