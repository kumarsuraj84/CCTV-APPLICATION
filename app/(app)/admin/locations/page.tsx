import Link from 'next/link'
import { LocationForm } from '@/components/admin/inventory/LocationForm'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/select'
import { requireAdministration } from '@/lib/auth/profile'
import { LOCATION_KIND_LABELS, type LocationKind } from '@/lib/inventory/forms'
import { locationList, regionsAndClusters } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Locations and NVRs' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// P2-5c-1: locations of every kind with their NVRs. An administrative role AND admin.inventory (requireAdministration); only then is
// anything read with the service role, scoped to the organisation. Filters live in the URL (they survive back and reload).
export default async function LocationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const me = await requireAdministration('admin.inventory')
  const admin = createAdminClient()
  const archived = one(sp.archived) === '1'
  const q = one(sp.q).trim().toLowerCase()
  const cluster = one(sp.cluster)
  const [rows, tree] = await Promise.all([locationList(admin, me.org_id, { archived }), regionsAndClusters(admin, me.org_id)])
  const clusterName = new Map(tree.clusters.map((c) => [c.id, `${c.code} · ${c.name}`]))
  const regionName = new Map(tree.regions.map((r) => [r.id, r.name]))
  const shown = rows.filter((l) => (!q || `${l.code} ${l.name} ${l.city ?? ''}`.toLowerCase().includes(q)) && (!cluster || (cluster === 'none' ? !l.cluster_id : l.cluster_id === cluster)))
  const liveClusters = tree.clusters.filter((c) => !c.archived_at)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Locations and NVRs"
        description="Every kind of location (shops, head office, distribution centres, warehouses) with its NVRs. Region and cluster are optional."
        actions={<><Link href="/admin/regions" className={LINK}>Regions and clusters</Link><Link href="/admin/reconciliation" className={LINK}>Reconciliation</Link><Link href="/admin/locations/discover" className={LINK}>Find cameras for all</Link><Link href="/admin/import" className={LINK}>Import</Link></>}
      />
      <form method="get" className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <label htmlFor="loc-q" className="block text-sm font-medium">Find a location</label>
          <input id="loc-q" name="q" type="search" defaultValue={one(sp.q)} placeholder="Code, name or city" className="h-10 w-full rounded-sm border border-field-border bg-field px-3 text-base md:text-sm" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="loc-cluster" className="block text-sm font-medium">Cluster</label>
          <Select id="loc-cluster" name="cluster" defaultValue={cluster} className="h-10">
            <option value="">Any cluster</option>
            <option value="none">No cluster</option>
            {liveClusters.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="archived" value="1" defaultChecked={archived} className="size-4 accent-primary" /> Archived ones</label>
        <button type="submit" className="h-10 rounded-md border border-field-border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Show</button>
      </form>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="px-3 pt-2 text-left text-xs text-muted-foreground" aria-live="polite">Showing {shown.length} of {rows.length} {archived ? 'archived ' : ''}locations</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Code</th><th scope="col" className="px-3 py-2 font-medium">Name</th><th scope="col" className="px-3 py-2 font-medium">Kind</th>
              <th scope="col" className="px-3 py-2 font-medium">Cluster</th><th scope="col" className="px-3 py-2 text-right font-medium">NVRs</th><th scope="col" className="px-3 py-2 text-right font-medium">Cameras</th>
              <th scope="col" className="px-3 py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className="border-t hover:bg-muted/50">
                <td className="px-3 py-2 font-mono"><Link href={`/admin/locations/${l.id}`} className={LINK}>{l.code}</Link></td>
                <td className="px-3 py-2">{l.name}</td>
                <td className="px-3 py-2">{LOCATION_KIND_LABELS[l.kind as LocationKind] ?? l.kind}</td>
                <td className="px-3 py-2">{l.cluster_id ? clusterName.get(l.cluster_id) ?? '—' : 'No cluster'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.recorders}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.cameras}</td>
                <td className="px-3 py-2">{l.archived_at ? 'Archived' : l.is_active ? 'On' : 'Switched off'}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No location matches.</td></tr>}
          </tbody>
        </table>
      </div>
      {!archived && (
        <Section id="add-location" title="Add a location" description="Then add its NVRs on the location’s page. A head office or DC may have none.">
          <LocationForm clusters={liveClusters.map((c) => ({ id: c.id, code: c.code, name: c.name, regionName: c.region_id ? regionName.get(c.region_id) ?? null : null }))} />
        </Section>
      )}
    </div>
  )
}
