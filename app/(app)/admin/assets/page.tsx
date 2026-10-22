import Link from 'next/link'
import { AssetForm } from '@/components/admin/inventory/AssetForm'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { ASSET_TYPE_LABELS, LIFECYCLE_LABELS, type AssetType } from '@/lib/inventory/forms'
import { assetList } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Assets' }
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// P2-5c-1 brief item 4: the IT asset inventory with the new attributes. NVRs are recorders and live on their location's page.
export default async function AssetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const me = await requireAdministration('admin.inventory')
  const admin = createAdminClient()
  const archived = one(sp.archived) === '1'
  const q = one(sp.q).trim().toLowerCase()
  const type = one(sp.type)
  const [rows, locations, spaces] = await Promise.all([
    assetList(admin, me.org_id, { archived }),
    fetchAll((from, to) => admin.from('locations').select('id, code, name').eq('org_id', me.org_id).is('archived_at', null).order('code').order('id').range(from, to)),
    admin.from('address_spaces').select('id, name, kind').eq('org_id', me.org_id).neq('kind', 'location_nat').order('name'),
  ])
  const code = new Map(locations.map((l) => [l.id, l.code]))
  const shown = rows.filter((a) => (!type || a.type === type) && (!q || `${a.name} ${a.vendor ?? ''} ${a.model ?? ''} ${a.serial ?? ''} ${a.ip ?? ''} ${a.location_id ? code.get(a.location_id) ?? '' : ''}`.toLowerCase().includes(q)))
  return (
    <div className="space-y-4">
      <PageHeader title="Assets" description="Switches, access points, routers, SD-WAN edges, UPS, PCs and other IT assets, with what they depend on and their addresses." />
      <form method="get" className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <label htmlFor="asset-q" className="block text-sm font-medium">Find an asset</label>
          <input id="asset-q" name="q" type="search" defaultValue={one(sp.q)} placeholder="Name, vendor, model, serial, address or location" className="h-10 w-full rounded-sm border border-field-border bg-field px-3 text-base md:text-sm" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="asset-type" className="block text-sm font-medium">Type</label>
          <select id="asset-type" name="type" defaultValue={type} className="h-10 w-full rounded-sm border border-field-border bg-field px-3 text-base md:text-sm">
            <option value="">Any type</option>
            {Object.entries(ASSET_TYPE_LABELS).filter(([k]) => k !== 'nvr').map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="archived" value="1" defaultChecked={archived} className="size-4 accent-primary" /> Archived ones</label>
        <button type="submit" className="h-10 rounded-md border border-field-border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Show</button>
      </form>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="px-3 pt-2 text-left text-xs text-muted-foreground" aria-live="polite">Showing {shown.length} of {rows.length} {archived ? 'archived ' : ''}assets</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th scope="col" className="px-3 py-2 font-medium">Name</th><th scope="col" className="px-3 py-2 font-medium">Type</th><th scope="col" className="px-3 py-2 font-medium">Location</th><th scope="col" className="px-3 py-2 font-medium">Vendor · model</th><th scope="col" className="px-3 py-2 font-medium">Firmware</th><th scope="col" className="px-3 py-2 font-medium">Address</th><th scope="col" className="px-3 py-2 font-medium">Lifecycle</th></tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id} className="border-t hover:bg-muted/50">
                <td className="px-3 py-2"><Link href={`/admin/assets/${a.id}`} className={LINK}>{a.name}</Link></td>
                <td className="px-3 py-2">{ASSET_TYPE_LABELS[a.type as AssetType] ?? a.type}</td>
                <td className="px-3 py-2 font-mono">{a.location_id ? code.get(a.location_id) ?? '—' : '—'}</td>
                <td className="px-3 py-2">{[a.vendor, a.model].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-3 py-2">{a.firmware ?? '—'}</td>
                <td className="px-3 py-2 font-mono">{a.ip ?? '—'}</td>
                <td className="px-3 py-2">{a.archived_at ? 'Archived' : LIFECYCLE_LABELS[a.lifecycle_state as keyof typeof LIFECYCLE_LABELS] ?? a.lifecycle_state}{!a.archived_at && !a.enabled ? ' (switched off)' : ''}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No asset matches.</td></tr>}
          </tbody>
        </table>
      </div>
      {!archived && (
        <Section id="add-asset" title="Add an asset"><AssetForm locations={locations} spaces={(spaces.data ?? []).map((s) => ({ id: s.id, name: s.name }))} /></Section>
      )}
    </div>
  )
}
