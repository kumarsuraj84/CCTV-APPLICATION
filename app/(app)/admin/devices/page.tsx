import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { DeviceForm } from '@/components/admin/DeviceForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteDeviceAction } from '@/lib/actions/admin/inventory'
import { requireAdministration } from '@/lib/auth/profile'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage devices' }

const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export default async function ManageDevicesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdministration('admin.inventory') // P2-2: an administrative role AND admin.inventory
  const admin = createAdminClient()
  const [devices, stores] = await Promise.all([
    // P2-5a: devices are assets (archived ones are history); a location's NVRs are recorders, managed with the location.
    // Final fix Y (final review C I-7): only the device types of this page; access points, switches, routers and other equipment are
    // changed under Assets (the form offers only these types, so saving another kind here would have retyped it).
    fetchAll((from, to) => admin.from('assets').select('id, store_id:location_id, type, name, ip, tcp_port, notes, enabled').eq('org_id', me.org_id).is('archived_at', null).eq('is_recorder', false).in('type', [...DEVICE_TYPES]).order('name').order('id').range(from, to)),
    fetchAll((from, to) => admin.from('locations').select('id, code, name').eq('org_id', me.org_id).is('archived_at', null).order('code').range(from, to)),
  ])
  const editing = devices.find((d) => d.id === edit)
  const storeName = new Map(stores.map((s) => [s.id, s.code]))
  return (
    <div className="space-y-6">
      <PageHeader title="Manage devices" description="Servers, attendance machines, footfall counters and any other device with an IP address." />
      <p className="text-sm text-muted-foreground">
        Access points, switches, routers and other network equipment are changed under <Link href="/admin/assets" className={LINK}>Assets</Link>.
      </p>
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a device'}</h2>
        <DeviceForm key={editing?.id ?? 'new'} device={editing} stores={stores} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <caption className="sr-only">Devices</caption>
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Type</th><th scope="col" className="px-3 py-2">Location</th>
              <th scope="col" className="px-3 py-2">Address</th><th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                <td className="px-3 py-2">{d.store_id ? storeName.get(d.store_id) ?? '—' : '—'}</td>
                <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
                <td className="space-x-2 whitespace-nowrap px-3 py-2 text-right">
                  <Link href={`/admin/devices?edit=${d.id}`} className="underline" aria-label={`Edit ${d.name}`}>Edit</Link>
                  {/* Final fix Y (C M-17): this archives (history and grants are kept); the button says so and names the device. */}
                  <DeleteButton onDelete={deleteDeviceAction.bind(null, d.id)} label="Archive" confirmLabel="Yes, archive" doneMessage="Archived." itemName={d.name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
