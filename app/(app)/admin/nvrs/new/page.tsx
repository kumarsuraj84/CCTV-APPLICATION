import Link from 'next/link'
import { z } from 'zod'
import { RecorderForm } from '@/components/admin/inventory/RecorderForm'
import { Section, SelectField } from '@/components/admin/inventory/fields'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { locationTitle } from '@/lib/inventory/forms'
import { locationList, regionsAndClusters } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Add NVR' }
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const NO_CLUSTER = 'none'

// Add NVR (CCTV Monitoring): the cluster, then the location in it, then the NVR's own details. Plain links and GET forms, so it works
// without script; the NVR itself is saved by the same form and action as on the location page (an NVR always belongs to one location,
// which keeps the tree Organization > Region > Cluster > Location > NVR > Camera). Administrative role AND admin.inventory.
export default async function AddNvrPage({ searchParams }: { searchParams: Promise<{ cluster?: string; location?: string }> }) {
  const sp = await searchParams
  const me = await requireAdministration('admin.inventory')
  const admin = createAdminClient()
  const [tree, locations] = await Promise.all([regionsAndClusters(admin, me.org_id), locationList(admin, me.org_id, { archived: false })])
  const clusters = tree.clusters.filter((c) => !c.archived_at)
  const regionName = new Map(tree.regions.map((r) => [r.id, r.name]))

  const clusterParam = sp.cluster === NO_CLUSTER ? NO_CLUSTER : z.uuid().safeParse(sp.cluster).success && clusters.some((c) => c.id === sp.cluster) ? (sp.cluster as string) : ''
  const inCluster = clusterParam === '' ? [] : locations.filter((l) => (clusterParam === NO_CLUSTER ? l.cluster_id === null : l.cluster_id === clusterParam))
  const chosen = z.uuid().safeParse(sp.location).success ? inCluster.find((l) => l.id === sp.location) : undefined
  const cluster = clusters.find((c) => c.id === clusterParam)

  return (
    <div className="space-y-4">
      <PageHeader title="Add NVR" description="Choose the cluster and the location the NVR is in, then give its name, address and login." />

      <Section id="nvr-cluster" title="1. Cluster">
        <form method="get" className="grid gap-3 sm:grid-cols-[minmax(0,24rem)_auto] sm:items-end">
          <SelectField id="nvr-cluster-select" name="cluster" label="Cluster name" defaultValue={clusterParam}>
            <option value="" disabled>Choose a cluster</option>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}{c.region_id ? ` (${regionName.get(c.region_id) ?? ''})` : ''}</option>
            ))}
            <option value={NO_CLUSTER}>No cluster</option>
          </SelectField>
          <Button type="submit" className="h-10">Show locations</Button>
        </form>
        {clusters.length === 0 && (
          <p className="text-sm text-muted-foreground">There is no cluster yet. Create clusters under <Link href="/admin/regions" className={LINK}>Regions and clusters</Link>, or choose “No cluster”.</p>
        )}
      </Section>

      {clusterParam !== '' && (
        <Section id="nvr-location" title="2. Location" description={clusterParam === NO_CLUSTER ? 'Locations that are in no cluster.' : `Locations in cluster ${cluster?.code ?? ''} · ${cluster?.name ?? ''}.`}>
          {inCluster.length === 0 ? (
            <p className="text-sm text-muted-foreground">No location here yet. Create it first under <Link href="/admin/locations" className={LINK}>Locations and NVRs</Link>.</p>
          ) : (
            <form method="get" className="grid gap-3 sm:grid-cols-[minmax(0,24rem)_auto] sm:items-end">
              <input type="hidden" name="cluster" value={clusterParam} />
              <SelectField id="nvr-location-select" name="location" label="Location" defaultValue={chosen?.id ?? ''}>
                <option value="" disabled>Choose a location</option>
                {inCluster.map((l) => (
                  <option key={l.id} value={l.id}>{locationTitle(l.code, l.name)}{l.recorders > 0 ? ` · ${l.recorders} NVR${l.recorders === 1 ? '' : 's'}` : ''}</option>
                ))}
              </SelectField>
              <Button type="submit" className="h-10">Continue</Button>
            </form>
          )}
        </Section>
      )}

      {chosen && (
        <Section id="nvr-details" title="3. NVR details" description={`For ${locationTitle(chosen.code, chosen.name)}${cluster ? `, cluster ${cluster.code} · ${cluster.name}` : ''}.`}>
          <RecorderForm key={chosen.id} locationId={chosen.id} />
        </Section>
      )}
    </div>
  )
}
