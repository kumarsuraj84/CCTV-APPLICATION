'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { saveClusterAction, saveRegionAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { Outcome, SelectField, TextField } from './fields'

const CODE_HELP = 'Letters, numbers and dashes, for example EAST or BR-NORTH. Kept when you rename.'

/** Add a region, or rename one (ruling C-1: the top level under the organisation; optional for every location). */
export function RegionForm({ region }: { region?: { id: string; code: string; name: string } }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(saveRegionAction, {})
  const p = region ? `region-${region.id}` : 'region-new'
  const v = (k: string, d: string | undefined) => state.values?.[k] ?? d ?? ''
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
      <input type="hidden" name="id" value={region?.id ?? ''} />
      <TextField id={`${p}-code`} name="code" label="Region code" required defaultValue={v('code', region?.code)} maxLength={50} help={region ? undefined : CODE_HELP} />
      <TextField id={`${p}-name`} name="name" label="Region name" required defaultValue={v('name', region?.name)} maxLength={200} placeholder="For example East" />
      <Button type="submit" disabled={pending} className="h-10">{pending ? 'Saving…' : region ? 'Save region' : 'Add region'}</Button>
      <div className="sm:col-span-3"><Outcome state={state} /></div>
    </form>
  )
}

/** Add a cluster (optionally in a region), or rename one. A cluster's region is changed with "Move" (its effect on access first). */
export function ClusterForm({ regions, cluster }: { regions: { id: string; code: string; name: string }[]; cluster?: { id: string; code: string; name: string; region_id: string | null } }) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(saveClusterAction, {})
  const p = cluster ? `cluster-${cluster.id}` : 'cluster-new'
  const v = (k: string, d: string | null | undefined) => state.values?.[k] ?? d ?? ''
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
      <input type="hidden" name="id" value={cluster?.id ?? ''} />
      <TextField id={`${p}-code`} name="code" label="Cluster code" required defaultValue={v('code', cluster?.code)} maxLength={50} help={cluster ? undefined : CODE_HELP} />
      <TextField id={`${p}-name`} name="name" label="Cluster name" required defaultValue={v('name', cluster?.name)} maxLength={200} placeholder="For example Patna city" />
      {!cluster && (
        <SelectField id={`${p}-region`} name="region_id" label="Region" defaultValue={v('region_id', null)} help="Optional. Leave as “No region” if it has none yet.">
          <option value="">No region</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
        </SelectField>
      )}
      <Button type="submit" disabled={pending} className="h-10">{pending ? 'Saving…' : cluster ? 'Save cluster' : 'Add cluster'}</Button>
      <div className="sm:col-span-2 lg:col-span-4"><Outcome state={state} /></div>
    </form>
  )
}
