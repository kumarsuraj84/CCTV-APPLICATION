'use client'

import { useActionState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { saveAssetAction } from '@/lib/actions/admin/assets'
import type { AdminActionState } from '@/lib/actions/admin/locations'
import { ASSET_TYPE_LABELS, ASSET_TYPES, CRITICALITIES, LIFECYCLE_LABELS, LIFECYCLE_STATES } from '@/lib/inventory/forms'
import { AreaField, CheckField, Outcome, SelectField, TextField } from './fields'

export type AssetFormValues = {
  id: string; name: string; type: string; location_id: string | null; ip: string | null; tcp_port: number | null; serial: string | null; mac: string | null
  vendor: string | null; model: string | null; firmware: string | null; role: string | null; owner: string | null; criticality: string | null
  lifecycle_state: string; warranty_until: string | null; management_mode: string | null; notes: string | null; enabled: boolean; address_space_id: string | null
}

const CRIT: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' }

/** An IT asset with its identity beyond the address (serial, MAC, vendor, model, firmware, role, owner, criticality, lifecycle, warranty). */
export function AssetForm({ asset, locations, spaces }: { asset?: AssetFormValues; locations: { id: string; code: string; name: string }[]; spaces: { id: string; name: string }[] }) {
  const router = useRouter()
  const [state, action, pending] = useActionState<AdminActionState, FormData>(async (prev, f) => {
    const res = await saveAssetAction(prev, f)
    if (res.ok && !asset && res.id) router.push(`/admin/assets/${res.id}`)
    return res
  }, {})
  const v = (k: keyof AssetFormValues | string, d: string | number | null | undefined) => state.values?.[k] ?? (d === null || d === undefined ? '' : String(d))
  const p = asset ? `asset-${asset.id}` : 'asset-new'
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={asset?.id ?? ''} />
      <TextField id={`${p}-name`} name="name" label="Name" required maxLength={200} defaultValue={v('name', asset?.name)} placeholder="For example Core switch" />
      <SelectField id={`${p}-type`} name="type" label="Type" required defaultValue={v('type', asset?.type ?? 'switch')}>
        {ASSET_TYPES.map((t) => <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>)}
      </SelectField>
      <SelectField id={`${p}-loc`} name="location_id" label="Location" defaultValue={v('location_id', asset?.location_id)}>
        <option value="">No location</option>
        {locations.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.name}</option>)}
      </SelectField>
      <TextField id={`${p}-ip`} name="ip" label="Management address" defaultValue={v('ip', asset?.ip)} placeholder="10.20.0.2" help="IP address; optional." />
      <TextField id={`${p}-port`} name="tcp_port" label="Port" inputMode="numeric" defaultValue={v('tcp_port', asset?.tcp_port)} help="Optional (for example 443)." />
      <SelectField id={`${p}-space`} name="address_space_id" label="Address space" defaultValue={v('address_space_id', asset?.address_space_id)} help="Where the address is unique. Usually the company network.">
        <option value="">Company network (default)</option>
        {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </SelectField>
      <TextField id={`${p}-serial`} name="serial" label="Serial number" defaultValue={v('serial', asset?.serial)} maxLength={200} />
      <TextField id={`${p}-mac`} name="mac" label="MAC address" defaultValue={v('mac', asset?.mac)} placeholder="aa:bb:cc:dd:ee:ff" />
      <TextField id={`${p}-vendor`} name="vendor" label="Vendor" defaultValue={v('vendor', asset?.vendor)} maxLength={100} />
      <TextField id={`${p}-model`} name="model" label="Model" defaultValue={v('model', asset?.model)} maxLength={100} />
      <TextField id={`${p}-fw`} name="firmware" label="Firmware" defaultValue={v('firmware', asset?.firmware)} maxLength={100} />
      <TextField id={`${p}-role`} name="role" label="Role" defaultValue={v('role', asset?.role)} maxLength={100} placeholder="For example access_point" />
      <TextField id={`${p}-owner`} name="owner" label="Owner" defaultValue={v('owner', asset?.owner)} maxLength={200} />
      <SelectField id={`${p}-crit`} name="criticality" label="Criticality" defaultValue={v('criticality', asset?.criticality)}>
        <option value="">Not set</option>
        {CRITICALITIES.map((c) => <option key={c} value={c}>{CRIT[c]}</option>)}
      </SelectField>
      <SelectField id={`${p}-life`} name="lifecycle_state" label="Lifecycle" defaultValue={v('lifecycle_state', asset?.lifecycle_state ?? 'active')}>
        {LIFECYCLE_STATES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
      </SelectField>
      <TextField id={`${p}-warranty`} name="warranty_until" label="Warranty until" type="date" defaultValue={v('warranty_until', asset?.warranty_until)} />
      <TextField id={`${p}-mode`} name="management_mode" label="Management mode" defaultValue={v('management_mode', asset?.management_mode)} maxLength={100} placeholder="For example standalone or cloud" />
      <AreaField id={`${p}-notes`} name="notes" label="Notes" className="sm:col-span-2" defaultValue={v('notes', asset?.notes)} maxLength={500} />
      <div className="self-end pb-2">
        <CheckField id={`${p}-enabled`} name="enabled" label="Switched on (monitored)" defaultChecked={state.values ? state.values.enabled === 'on' : (asset?.enabled ?? true)} />
      </div>
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : asset ? 'Save asset' : 'Add asset'}</Button>
        <Outcome state={state} />
      </div>
    </form>
  )
}
