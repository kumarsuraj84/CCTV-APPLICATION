import { createHash } from 'node:crypto'
import type { ImportIssue, LocationGroup, ParsedLocations, RecorderRow } from '@/lib/import/locations-csv'
import { displayName as startingName, type LocationKind } from '@/lib/inventory/forms'
import { addressChanged, MSG_PASSWORD_AGAIN } from '@/lib/inventory/recorder-admin'

// The preview of the validated location import (P2-5c-2 brief item 1): what applying the file would do, worked out from the parsed file
// and a snapshot of the organisation's inventory. A pure function: the loader (lib/import/locations-import.ts) reads the snapshot with
// the service role after the caller's checks, and the apply runs the plan in ONE database transaction (inventory_import_apply).
//
// Identity rules (idempotent re-import): a location is matched by its code; an NVR by its location + address + web port, and — the legacy
// rule "location + primary NVR" — the one row of a location whose address matches none of its NVRs is that location's primary NVR (its
// address changed); a camera by NVR + channel. Nothing that is not in the file is changed; it is only LISTED as "not in the file" and is
// archived (never deleted) only when the person confirms it, and only for a file without problems.
//
// Two outputs: `preview` goes to the browser and holds no password (only "set" / "unchanged"); `apply` stays on the server and carries
// the passwords that must be written to the vault. `fingerprint` binds an apply to exactly the preview the person saw.

export type SnapLocation = {
  id: string; code: string; name: string; kind: string; city: string | null; zone: string | null; state: string | null; address: string | null
  cluster_id: string | null
}
export type SnapRecorder = {
  id: string; location_id: string; name: string; host: string | null; http_port: number; rtsp_port: number; username: string | null
  expected_channels: number; monitoring_enabled: boolean; has_password: boolean
  /** The location's primary NVR (recorder_primary_of). */
  primary: boolean
}
/** A camera with an ACTIVE mapping on a recorder. */
export type SnapCamera = { id: string; recorder_id: string; channel: number; name: string }
export type ImportSnapshot = {
  locations: SnapLocation[]
  recorders: SnapRecorder[]
  activeCameras: SnapCamera[]
  /** Per recorder: the channels that EVER had a camera (review I-3: such a channel gets no new placeholder). */
  channelsEverMapped: Record<string, number[]>
  regions: { id: string; code: string }[]
  clusters: { id: string; code: string; region_id: string | null }[]
  /** Recorders whose saved password equals the one in the file (compared in the database; the value never leaves it). */
  sameSecret: Set<string>
}

export type RecorderMatch = { id: string; by: 'address' | 'primary' }

export type PlanRecorderView = {
  line: number; action: 'create' | 'update' | 'unchanged'; id: string | null; name: string; host: string; http_port: number; rtsp_port: number
  matchedBy: RecorderMatch['by'] | null; changes: string[]; password: 'set' | 'unchanged'; monitoring: 'on' | 'off' | 'unchanged'; camerasToAdd: number
}
export type PlanLocationView = {
  line: number; code: string; status: 'create' | 'update' | 'unchanged' | 'skipped'; id: string | null; name: string; kind: string | null
  changes: string[]; cluster: string | null; recorders: PlanRecorderView[]
}
export type ArchiveItem = { kind: 'location' | 'recorder' | 'camera'; id: string; label: string; cameras: number }
export type ImportCounts = {
  locationsNew: number; locationsChanged: number; locationsUnchanged: number; locationsSkipped: number
  recordersNew: number; recordersChanged: number; recordersUnchanged: number; passwordsSet: number; camerasNew: number
  regionsNew: number; clustersNew: number; archiveLocations: number; archiveRecorders: number; archiveCameras: number
}
export type ImportPreview = {
  fingerprint: string
  rows: number
  errors: ImportIssue[]
  warnings: ImportIssue[]
  /** Locations skipped because one of their rows has a problem. */
  skipped: number
  canApply: boolean
  /** Archiving "not in the file" needs a file without problems (a bad row could hide a location that IS in the file). */
  archiveAllowed: boolean
  counts: ImportCounts
  locations: PlanLocationView[]
  archive: ArchiveItem[]
  regionsToCreate: string[]
  clustersToCreate: { code: string; region: string | null }[]
}

type LocationFields = { name?: string; kind?: string; city?: string | null; zone?: string | null; state?: string | null; address?: string | null }
export type ApplyRecorder = {
  line: number; action: 'create' | 'update' | 'unchanged'; id: string | null; name: string | null; host: string; http_port: number; rtsp_port: number
  username: string; channels: number | null
  /** Only when it must be written to the vault. */
  password?: string
  /** Only when it must be switched (or, for a new NVR, true). */
  monitoring?: boolean
  placeholders: number
}
export type ApplyLocation = {
  line: number; action: 'create' | 'update' | 'unchanged'; id: string | null; code: string; fields: LocationFields
  /** A new location's cluster (by code). */
  cluster: string | null
  /** An existing location without a cluster that joins this one (through inventory_move_location: access versions and audit). */
  join_cluster: string | null
  recorders: ApplyRecorder[]
}
export type ApplyPlan = {
  regions: { code: string; name: string }[]
  clusters: { code: string; name: string; region_code: string | null }[]
  locations: ApplyLocation[]
  archive: { kind: ArchiveItem['kind']; id: string }[]
}

const key = (host: string | null, port: number) => `${(host ?? '').trim().toLowerCase()}|${port}`

/** Which existing NVR each row of the file is (by row line). Rows without a match are new NVRs. */
export function matchRecorderRows(groups: readonly LocationGroup[], snap: Pick<ImportSnapshot, 'locations' | 'recorders'>): Map<number, RecorderMatch> {
  const out = new Map<number, RecorderMatch>()
  const locByCode = new Map(snap.locations.map((l) => [l.code.toUpperCase(), l]))
  for (const g of groups) {
    const loc = locByCode.get(g.code)
    if (!loc) continue
    const recs = snap.recorders.filter((r) => r.location_id === loc.id)
    const used = new Set<string>()
    for (const row of g.recorders) {
      const hit = recs.find((r) => !used.has(r.id) && key(r.host, r.http_port) === key(row.host, row.http_port))
      if (hit) {
        used.add(hit.id)
        out.set(row.line, { id: hit.id, by: 'address' })
      }
    }
    // The legacy file: one row per location is "the location's NVR" (its primary); a changed address updates it.
    if (g.recorders.length === 1 && !out.has(g.recorders[0].line) && recs.length > 0) {
      const primary = recs.find((r) => r.primary) ?? recs[0]
      if (!used.has(primary.id)) out.set(g.recorders[0].line, { id: primary.id, by: 'primary' })
    }
  }
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function planImport(parsed: ParsedLocations, snap: ImportSnapshot, opts: { skipBadRows: boolean; archive?: boolean }): { preview: ImportPreview; apply: ApplyPlan } {
  const errors: ImportIssue[] = [...parsed.errors]
  const warnings: ImportIssue[] = [...parsed.warnings]
  const locByCode = new Map(snap.locations.map((l) => [l.code.toUpperCase(), l]))
  const regionById = new Map(snap.regions.map((r) => [r.id, r]))
  const regionByCode = new Map(snap.regions.map((r) => [r.code.toUpperCase(), r]))
  const clusterById = new Map(snap.clusters.map((c) => [c.id, c]))
  const clusterByCode = new Map(snap.clusters.map((c) => [c.code.toUpperCase(), c]))
  const camerasOn = new Map<string, SnapCamera[]>()
  for (const c of snap.activeCameras) camerasOn.set(c.recorder_id, [...(camerasOn.get(c.recorder_id) ?? []), c])
  const matches = matchRecorderRows(parsed.groups, snap)
  const planBad = new Set<string>()
  const fail = (code: string, issue: ImportIssue) => {
    errors.push(issue)
    planBad.add(code)
  }

  // One cluster belongs to one region: the file may not put a cluster in two regions.
  const clusterRegionInFile = new Map<string, { region: string; line: number }>()
  for (const g of parsed.groups) {
    if (!g.cluster || !g.region) continue
    const seen = clusterRegionInFile.get(g.cluster)
    if (seen && seen.region !== g.region) fail(g.code, { line: g.line, column: 'region', message: `Line ${seen.line} puts cluster ${g.cluster} in region ${seen.region}; one cluster belongs to one region.` })
    else if (!seen) clusterRegionInFile.set(g.cluster, { region: g.region, line: g.line })
  }

  type Built = { group: LocationGroup; view: PlanLocationView; apply: ApplyLocation; archive: ArchiveItem[] }
  const built: Built[] = []
  for (const g of parsed.groups) {
    const existing = locByCode.get(g.code)
    const issues: ImportIssue[] = []
    const changes: string[] = []
    const fields: LocationFields = {}
    let name: string
    let clusterShown: string | null = null
    let joinCluster: string | null = null
    if (!existing) {
      name = g.displayName ?? startingName(g.code, g.city)
      Object.assign(fields, { name, kind: g.kind ?? 'store', city: g.city, zone: g.zone, state: g.state, address: g.address })
      clusterShown = g.cluster
    } else {
      // The display name: given → used; still at its starting value ("CODE" from the old import, or "CODE - City") → follows the
      // ruling's "CODE - City"; edited by a person → kept.
      const city = g.city ?? existing.city
      const atStart = existing.name === existing.code || existing.name === startingName(existing.code, existing.city)
      name = g.displayName ?? (atStart ? startingName(existing.code, city) : existing.name)
      if (name !== existing.name) { fields.name = name; changes.push('display name') }
      const diff = (k: 'kind' | 'city' | 'zone' | 'state' | 'address', now: string | null, word: string) => {
        if (now !== null && now !== existing[k]) { fields[k] = now; changes.push(word) }
      }
      diff('kind', g.kind, 'kind')
      diff('city', g.city, 'city')
      diff('zone', g.zone, 'zone')
      diff('state', g.state, 'state')
      diff('address', g.address, 'address')
      const current = existing.cluster_id ? clusterById.get(existing.cluster_id)?.code ?? null : null
      clusterShown = current
      if (g.cluster && current === null) {
        joinCluster = g.cluster
        clusterShown = g.cluster
        changes.push(`joins cluster ${g.cluster}`)
      } else if (g.cluster && current !== g.cluster) {
        warnings.push({ line: g.line, column: 'cluster', message: `This location is in cluster ${current}; the import does not move it. Move it on its page, which shows the effect on access first.` })
      }
    }

    // NVRs.
    const existingRecs = existing ? snap.recorders.filter((r) => r.location_id === existing.id) : []
    const newRows = g.recorders.filter((r) => !matches.has(r.line))
    const totalAfter = existingRecs.length + newRows.length
    const recViews: PlanRecorderView[] = []
    const recApply: ApplyRecorder[] = []
    const archive: ArchiveItem[] = []
    const matchedIds = new Set<string>()
    for (const row of g.recorders) {
      const m = matches.get(row.line)
      const r = m ? existingRecs.find((x) => x.id === m.id) : undefined
      if (m && r) {
        matchedIds.add(r.id)
        const rc: string[] = []
        if (key(row.host, 0) !== key(r.host, 0)) rc.push('address')
        if (row.http_port !== r.http_port) rc.push('web port')
        if (row.rtsp_port !== r.rtsp_port) rc.push('video port')
        if (row.username !== (r.username ?? '')) rc.push('user name')
        if (row.name !== null && row.name !== r.name) rc.push('name')
        if (row.channels !== null && row.channels !== r.expected_channels) rc.push('number of cameras')
        let password: PlanRecorderView['password'] = 'unchanged'
        if (row.password !== '') {
          if (!snap.sameSecret.has(r.id)) { password = 'set'; rc.push('password') }
        } else if (!r.has_password) {
          issues.push({ line: row.line, column: 'password', message: 'This NVR has no saved password yet: give it in the file.' })
        } else if (addressChanged(r.host, r.http_port, row.host, row.http_port)) {
          // P2-5c-1 review I-4 (same helper and words as the NVR page): the saved password belongs to the address it was saved for; it
          // is never sent to a new address unasked.
          issues.push({ line: row.line, column: 'password', message: MSG_PASSWORD_AGAIN })
        }
        let monitoring: PlanRecorderView['monitoring'] = 'unchanged'
        if (row.monitoring !== null && row.monitoring !== r.monitoring_enabled) { monitoring = row.monitoring ? 'on' : 'off'; rc.push('monitoring') }
        const active = camerasOn.get(r.id) ?? []
        const toAdd = row.channels === null ? 0 : placeholdersFor(row.channels, active, snap.channelsEverMapped[r.id] ?? [])
        if (toAdd > 0) rc.push(`${plural(toAdd, 'camera', 'cameras')} to add`)
        if (row.channels !== null && row.channels >= 1) {
          for (const c of active.filter((x) => x.channel > row.channels!).sort((a, b) => a.channel - b.channel)) {
            archive.push({ kind: 'camera', id: c.id, label: `${g.code} · ${r.name} · channel ${c.channel} (${c.name})`, cameras: 1 })
          }
        }
        const action = rc.length > 0 ? 'update' : 'unchanged'
        recViews.push({ line: row.line, action, id: r.id, name: row.name ?? r.name, host: row.host, http_port: row.http_port, rtsp_port: row.rtsp_port, matchedBy: m.by, changes: rc, password, monitoring, camerasToAdd: toAdd })
        recApply.push({
          line: row.line, action, id: r.id, name: row.name, host: row.host, http_port: row.http_port, rtsp_port: row.rtsp_port, username: row.username,
          channels: row.channels, placeholders: toAdd,
          ...(password === 'set' ? { password: row.password } : {}), ...(monitoring !== 'unchanged' ? { monitoring: monitoring === 'on' } : {}),
        })
      } else {
        if (row.password === '') issues.push({ line: row.line, column: 'password', message: 'A new NVR needs its password.' })
        const name = row.name ?? (totalAfter === 1 ? 'NVR' : `NVR ${existingRecs.length + newRows.indexOf(row) + 1}`)
        const toAdd = row.channels ?? 0
        recViews.push({ line: row.line, action: 'create', id: null, name, host: row.host, http_port: row.http_port, rtsp_port: row.rtsp_port, matchedBy: null, changes: [], password: 'set', monitoring: row.monitoring === false ? 'off' : 'on', camerasToAdd: toAdd })
        recApply.push({
          line: row.line, action: 'create', id: null, name, host: row.host, http_port: row.http_port, rtsp_port: row.rtsp_port, username: row.username,
          channels: row.channels, password: row.password, monitoring: row.monitoring !== false, placeholders: toAdd,
        })
      }
    }
    // NVRs of this location that the file does not list (only when the file lists NVRs at all).
    if (parsed.listsRecorders) {
      for (const r of existingRecs.filter((x) => !matchedIds.has(x.id))) {
        archive.push({ kind: 'recorder', id: r.id, label: `${g.code} · ${r.name}${r.host ? ` (${r.host})` : ''}`, cameras: (camerasOn.get(r.id) ?? []).length })
      }
    }

    if (issues.length > 0) for (const i of issues) fail(g.code, i)
    const status: PlanLocationView['status'] = !existing ? 'create' : changes.length > 0 || recViews.some((r) => r.action !== 'unchanged') ? 'update' : 'unchanged'
    built.push({
      group: g,
      view: { line: g.line, code: g.code, status, id: existing?.id ?? null, name, kind: (fields.kind ?? existing?.kind ?? null) as LocationKind | null, changes, cluster: clusterShown, recorders: recViews },
      apply: { line: g.line, action: status === 'create' ? 'create' : status, id: existing?.id ?? null, code: g.code, fields, cluster: existing ? null : g.cluster, join_cluster: joinCluster, recorders: recApply },
      archive,
    })
  }

  const good = built.filter((b) => !planBad.has(b.group.code))
  const skippedViews: PlanLocationView[] = [
    ...parsed.bad.map((b) => ({ code: b.code, line: b.line })),
    ...built.filter((b) => planBad.has(b.group.code)).map((b) => ({ code: b.group.code, line: b.group.line })),
  ].map(({ code, line }) => {
    const e = locByCode.get(code)
    return { line, code, status: 'skipped' as const, id: e?.id ?? null, name: e?.name ?? code, kind: e?.kind ?? null, changes: [], cluster: null, recorders: [] }
  })

  // Clusters and regions the good locations need: found by code, else created (named by their code; rename them later).
  const regionsToCreate: string[] = []
  const clustersToCreate: { code: string; region: string | null }[] = []
  for (const b of good) {
    const g = b.group
    if (!g.cluster) continue
    const found = clusterByCode.get(g.cluster)
    if (found) {
      const currentRegion = found.region_id ? regionById.get(found.region_id)?.code ?? null : null
      if (g.region && currentRegion !== g.region && !warnings.some((w) => w.line === g.line && w.column === 'region')) {
        warnings.push({ line: g.line, column: 'region', message: currentRegion
          ? `Cluster ${g.cluster} is in region ${currentRegion}; the import does not move it. Move it on the Regions and clusters page.`
          : `Cluster ${g.cluster} has no region; the import does not move it. Move it on the Regions and clusters page.` })
      }
      continue
    }
    if (clustersToCreate.some((c) => c.code === g.cluster)) continue
    const region = clusterRegionInFile.get(g.cluster)?.region ?? null
    clustersToCreate.push({ code: g.cluster, region })
    if (region && !regionByCode.has(region) && !regionsToCreate.includes(region)) regionsToCreate.push(region)
  }

  const fileCodes = new Set([...parsed.groups.map((g) => g.code), ...parsed.badCodes])
  const archiveAllowed = errors.length === 0
  const archive: ArchiveItem[] = []
  if (archiveAllowed) {
    for (const b of good) archive.push(...b.archive)
    for (const l of snap.locations) {
      if (fileCodes.has(l.code.toUpperCase())) continue
      const recIds = new Set(snap.recorders.filter((r) => r.location_id === l.id).map((r) => r.id))
      archive.push({ kind: 'location', id: l.id, label: `${l.code} · ${l.name}`, cameras: snap.activeCameras.filter((c) => recIds.has(c.recorder_id)).length })
    }
  }

  const views = [...good.map((b) => b.view), ...skippedViews].sort((a, b) => a.line - b.line)
  const recs = good.flatMap((b) => b.view.recorders)
  const counts: ImportCounts = {
    locationsNew: good.filter((b) => b.view.status === 'create').length,
    locationsChanged: good.filter((b) => b.view.status === 'update').length,
    locationsUnchanged: good.filter((b) => b.view.status === 'unchanged').length,
    locationsSkipped: skippedViews.length,
    recordersNew: recs.filter((r) => r.action === 'create').length,
    recordersChanged: recs.filter((r) => r.action === 'update').length,
    recordersUnchanged: recs.filter((r) => r.action === 'unchanged').length,
    passwordsSet: recs.filter((r) => r.password === 'set').length,
    camerasNew: recs.reduce((n, r) => n + r.camerasToAdd, 0),
    regionsNew: regionsToCreate.length,
    clustersNew: clustersToCreate.length,
    archiveLocations: archive.filter((a) => a.kind === 'location').length,
    archiveRecorders: archive.filter((a) => a.kind === 'recorder').length,
    archiveCameras: archive.filter((a) => a.kind === 'camera').length,
  }
  errors.sort((a, b) => a.line - b.line)

  const apply: ApplyPlan = {
    regions: regionsToCreate.map((code) => ({ code, name: code })),
    clusters: clustersToCreate.map((c) => ({ code: c.code, name: c.code, region_code: c.region })),
    locations: good.map((b) => b.apply),
    archive: opts.archive && archiveAllowed ? archive.map((a) => ({ kind: a.kind, id: a.id })) : [],
  }
  const canApply = (errors.length === 0 || opts.skipBadRows) && good.length > 0
  const fingerprint = fingerprintOf(apply, archive, opts.skipBadRows)
  return {
    preview: {
      fingerprint, rows: parsed.rows, errors, warnings, skipped: skippedViews.length, canApply, archiveAllowed, counts, locations: views, archive,
      regionsToCreate, clustersToCreate,
    },
    apply,
  }
}

/** Channels 1..count of a recorder that get a new "Camera N": no active camera and never had one on that recorder (review I-3). */
function placeholdersFor(count: number, active: readonly SnapCamera[], ever: readonly number[]): number {
  const taken = new Set(active.map((c) => c.channel))
  const used = new Set(ever)
  let n = 0
  for (let ch = 1; ch <= Math.min(count, 999); ch++) if (!taken.has(ch) && !used.has(ch)) n++
  return n
}

/** A digest of what the apply would do (passwords only as "set"), the archive list and the mode: the same file on the same data gives the same value. */
function fingerprintOf(apply: ApplyPlan, archive: readonly ArchiveItem[], skipBadRows: boolean): string {
  const material = {
    skipBadRows,
    regions: apply.regions, clusters: apply.clusters,
    locations: apply.locations.map((l) => ({ ...l, recorders: l.recorders.map(({ password, ...r }) => ({ ...r, password: password === undefined ? 'unchanged' : 'set' })) })),
    archive: archive.map((a) => `${a.kind}:${a.id}`),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export type { RecorderRow }
