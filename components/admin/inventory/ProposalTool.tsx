'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { applyProposalsAction, type AdminActionState } from '@/lib/actions/admin/locations'
import type { ProposalRow } from '@/lib/inventory/hierarchy'
import { Outcome } from './fields'

/**
 * Zone → cluster, state → region proposals (P2-5c-1 brief item 7). Each row suggests codes from the location's zone and state; the
 * administrator can change the codes and ticks the rows to apply. Nothing is applied silently: unticked rows stay without a cluster.
 */
export function ProposalTool({ rows }: { rows: ProposalRow[] }) {
  const router = useRouter()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [codes, setCodes] = useState<Record<string, { cluster: string; region: string }>>(
    Object.fromEntries(rows.map((r) => [r.locationId, { cluster: r.proposedClusterCode ?? '', region: r.proposedRegionCode ?? '' }])),
  )
  const [state, setState] = useState<AdminActionState | null>(null)
  const [busy, start] = useTransition()
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const usable = rows.filter((r) => codes[r.locationId]?.cluster.trim())
  const apply = () =>
    start(async () => {
      const items = rows.filter((r) => picked.has(r.locationId)).map((r) => ({ locationId: r.locationId, clusterCode: codes[r.locationId].cluster.trim(), regionCode: codes[r.locationId].region.trim() || null }))
      const res = await applyProposalsAction(items)
      setState(res)
      if (res.ok) {
        setPicked(new Set())
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
      <div className="overflow-x-auto rounded-md border bg-card">
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
      <p className="text-xs text-muted-foreground">A cluster or region that does not exist yet is created with its code as its name (rename it afterwards). Moving a location into a cluster gives access to everybody with a grant at that cluster or its region.</p>
      <Button type="button" disabled={busy || picked.size === 0} onClick={apply}>{busy ? 'Applying…' : `Apply to ${picked.size} ticked ${picked.size === 1 ? 'location' : 'locations'}`}</Button>
      <Outcome state={state} />
    </div>
  )
}
