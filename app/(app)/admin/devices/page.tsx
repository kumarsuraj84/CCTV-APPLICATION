import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { DeviceForm } from '@/components/admin/DeviceForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteDeviceAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage devices' }

export default async function ManageDevicesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdmin()
  const admin = createAdminClient()
  const [devices, stores] = await Promise.all([
    fetchAll((from, to) => admin.from('devices').select('id, store_id, type, name, ip, tcp_port, notes, enabled').eq('org_id', me.org_id).order('name').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('stores').select('id, code, name').eq('org_id', me.org_id).order('code').range(from, to)),
  ])
  const editing = devices.find((d) => d.id === edit)
  const storeName = new Map(stores.map((s) => [s.id, s.code]))
  return (
    <div className="space-y-6">
      <PageHeader title="Manage devices" description="Servers, attendance machines, footfall counters and any other device with an IP address." />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a device'}</h2>
        <DeviceForm key={editing?.id ?? 'new'} device={editing} stores={stores} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">Address</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                <td className="px-3 py-2">{d.store_id ? storeName.get(d.store_id) ?? '—' : '—'}</td>
                <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <Link href={`/admin/devices?edit=${d.id}`} className="underline">Edit</Link>
                  <DeleteButton onDelete={deleteDeviceAction.bind(null, d.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
