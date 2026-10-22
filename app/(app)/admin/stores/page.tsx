import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { StoreForm } from '@/components/admin/StoreForm'
import { FindCamerasButton } from '@/components/monitor/FindCamerasButton'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteStoreAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage stores' }

export default async function ManageStoresPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdmin()
  const admin = createAdminClient()
  const stores = await fetchAll((from, to) =>
    admin.from('stores').select('id, code, name, city, zone, state, address, nvr_ip, rtsp_port, http_port, nvr_username, expected_channels, is_active').eq('org_id', me.org_id).order('code').range(from, to),
  )
  const editing = stores.find((s) => s.id === edit)
  return (
    <div className="space-y-6">
      <PageHeader title="Manage stores" description="Add a store by hand, or import many from the Import page." />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a store'}</h2>
        <StoreForm key={editing?.id ?? 'new'} store={editing} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Zone</th><th className="px-3 py-2">NVR</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-2 font-mono">{s.code}</td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2">{s.zone ?? '—'}</td>
                <td className="px-3 py-2 font-mono">{s.nvr_ip}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <FindCamerasButton storeId={s.id} />
                  <Link href={`/admin/stores?edit=${s.id}`} className="underline">Edit</Link>
                  <DeleteButton onDelete={deleteStoreAction.bind(null, s.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
