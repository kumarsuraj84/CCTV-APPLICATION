'use client'

import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { saveLocationAction, type AdminActionState } from '@/lib/actions/admin/locations'
import { displayName, LOCATION_KIND_LABELS, LOCATION_KINDS } from '@/lib/inventory/forms'
import { CheckField, Outcome, SelectField, TextField } from './fields'

export type LocationFormValues = { id: string; code: string; kind: string; name: string; city: string | null; address: string | null; zone: string | null; state: string | null; is_active: boolean }

/**
 * Add a location of any kind, or change one. The code is set once (e.g. JCL) and kept; the display name starts as "CODE - City" and
 * can be changed freely (the id, grants, groups and history stay). Cluster and region are optional; a new location may be put in a
 * cluster straight away, an existing one is moved with its effect on access shown first.
 */
export function LocationForm({ location, clusters }: { location?: LocationFormValues; clusters: { id: string; code: string; name: string; regionName: string | null }[] }) {
  const router = useRouter()
  const [state, action, pending] = useActionState<AdminActionState, FormData>(async (prev, f) => {
    const res = await saveLocationAction(prev, f)
    if (res.ok && !location && res.id) router.push(`/admin/locations/${res.id}`)
    return res
  }, {})
  const v = (k: string, d: string | null | undefined) => state.values?.[k] ?? d ?? ''
  const [code, setCode] = useState(v('code', location?.code))
  const [city, setCity] = useState(v('city', location?.city))
  const [name, setName] = useState(v('name', location?.name))
  const [nameTouched, setNameTouched] = useState(!!location)
  const p = location ? `loc-${location.id}` : 'loc-new'
  const suggested = displayName(code.trim().toUpperCase(), city)
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={location?.id ?? ''} />
      {location ? (
        <div className="space-y-1.5">
          <span className="block text-sm font-medium">Location code</span>
          <p className="font-mono text-base">{location.code}</p>
          <p className="text-xs text-muted-foreground">The code stays the same; change the display name instead.</p>
        </div>
      ) : (
        <TextField id={`${p}-code`} name="code" label="Location code" required maxLength={50} value={code} onChange={(e) => setCode(e.target.value)} placeholder="For example JCL" help="Letters, numbers and dashes. It cannot be changed later." />
      )}
      <SelectField id={`${p}-kind`} name="kind" label="Kind" required defaultValue={v('kind', location?.kind ?? 'store')}>
        {LOCATION_KINDS.map((k) => <option key={k} value={k}>{LOCATION_KIND_LABELS[k]}</option>)}
      </SelectField>
      <TextField id={`${p}-city`} name="city" label="City" value={city} onChange={(e) => setCity(e.target.value)} maxLength={200} />
      <TextField
        id={`${p}-name`} name="name" label="Display name" required maxLength={200} value={nameTouched ? name : suggested}
        onChange={(e) => { setNameTouched(true); setName(e.target.value) }} help="Shown everywhere; starts as “CODE - City”."
      />
      <TextField id={`${p}-address`} name="address" label="Address" defaultValue={v('address', location?.address)} maxLength={500} />
      <TextField id={`${p}-zone`} name="zone" label="Zone" defaultValue={v('zone', location?.zone)} maxLength={200} help="Optional, information only." />
      <TextField id={`${p}-state`} name="state" label="State" defaultValue={v('state', location?.state)} maxLength={200} help="Optional, information only." />
      {!location && (
        <SelectField id={`${p}-cluster`} name="cluster_id" label="Cluster" defaultValue={v('cluster_id', null)} help="Optional. “No cluster” is fine; you can group locations later.">
          <option value="">No cluster</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}{c.regionName ? ` (${c.regionName})` : ''}</option>)}
        </SelectField>
      )}
      <div className="self-end pb-2">
        <CheckField id={`${p}-active`} name="is_active" label="Switched on (monitored)" defaultChecked={state.values ? state.values.is_active === 'on' : (location?.is_active ?? true)} />
      </div>
      <div className="space-y-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : location ? 'Save changes' : 'Add location'}</Button>
        <Outcome state={state} />
      </div>
    </form>
  )
}
