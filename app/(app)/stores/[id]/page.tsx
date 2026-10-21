import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { getVisibleStore } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Store' }

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireProfile()
  const store = await getVisibleStore(await createClient(), id)
  if (!store) notFound()
  return (
    <div className="space-y-6">
      <PageHeader title={`${store.code} · ${store.name}`} description={[store.city, store.zone].filter(Boolean).join(' · ')} />
      <section>
        <h2 className="mb-2 font-medium">Cameras ({store.cameras.length})</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {store.cameras.map((c) => (
            <div key={c.id} className="rounded-lg border bg-card p-3 text-sm">
              <div className="font-medium">{c.channel} · {c.name}</div>
              <div className="text-muted-foreground">{c.camera_ip ?? 'Address not known yet'}</div>
            </div>
          ))}
          {store.cameras.length === 0 && <p className="text-sm text-muted-foreground">No cameras to show.</p>}
        </div>
      </section>
      {store.devices.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">Devices</h2>
          <ul className="space-y-1 text-sm">
            {store.devices.map((d) => (
              <li key={d.id}>{d.name} · {DEVICE_TYPE_LABELS[d.type as DeviceType]} · <span className="font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
