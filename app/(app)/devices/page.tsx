import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { listVisibleDevices } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Devices' }

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams
  await requireProfile()
  const active = (DEVICE_TYPES as readonly string[]).includes(type ?? '') ? type : undefined
  const devices = await listVisibleDevices(await createClient(), active)
  return (
    <div className="space-y-4">
      <PageHeader title="Devices" description="Servers, attendance machines, footfall counters and other devices you can see." />
      <div className="flex flex-wrap gap-2 text-sm">
        <Link href="/devices" aria-current={!active ? 'page' : undefined} className={!active ? 'font-medium underline' : 'underline'}>All</Link>
        {DEVICE_TYPES.map((t) => (
          <Link key={t} href={`/devices?type=${t}`} aria-current={active === t ? 'page' : undefined} className={active === t ? 'font-medium underline' : 'underline'}>{DEVICE_TYPE_LABELS[t]}</Link>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">Address</th></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                <td className="px-3 py-2">{(d.stores as unknown as { code: string } | null)?.code ?? '—'}</td>
                <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No devices to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
