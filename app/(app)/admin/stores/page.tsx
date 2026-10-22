import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { StoreForm, type StoreFormValues } from '@/components/admin/StoreForm'
import { FindCamerasButton } from '@/components/monitor/FindCamerasButton'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteStoreAction } from '@/lib/actions/admin/inventory'
import { requireAdministration } from '@/lib/auth/profile'
import { pickPrimaries } from '@/lib/inventory/recorders'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage stores' }

type RecorderRow = {
  id: string; location_id: string; migrated_from_location_id: string | null; http_port: number; rtsp_port: number; username: string | null; expected_channels: number
  assets: { ip: string | null }
}

// P2-2: an administrative role AND admin.inventory. Only then are the NVR addresses and logins of the organisation read (service role,
// scoped to the organisation); the NVR password is never read here. P2-5b: a location's NVRs are recorders; this form edits the
// location and its primary recorder, and the list shows how many NVRs each location has.
export default async function ManageStoresPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdministration('admin.inventory')
  const admin = createAdminClient()
  const [stores, recorders] = await Promise.all([
    fetchAll((from, to) =>
      admin.from('locations').select('id, code, name, city, zone, state, address, is_active').eq('org_id', me.org_id).is('archived_at', null).order('code').order('id').range(from, to),
    ),
    fetchAll((from, to) =>
      admin.from('recorders').select('id, location_id, migrated_from_location_id, http_port, rtsp_port, username, expected_channels, assets!recorders_asset_fk!inner(ip, archived_at)')
        .eq('org_id', me.org_id).is('assets.archived_at', null).order('created_at').order('id').range(from, to),
    ),
  ])
  const rows = recorders as unknown as RecorderRow[]
  const primary = pickPrimaries(rows)
  const count = new Map<string, number>()
  for (const r of rows) count.set(r.location_id, (count.get(r.location_id) ?? 0) + 1)
  const formValues = (s: (typeof stores)[number]): StoreFormValues => {
    const p = primary.get(s.id)
    return { ...s, recorder: p ? { host: p.assets.ip, rtsp_port: p.rtsp_port, http_port: p.http_port, username: p.username, expected_channels: p.expected_channels } : null }
  }
  const editing = stores.find((s) => s.id === edit)
  return (
    <div className="space-y-6">
      <PageHeader title="Manage stores" description="Add a store by hand, or import many from the Import page." />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a store'}</h2>
        <StoreForm key={editing?.id ?? 'new'} store={editing ? formValues(editing) : undefined} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Zone</th><th className="px-3 py-2">NVR</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {stores.map((s) => {
              const p = primary.get(s.id)
              const more = (count.get(s.id) ?? 0) - 1
              return (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{s.code}</td>
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2">{s.zone ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono">{p?.assets.ip ?? '—'}</span>
                    {more > 0 && <span className="text-muted-foreground"> and {more} more {more === 1 ? 'NVR' : 'NVRs'}</span>}
                  </td>
                  <td className="space-x-2 px-3 py-2 text-right">
                    {p && <FindCamerasButton storeId={s.id} />}
                    <Link href={`/admin/stores?edit=${s.id}`} className="underline">Edit</Link>
                    <DeleteButton onDelete={deleteStoreAction.bind(null, s.id)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
