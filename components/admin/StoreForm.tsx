'use client'

import { useActionState } from 'react'
import { saveStoreAction, type FormResult } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type StoreFormValues = {
  id?: string; code?: string; name?: string; city?: string | null; zone?: string | null; state?: string | null; address?: string | null
  nvr_ip?: string; rtsp_port?: number; http_port?: number; nvr_username?: string; expected_channels?: number; is_active?: boolean
}

function Field({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
    </div>
  )
}

export function StoreForm({ store }: { store?: StoreFormValues }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(saveStoreAction, {})
  // After an error the form keeps what was typed (never the password, which stays empty).
  const v = (name: string, fallback: string | number | null | undefined) => state.values?.[name] ?? fallback ?? ''
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={store?.id ?? ''} />
      <Field id="name" label="Store name" defaultValue={v('name', store?.name)} required />
      <Field id="code" label="Store code" defaultValue={v('code', store?.code)} placeholder="Short code, e.g. MDB" disabled={!!store?.id} />
      <Field id="city" label="City" defaultValue={v('city', store?.city)} />
      <Field id="zone" label="Zone" defaultValue={v('zone', store?.zone)} />
      <Field id="state" label="State" defaultValue={v('state', store?.state)} />
      <Field id="address" label="Address" defaultValue={v('address', store?.address)} />
      <Field id="ip" label="NVR IP address" defaultValue={v('ip', store?.nvr_ip)} required />
      <Field id="rtsp_port" label="Video port" type="number" defaultValue={v('rtsp_port', store?.rtsp_port ?? 554)} />
      <Field id="http_port" label="Web port" type="number" defaultValue={v('http_port', store?.http_port ?? 80)} />
      <Field id="nvr_username" label="NVR user name" defaultValue={v('nvr_username', store?.nvr_username)} required />
      <Field id="nvr_password" label={store?.id ? 'NVR password (leave empty to keep it)' : 'NVR password'} type="password" autoComplete="new-password" required={!store?.id} />
      <Field id="channels" label="Number of cameras" type="number" defaultValue={v('channels', store?.expected_channels ?? 0)} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_active" defaultChecked={state.values ? state.values.is_active === 'on' : (store?.is_active ?? true)} /> Active
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{store?.id ? 'Save changes' : 'Add store'}</Button>
        {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="mt-2 text-sm">Saved.</p>}
      </div>
    </form>
  )
}
