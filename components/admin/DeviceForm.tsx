'use client'

import { useActionState } from 'react'
import { saveDeviceAction, type FormResult } from '@/lib/actions/admin/inventory'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from '@/lib/inventory/device-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type DeviceFormValues = { id?: string; name?: string; type?: string; store_id?: string | null; ip?: string | null; tcp_port?: number | null; notes?: string | null; enabled?: boolean }

export function DeviceForm({ device, stores }: { device?: DeviceFormValues; stores: { id: string; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(saveDeviceAction, {})
  // After an error the form keeps what was typed.
  const v = (name: string, fallback: string | number | null | undefined) => state.values?.[name] ?? fallback ?? ''
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={device?.id ?? ''} />
      <div className="space-y-1.5">
        <Label htmlFor="name">Device name</Label>
        <Input id="name" name="name" defaultValue={v('name', device?.name)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="type">Type</Label>
        <select id="type" name="type" defaultValue={v('type', device?.type ?? 'server')} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
          {DEVICE_TYPES.map((t) => (<option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="store_id">Location</Label>
        <select id="store_id" name="store_id" defaultValue={v('store_id', device?.store_id)} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
          <option value="">Not at a location</option>
          {stores.map((s) => (<option key={s.id} value={s.id}>{s.code} · {s.name}</option>))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ip">IP address</Label>
        <Input id="ip" name="ip" defaultValue={v('ip', device?.ip)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tcp_port">Port to check (optional)</Label>
        <Input id="tcp_port" name="tcp_port" type="number" defaultValue={v('tcp_port', device?.tcp_port)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Input id="notes" name="notes" defaultValue={v('notes', device?.notes)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={state.values ? state.values.enabled === 'on' : (device?.enabled ?? true)} /> Check this device
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{device?.id ? 'Save changes' : 'Add device'}</Button>
        {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="mt-2 text-sm">Saved.</p>}
      </div>
    </form>
  )
}
