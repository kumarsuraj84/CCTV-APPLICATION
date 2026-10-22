'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { saveAccessAction } from '@/lib/actions/admin/users'
import type { OtherGrant } from '@/lib/admin/users'
import { formatDateTime } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const SOURCE_LABELS: Record<string, string> = {
  manual: 'Given by an administrator',
  'migrated:store': 'Moved over from an old store grant',
  'migrated:zone': 'Moved over from an old zone grant',
  'migrated:home': 'Moved over from the old home-store rule',
  'migrated:manager': 'Moved over from the old manager role',
  'migrated:camera': 'Moved over from an old camera grant',
  'migrated:admin': 'Moved over from the administrator role',
}

function validity(o: OtherGrant): string {
  if (o.state === 'expired') return `Expired ${formatDateTime(o.validUntil)}`
  if (o.state === 'future') return `Starts ${formatDateTime(o.validFrom)}${o.validUntil ? `, ends ${formatDateTime(o.validUntil)}` : ''}`
  return o.validUntil ? `Until ${formatDateTime(o.validUntil)}` : 'No end date'
}

/** Read-only: access this screen does not edit, so that none of it is invisible to the administrator (review fix I-4). */
function OtherAccess({ other }: { other: OtherGrant[] }) {
  if (other.length === 0) return null
  return (
    <section className="space-y-2" aria-labelledby="other-access">
      <h2 id="other-access" className="font-medium">Other access</h2>
      <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        This person also has access that this screen does not edit. Saving keeps it as it is.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Access</th><th className="px-3 py-2">Where</th><th className="px-3 py-2">When</th><th className="px-3 py-2">Came from</th></tr>
          </thead>
          <tbody>
            {other.map((o) => (
              <tr key={o.id} className="border-t">
                <td className="px-3 py-2">{o.capabilityLabel}</td>
                <td className="px-3 py-2">{o.scopeLabel}</td>
                <td className="px-3 py-2">{validity(o)}</td>
                <td className="px-3 py-2">
                  {SOURCE_LABELS[o.source] ?? o.source}
                  {o.needsReview && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">Please review</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

type StoreRef = { id: string; code: string; name: string; zone: string | null }
type CameraRef = { id: string; store_id: string; channel: number; name: string }

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function AccessEditor(props: {
  userId: string
  stores: StoreRef[]
  cameras: CameraRef[]
  initial: { storeIds: string[]; zones: string[]; cameraIds: string[]; other: OtherGrant[] }
}) {
  const [storeIds, setStoreIds] = useState(new Set(props.initial.storeIds))
  const [zones, setZones] = useState(new Set(props.initial.zones))
  const [cameraIds, setCameraIds] = useState(new Set(props.initial.cameraIds))
  const [filter, setFilter] = useState('')
  const [cameraStore, setCameraStore] = useState('')
  const [pending, start] = useTransition()

  // Saved zones that no store has any more stay listed, so they can be unticked.
  const allZones = useMemo(() => [...new Set([...props.stores.map((s) => s.zone).filter((z): z is string => !!z), ...props.initial.zones])].sort(), [props.stores, props.initial.zones])
  const shownStores = props.stores.filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(filter.toLowerCase()))
  const storeCameras = props.cameras.filter((c) => c.store_id === cameraStore)

  const save = () =>
    start(async () => {
      const res = await saveAccessAction(props.userId, { storeIds: [...storeIds], zones: [...zones], cameraIds: [...cameraIds] })
      if (res.error) toast.error(res.error)
      else toast.success('Access saved.')
    })

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        The person can watch live video and play back recordings of every camera of the stores you tick, including cameras added later.
        Ticking a zone ticks the stores that are in it now. Individual cameras add to that; they never take anything away.
        This list gives no IT devices and no other rights.
      </p>

      <OtherAccess other={props.initial.other} />

      <section className="space-y-2">
        <h2 className="font-medium">Zones</h2>
        <div className="flex flex-wrap gap-3">
          {allZones.map((z) => (
            <label key={z} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={zones.has(z)} onChange={() => setZones(toggled(zones, z))} /> {z}
            </label>
          ))}
          {allZones.length === 0 && <span className="text-sm text-muted-foreground">No zones yet.</span>}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Stores</h2>
        <Input placeholder="Search stores" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2 lg:grid-cols-3">
          {shownStores.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={storeIds.has(s.id)} onChange={() => setStoreIds(toggled(storeIds, s.id))} />
              {s.code} · {s.name}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Individual cameras</h2>
        <select value={cameraStore} onChange={(e) => setCameraStore(e.target.value)} className="h-8 rounded-lg border bg-background px-2 text-sm">
          <option value="">Choose a store…</option>
          {props.stores.map((s) => (
            <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
          ))}
        </select>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {storeCameras.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={cameraIds.has(c.id)} onChange={() => setCameraIds(toggled(cameraIds, c.id))} />
              {c.channel} · {c.name}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{cameraIds.size} individual camera(s) chosen in total.</p>
      </section>

      <Button onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save access'}</Button>
    </div>
  )
}
