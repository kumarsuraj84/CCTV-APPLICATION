'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { applyProposalsAction, previewProposalsAction, type AdminActionState, type PreviewProposalsState } from '@/lib/actions/admin/locations'
import type { ProposalRow } from '@/lib/inventory/hierarchy'
import { MSG_OPEN_VIDEO } from '@/lib/inventory/forms'
import { Outcome } from './fields'

const RIGHT: Record<string, string> = { 'cctv.live': 'live video', 'cctv.playback': 'recordings', 'cctv.export': 'export' }

/**
 * Zone → cluster, state → region proposals (P2-5c-1 brief item 7). Each row suggests codes from the location's zone and state; the
 * administrator can change the codes and ticks the rows to apply. Nothing is applied silently: "Check the effect" first shows who
 * gains or loses access and where an existing cluster is in another region (review M-1); "Apply" then does it in one transaction.
 */
export function ProposalTool({ rows }: { rows: ProposalRow[] }) {
  const router = useRouter()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [codes, setCodes] = useState<Record<string, { cluster: string; region: string }>>(
    Object.fromEntries(rows.map((r) => [r.locationId, { cluster: r.proposedClusterCode ?? '', region: r.proposedRegionCode ?? '' }])),
  )
  const [preview, setPreview] = useState<{ key: string; state: PreviewProposalsState } | null>(null)
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const usable = rows.filter((r) => codes[r.locationId]?.cluster.trim())
  const items = rows.filter((r) => picked.has(r.locationId)).map((r) => ({ locationId: r.locationId, clusterCode: codes[r.locationId].cluster.trim(), regionCode: codes[r.locationId].region.trim() || null }))
  const key = JSON.stringify(items)
  const checked = preview && preview.key === key && preview.state.ok ? preview.state : null
  const check = () => start(async () => { setState(null); setPreview({ key, state: await previewProposalsAction(items) }) })
  const apply = () =>
    start(async () => {
      const res = await applyProposalsAction(items)
      setState(res)
      if (res.ok) {
        setPicked(new Set())
        setPreview(null)
        router.refresh()
      }
    })
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Every location already has a cluster, or none has a zone or state to suggest one from.</p>
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setPicked(new Set(usable.map((r) => r.locationId)))}>Tick every row with a cluster code</Button>
        {picked.size > 0 && <Button type="button" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>}
      </div>
      <div className="relative overflow-x-auto rounded-md border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Suggested clusters and regions per location</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th scope="col" className="px-3 py-2 font-medium">Apply</th><th scope="col" className="px-3 py-2 font-medium">Location</th><th scope="col" className="px-3 py-2 font-medium">Zone / state</th><th scope="col" className="px-3 py-2 font-medium">Cluster code</th><th scope="col" className="px-3 py-2 font-medium">Region code</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.locationId} className="border-t">
                <td className="px-3 py-2"><input type="checkbox" className="size-4 accent-primary" checked={picked.has(r.locationId)} onChange={() => toggle(r.locationId)} aria-label={`Apply the suggestion for ${r.code}`} disabled={!codes[r.locationId]?.cluster.trim()} /></td>
                <td className="px-3 py-2 font-mono">{r.code}</td>
                <td className="px-3 py-2">{r.zone ?? '—'} / {r.state ?? '—'}</td>
                <td className="px-3 py-2"><input className="h-9 w-40 rounded-sm border border-field-border bg-field px-2" aria-label={`Cluster code for ${r.code}`} value={codes[r.locationId].cluster} onChange={(e) => setCodes((c) => ({ ...c, [r.locationId]: { ...c[r.locationId], cluster: e.target.value } }))} />{r.existingClusterId && <span className="ml-2 text-xs text-muted-foreground">exists</span>}</td>
                <td className="px-3 py-2"><input className="h-9 w-32 rounded-sm border border-field-border bg-field px-2" aria-label={`Region code for ${r.code}`} value={codes[r.locationId].region} onChange={(e) => setCodes((c) => ({ ...c, [r.locationId]: { ...c[r.locationId], region: e.target.value } }))} />{r.existingRegionId && <span className="ml-2 text-xs text-muted-foreground">exists</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">A cluster or region that does not exist yet is created with its code as its name (rename it afterwards). An existing cluster keeps its own region.</p>
      <Button type="button" variant="outline" disabled={busy || picked.size === 0} onClick={check}>{busy && !checked ? 'Checking…' : `Check the effect of ${picked.size} ticked ${picked.size === 1 ? 'row' : 'rows'}`}</Button>
      {preview && preview.key === key && !preview.state.ok && <Outcome state={{ error: preview.state.error }} />}
      {checked && (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{checked.affected === 0 ? 'Nobody’s access changes through a cluster or region grant.' : `${checked.affected} ${checked.affected === 1 ? 'person gains or loses' : 'people gain or lose'} access:`}</p>
          {checked.people.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {checked.people.map((p, i) => <li key={i}>{p.name}: {RIGHT[p.capability] ?? p.capability}, {p.before} → {p.after} cameras</li>)}
            </ul>
          )}
          {checked.newClusters.length > 0 && <p>New clusters: {checked.newClusters.join(', ')}.</p>}
          {checked.newRegions.length > 0 && <p>New regions: {checked.newRegions.join(', ')}.</p>}
          {checked.regionMismatches.map((m) => (
            <p key={m.clusterCode} className="text-warning-strong">Cluster {m.clusterCode} already exists in {m.actualRegion ? `region ${m.actualRegion}` : 'no region'}, not {m.proposedRegion}: it stays where it is.</p>
          ))}
          <p>{MSG_OPEN_VIDEO}</p>
          <Button type="button" disabled={busy} onClick={apply}>{busy ? 'Applying…' : 'Apply'}</Button>
        </div>
      )}
      <Outcome state={state} />
    </div>
  )
}
