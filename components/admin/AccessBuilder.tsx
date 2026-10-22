'use client'

import { useMemo, useState } from 'react'
import {
  hasReason,
  istDate,
  matrixChanges,
  presetChanges,
  PRESETS,
  reasonRequired,
  type CatalogueEntry,
  type GrantChangeInput,
  type MatrixRow,
  type Preset,
} from '@/lib/admin/access-rules'
import type { Role } from '@/lib/admin/roles'
import { AREA_LABELS } from './access-labels'
import { BADGE, CHECK, FIELD, FOCUS, HELP, LABEL, TEXTAREA } from './fields'

export type LocationRef = { id: string; code: string; name: string }
export type CameraRef = { id: string; store_id: string; channel: number; name: string }
export type AssetRef = { id: string; store_id: string | null; name: string; type: string }
export type BuilderPrefill = { area: 'cctv' | 'it' | 'wifi' | 'admin'; mode: 'organization' | 'location' | 'camera' | 'asset'; capabilities: string[]; locationIds: string[] }

const SHOW_MAX = 300
const toggle = (s: ReadonlySet<string>, id: string, on?: boolean) => {
  const n = new Set(s)
  if (on ?? !n.has(id)) n.add(id)
  else n.delete(id)
  return n
}
const SHORT: Record<string, string> = { 'cctv.live': 'Live', 'cctv.playback': 'Playback', 'cctv.export': 'Export' }

/**
 * "Add access" (P2-3, AC-5): every assignment case of the directive as plain choices that expand into explicit grants —
 * all cameras of chosen locations (including later ones), selected cameras across locations (new cameras are not included),
 * the whole organisation, and a coverage × right matrix (live, playback and export independently). Presets only fill the matrix or
 * the list; they are never stored as roles.
 */
export function AccessBuilder(props: {
  catalogue: CatalogueEntry[]
  grantable: string[]
  targetRole: Role
  locations: LocationRef[]
  cameras: CameraRef[]
  assets: AssetRef[]
  prefill?: BuilderPrefill | null
  onAdd: (changes: GrantChangeInput[]) => void
}) {
  const capsOf = (area: string) => props.catalogue.filter((c) => c.area === area && props.grantable.includes(c.key))
  const areas = (['cctv', 'it', 'wifi', 'admin'] as const).filter((a) => capsOf(a).length > 0 || (a === 'admin' && fullRights(props)))
  const [area, setArea] = useState<(typeof areas)[number] | undefined>(props.prefill?.area && areas.includes(props.prefill.area) ? props.prefill.area : areas[0])
  const [mode, setMode] = useState<BuilderPrefill['mode']>(props.prefill?.mode ?? 'location')
  const [locs, setLocs] = useState<ReadonlySet<string>>(new Set(props.prefill?.mode === 'location' ? props.prefill.locationIds : []))
  const [cams, setCams] = useState<ReadonlySet<string>>(new Set())
  const [assets, setAssets] = useState<ReadonlySet<string>>(new Set())
  const [wholeOrg, setWholeOrg] = useState(props.prefill?.mode === 'organization')
  const [ticks, setTicks] = useState<Record<string, ReadonlySet<string>>>({})
  const [areaCaps, setAreaCaps] = useState<ReadonlySet<string>>(new Set(props.prefill && props.prefill.area !== 'cctv' ? props.prefill.capabilities : []))
  const [search, setSearch] = useState('')
  const [openLoc, setOpenLoc] = useState<string | null>(props.prefill?.mode === 'camera' ? props.prefill.locationIds[0] ?? null : null)
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const today = istDate(new Date())

  const locById = useMemo(() => new Map(props.locations.map((l) => [l.id, l])), [props.locations])
  const camsByLoc = useMemo(() => {
    const m = new Map<string, CameraRef[]>()
    for (const c of props.cameras) m.set(c.store_id, [...(m.get(c.store_id) ?? []), c])
    return m
  }, [props.cameras])
  const q = search.trim().toLowerCase()
  const shownLocs = props.locations.filter((l) => !q || `${l.code} ${l.name}`.toLowerCase().includes(q)).slice(0, SHOW_MAX)
  const shownAssets = props.assets.filter((a) => !q || `${a.name} ${a.type} ${a.store_id ? locById.get(a.store_id)?.code ?? '' : ''}`.toLowerCase().includes(q)).slice(0, SHOW_MAX)
  const camLocs = props.locations.filter((l) => (camsByLoc.get(l.id)?.length ?? 0) > 0 && (!q || `${l.code} ${l.name}`.toLowerCase().includes(q) || (camsByLoc.get(l.id) ?? []).some((c) => c.name.toLowerCase().includes(q))))

  const cctvCaps = capsOf('cctv')
  // Matrix rows for CCTV: the organisation, each whole location, and per location the cameras chosen one by one.
  const rows: { key: string; label: string; help: string; build: (caps: string[]) => MatrixRow[] }[] = []
  if (wholeOrg) rows.push({ key: 'org', label: 'Whole organisation', help: 'Every camera, including ones added later', build: (caps) => [{ scope_kind: 'organization', scope_id: null, capabilities: caps }] })
  for (const id of locs) {
    const l = locById.get(id)
    if (l) rows.push({ key: `loc:${id}`, label: `${l.code} · ${l.name}`, help: 'All cameras, including ones added later', build: (caps) => [{ scope_kind: 'location', scope_id: id, capabilities: caps }] })
  }
  for (const l of props.locations) {
    const chosen = (camsByLoc.get(l.id) ?? []).filter((c) => cams.has(c.id))
    if (chosen.length) {
      rows.push({
        key: `cams:${l.id}`, label: `${l.code} · ${chosen.length} selected ${chosen.length === 1 ? 'camera' : 'cameras'}`, help: 'Only these cameras; new cameras are not included',
        build: (caps) => chosen.map((c) => ({ scope_kind: 'camera', scope_id: c.id, capabilities: caps })),
      })
    }
  }
  const tick = (rowKey: string, cap: string, on: boolean) => setTicks((t) => ({ ...t, [rowKey]: toggle(t[rowKey] ?? new Set(), cap, on) }))
  const tickAll = (caps: readonly string[]) => setTicks(Object.fromEntries(rows.map((r) => [r.key, new Set([...(ticks[r.key] ?? []), ...caps.filter((c) => props.grantable.includes(c))])])))

  const needsReason = (keys: string[]) => keys.some((k) => {
    const c = props.catalogue.find((x) => x.key === k)
    return c ? reasonRequired(c) : false
  })

  const finish = (changes: GrantChangeInput[]) => {
    if (changes.length === 0) {
      setError(area === 'cctv' ? 'Choose where (organisation, locations or cameras) and tick at least one right.' : 'Choose at least one right and where it applies.')
      return
    }
    if (needsReason(changes.map((c) => c.capability)) && !hasReason(reason)) {
      setError('Give a reason: it is required for export and for high-risk rights.')
      return
    }
    setError(null)
    props.onAdd(changes)
    setTicks({})
    setAreaCaps(new Set())
  }

  const addCctv = () => {
    const matrix = rows.flatMap((r) => r.build([...(ticks[r.key] ?? [])]))
    finish(matrixChanges(matrix, until || null, reason.trim()))
  }
  const addArea = () => {
    const caps = [...areaCaps]
    const matrix: MatrixRow[] =
      area === 'admin' || mode === 'organization' ? [{ scope_kind: 'organization', scope_id: null, capabilities: caps }]
        : mode === 'asset' ? [...assets].map((id) => ({ scope_kind: 'asset', scope_id: id, capabilities: caps }))
          : [...locs].map((id) => ({ scope_kind: 'location', scope_id: id, capabilities: caps }))
    finish(caps.length === 0 ? [] : matrixChanges(matrix, until || null, reason.trim()))
  }
  const addPreset = (p: Preset) => {
    finish(presetChanges(p, { locations: [...locs], catalogue: props.catalogue, grantable: props.grantable, validUntil: until || null, reason: reason.trim() }))
  }

  if (!area) return <p className="text-sm text-muted-foreground">There are no rights you may give this person.</p>

  const radio = (value: BuilderPrefill['mode'], label: string, help: string) => (
    <label className="flex items-start gap-2 rounded-lg border border-[#7C8795] p-3 text-sm has-[:checked]:border-[var(--ring)] has-[:checked]:bg-[var(--secondary)]">
      <input type="radio" name="coverage-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setWholeOrg(value === 'organization' ? true : wholeOrg) }} className={`mt-0.5 ${CHECK}`} />
      <span><span className="font-medium">{label}</span><span className={`block ${HELP}`}>{help}</span></span>
    </label>
  )
  const orgPresets = PRESETS.filter((p) => p.organisationWide && (!p.forRoles || p.forRoles.includes(props.targetRole)))

  return (
    <section aria-labelledby="add-access" className="space-y-4 rounded-xl border bg-card p-4">
      <h2 id="add-access" className="text-base font-semibold">Add access</h2>
      <div role="group" aria-label="Area" className="flex flex-wrap gap-2">
        {areas.map((a) => (
          <button key={a} type="button" aria-pressed={area === a} onClick={() => { setArea(a); setError(null); setMode(a === 'cctv' ? 'location' : 'organization') }}
            className={`rounded-md border px-3 py-1.5 text-sm ${area === a ? 'border-[var(--ring)] bg-[var(--secondary)] font-semibold' : 'border-[#7C8795]'} ${FOCUS}`}>
            {AREA_LABELS[a]}
          </button>
        ))}
      </div>

      {area !== 'admin' && (
        <fieldset className="space-y-2">
          <legend className={LABEL}>Where</legend>
          <div className="grid gap-2 md:grid-cols-3">
            {area === 'cctv'
              ? <>{radio('location', 'All cameras in these locations', 'Includes cameras added to the location later.')}
                {radio('camera', 'Selected cameras', 'Exactly the cameras you pick, across any locations. New cameras are NOT included automatically.')}
                {radio('organization', 'Whole organisation', 'Every camera of every location, now and later.')}</>
              : <>{radio('location', 'All assets in these locations', 'Includes assets added to the location later.')}
                {radio('asset', 'Selected assets', 'Exactly the assets you pick. New assets are not included automatically.')}
                {radio('organization', 'Whole organisation', 'Every location and asset, now and later.')}</>}
          </div>
        </fieldset>
      )}

      {area !== 'admin' && mode !== 'organization' && (
        <div className="space-y-2">
          <label htmlFor="access-search" className={LABEL}>{mode === 'camera' ? 'Find locations or cameras' : mode === 'asset' ? 'Find assets' : 'Find locations'}</label>
          <input id="access-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="For example DEMO1 or Entrance" className={`${FIELD} max-w-md`} />
        </div>
      )}

      {area === 'cctv' && mode === 'organization' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className={CHECK} checked={wholeOrg} onChange={(e) => setWholeOrg(e.target.checked)} />
          Include the whole organisation as a row below
        </label>
      )}

      {area !== 'admin' && mode === 'location' && (
        <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
          <legend className="sr-only">Locations</legend>
          {shownLocs.length === 0 && <p className="text-sm text-muted-foreground">No location matches.</p>}
          {shownLocs.map((l) => (
            <label key={l.id} className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" className={CHECK} checked={locs.has(l.id)} onChange={() => setLocs(toggle(locs, l.id))} />
              {l.code} · {l.name}
            </label>
          ))}
        </fieldset>
      )}

      {area === 'cctv' && mode === 'camera' && (
        <div className="space-y-2">
          <p role="note" className="rounded-lg border border-amber-700/40 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            Selected cameras are exactly these cameras. Cameras added to a location later are not included. To include them, use “All cameras in these locations”.
          </p>
          <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-2">
            {camLocs.length === 0 && <p className="text-sm text-muted-foreground">No camera matches.</p>}
            {camLocs.slice(0, SHOW_MAX).map((l) => {
              const list = camsByLoc.get(l.id) ?? []
              const chosen = list.filter((c) => cams.has(c.id)).length
              const all = chosen === list.length
              return (
                <div key={l.id} className="rounded-md border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input type="checkbox" className={CHECK} checked={all} ref={(el) => { if (el) el.indeterminate = chosen > 0 && !all }}
                        onChange={() => setCams(list.reduce((s, c) => toggle(s, c.id, !all), cams))} />
                      Select all {list.length} cameras of {l.code} · {l.name}
                    </label>
                    <button type="button" aria-expanded={openLoc === l.id} onClick={() => setOpenLoc(openLoc === l.id ? null : l.id)} className={`rounded-md px-2 py-1 text-sm underline ${FOCUS}`}>
                      {openLoc === l.id ? 'Hide cameras' : `Choose cameras (${chosen} chosen)`}
                    </button>
                  </div>
                  {(openLoc === l.id || (q && list.some((c) => c.name.toLowerCase().includes(q)))) && (
                    <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {list.filter((c) => openLoc === l.id || c.name.toLowerCase().includes(q)).map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" className={CHECK} checked={cams.has(c.id)} onChange={() => setCams(toggle(cams, c.id))} />
                          {c.channel} · {c.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className={HELP}>{cams.size} {cams.size === 1 ? 'camera' : 'cameras'} chosen in total.</p>
        </div>
      )}

      {area !== 'cctv' && area !== 'admin' && mode === 'asset' && (
        <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
          <legend className="sr-only">Assets</legend>
          {shownAssets.length === 0 && <p className="text-sm text-muted-foreground">No asset matches.</p>}
          {shownAssets.map((a) => (
            <label key={a.id} className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" className={CHECK} checked={assets.has(a.id)} onChange={() => setAssets(toggle(assets, a.id))} />
              {a.name} ({a.type}){a.store_id ? ` · ${locById.get(a.store_id)?.code ?? ''}` : ''}
            </label>
          ))}
        </fieldset>
      )}

      {area === 'cctv' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={LABEL}>Rights for each place</h3>
            <button type="button" onClick={() => tickAll(PRESETS.find((p) => p.id === 'store-viewer')!.capabilities)} disabled={rows.length === 0}
              className={`rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:text-[#5B646F] ${FOCUS}`}>
              Preset: Location CCTV viewer (live + playback)
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Choose the organisation, locations or cameras above; they appear here as rows.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <caption className="sr-only">Coverage and rights: tick each right for each place</caption>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Place</th>
                    {cctvCaps.map((c) => <th key={c.key} scope="col" className="px-3 py-2 text-center font-medium">{SHORT[c.key] ?? c.description}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-t">
                      <th scope="row" className="px-3 py-2 text-left font-normal"><div className="font-medium">{r.label}</div><div className={HELP}>{r.help}</div></th>
                      {cctvCaps.map((c) => (
                        <td key={c.key} className="px-3 py-2 text-center">
                          <input type="checkbox" className={CHECK} aria-label={`${SHORT[c.key] ?? c.description} for ${r.label}`} checked={ticks[r.key]?.has(c.key) ?? false} onChange={(e) => tick(r.key, c.key, e.target.checked)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={HELP}>Live, playback and export are separate: for example live for a whole location and export for two of its cameras only.</p>
          {props.targetRole !== 'admin' && props.targetRole !== 'platform_owner' && (
            <p className={HELP}>Downloads (export) can only be given to administrators and super administrators, so they are not offered for this person.</p>
          )}
        </div>
      )}

      {area !== 'cctv' && (
        <fieldset className="space-y-1">
          <legend className={LABEL}>Rights</legend>
          {area === 'it' && (
            <button type="button" onClick={() => setAreaCaps(new Set(PRESETS.find((p) => p.id === 'store-it-viewer')!.capabilities.filter((k) => props.grantable.includes(k))))}
              className={`mb-1 rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted ${FOCUS}`}>Preset: Location IT viewer</button>
          )}
          <div className="grid gap-1 sm:grid-cols-2">
            {capsOf(area).map((c) => (
              <label key={c.key} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className={`mt-0.5 ${CHECK}`} checked={areaCaps.has(c.key)} onChange={() => setAreaCaps(toggle(areaCaps, c.key))} />
                <span>{c.description} {c.risk === 'high' && <span className={BADGE.danger}>High risk</span>}<span className={`block ${HELP}`}>{c.key}</span></span>
              </label>
            ))}
          </div>
          {area === 'admin' && <p className={HELP}>Administration rights apply to the whole organisation and only to administrators and super administrators.</p>}
        </fieldset>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="access-until" className={LABEL}>Valid until (optional)</label>
          <input id="access-until" type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} className={FIELD} aria-describedby="access-until-help" />
          <p id="access-until-help" className={HELP}>Access ends at midnight India time after this day. Leave empty for no end date.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="access-reason" className={LABEL}>Reason</label>
          <textarea id="access-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={TEXTAREA} aria-describedby="access-reason-help" placeholder="For example: Location manager of DEMO1" />
          <p id="access-reason-help" className={HELP}>Required for export and for high-risk rights. Kept with the grant.</p>
        </div>
      </div>

      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={area === 'cctv' ? addCctv : addArea} className={`rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/85 ${FOCUS}`}>
          Add to the list of changes
        </button>
        {area === 'admin' && orgPresets.map((p) => (
          <button key={p.id} type="button" onClick={() => addPreset(p)} className={`rounded-md border border-[#7C8795] px-3 py-2 text-sm hover:bg-muted ${FOCUS}`} title={p.help}>
            Add preset: {p.label}
          </button>
        ))}
      </div>
      {area === 'admin' && orgPresets.map((p) => <p key={p.id} className={HELP}><span className="font-medium">{p.label}:</span> {p.help}</p>)}
    </section>
  )
}

function fullRights(p: { targetRole: Role }) {
  return p.targetRole === 'platform_owner'
}
