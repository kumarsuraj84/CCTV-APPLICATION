'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { saveAccessAction } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
  initial: { storeIds: string[]; zones: string[]; cameraIds: string[] }
}) {
  const [storeIds, setStoreIds] = useState(new Set(props.initial.storeIds))
  const [zones, setZones] = useState(new Set(props.initial.zones))
  const [cameraIds, setCameraIds] = useState(new Set(props.initial.cameraIds))
  const [filter, setFilter] = useState('')
  const [cameraStore, setCameraStore] = useState('')
  const [pending, start] = useTransition()

  const allZones = useMemo(() => [...new Set(props.stores.map((s) => s.zone).filter((z): z is string => !!z))].sort(), [props.stores])
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
        A person sees all cameras of the stores and zones you tick. If you also tick individual cameras inside a store, they see only those cameras in that store.
        Cameras ticked on their own are visible even when the store is not ticked.
      </p>

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
