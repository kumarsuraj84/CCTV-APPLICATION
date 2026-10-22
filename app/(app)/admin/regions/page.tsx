import Link from 'next/link'
import { ArchiveButton } from '@/components/admin/inventory/ArchiveButton'
import { ClusterForm, RegionForm } from '@/components/admin/inventory/HierarchyForms'
import { MoveForm } from '@/components/admin/inventory/MoveForm'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { regionsAndClusters } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Regions and clusters' }
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// P2-5c-1 brief item 1 (ruling C-1): Organization → Region → Cluster → Location. Both levels are optional for every location. A
// cluster is moved to another region with the effect on access shown first; a region or cluster is archived only when empty.
export default async function RegionsPage() {
  const me = await requireAdministration('admin.inventory')
  const { regions, clusters, unclustered } = await regionsAndClusters(createAdminClient(), me.org_id)
  const liveRegions = regions.filter((r) => !r.archived_at)
  const regionName = new Map(regions.map((r) => [r.id, `${r.code} · ${r.name}`]))
  return (
    <div className="space-y-4">
      <PageHeader
        title="Regions and clusters"
        description="Group locations so people can be given a whole cluster or region at once. Optional: a location without a cluster works everywhere."
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: 'Regions and clusters' }]}
        actions={<Link href="/admin/regions/proposals" className={LINK}>Suggest clusters from zones</Link>}
      />
      <Section id="regions" title={`Regions (${liveRegions.length})`}>
        <ul className="space-y-3">
          {regions.map((r) => (
            <li key={r.id} className="space-y-2 rounded-md border p-3">
              <p className="text-sm text-muted-foreground">{r.clusters} {r.clusters === 1 ? 'cluster' : 'clusters'}{r.archived_at ? ' · archived' : ''}</p>
              {r.archived_at ? <p className="font-medium">{r.code} · {r.name}</p> : <RegionForm region={r} />}
              <ArchiveButton kind="region" id={r.id} archived={!!r.archived_at} name={`region ${r.code}`} />
            </li>
          ))}
        </ul>
        <div className="border-t pt-3"><h3 className="mb-2 text-sm font-semibold">Add a region</h3><RegionForm /></div>
      </Section>
      <Section id="clusters" title={`Clusters (${clusters.filter((c) => !c.archived_at).length})`} description={`${unclustered} ${unclustered === 1 ? 'location has' : 'locations have'} no cluster.`}>
        <ul className="space-y-3">
          {clusters.map((c) => (
            <li key={c.id} className="space-y-3 rounded-md border p-3">
              <p className="text-sm text-muted-foreground">{c.locations} {c.locations === 1 ? 'location' : 'locations'} · {c.region_id ? `region ${regionName.get(c.region_id) ?? ''}` : 'No region'}{c.archived_at ? ' · archived' : ''}</p>
              {c.archived_at ? <p className="font-medium">{c.code} · {c.name}</p> : (
                <>
                  <ClusterForm regions={liveRegions} cluster={c} />
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-sm font-medium">Move to another region</summary>
                    <div className="mt-3"><MoveForm kind="cluster" id={c.id} current={c.region_id} options={liveRegions.map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` }))} /></div>
                  </details>
                </>
              )}
              <ArchiveButton kind="cluster" id={c.id} archived={!!c.archived_at} name={`cluster ${c.code}`} />
            </li>
          ))}
        </ul>
        <div className="border-t pt-3"><h3 className="mb-2 text-sm font-semibold">Add a cluster</h3><ClusterForm regions={liveRegions} /></div>
      </Section>
    </div>
  )
}
