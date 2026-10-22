import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ArchiveButton } from '@/components/admin/inventory/ArchiveButton'
import { LocationForm } from '@/components/admin/inventory/LocationForm'
import { MoveForm } from '@/components/admin/inventory/MoveForm'
import { NetworkForm } from '@/components/admin/inventory/NetworkForm'
import { RecorderForm } from '@/components/admin/inventory/RecorderForm'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { LOCATION_KIND_LABELS, locationTitle, type LocationKind } from '@/lib/inventory/forms'
import { listFindings } from '@/lib/inventory/findings'
import { locationDetail, regionsAndClusters } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Location' }
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

// P2-5c-1: one location — its details, its place in the tree (moved with the effect on access shown first), its network definition,
// its NVRs (add, open), archive / restore. Administrative role AND admin.inventory, then service-role reads scoped to the organisation.
export default async function LocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireAdministration('admin.inventory')
  if (!z.uuid().safeParse(id).success) notFound()
  const admin = createAdminClient()
  const [detail, tree, findings] = await Promise.all([locationDetail(admin, me.org_id, id), regionsAndClusters(admin, me.org_id), listFindings(admin, me.org_id, { locationId: id })])
  if (!detail) notFound()
  const { location: l, recorders, network } = detail
  const regionName = new Map(tree.regions.map((r) => [r.id, r.name]))
  const clusters = tree.clusters.filter((c) => !c.archived_at)
  const current = clusters.find((c) => c.id === l.cluster_id)
  const archived = !!l.archived_at
  const live = recorders.filter((r) => !r.archived_at)
  return (
    <div className="space-y-4">
      <PageHeader
        title={locationTitle(l.code, l.name)}
        description={`${LOCATION_KIND_LABELS[l.kind as LocationKind] ?? l.kind} · ${current ? `cluster ${current.code} · ${current.name}${current.region_id ? `, region ${regionName.get(current.region_id) ?? ''}` : ''}` : 'No cluster'}${archived ? ' · archived' : l.is_active ? '' : ' · switched off'}`}
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: l.code }]}
        actions={<ArchiveButton kind="location" id={l.id} archived={archived} name={locationTitle(l.code, l.name)} />}
      />
      {archived ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">This location is archived: nobody sees it, nothing contacts its NVRs. Restore it to change it.</p>
      ) : (
        <>
          <Section id="loc-details" title="Details"><LocationForm location={{ ...l }} clusters={[]} /></Section>
          <Section id="loc-place" title="Cluster" description="A location belongs to one cluster or to none.">
            <MoveForm kind="location" id={l.id} current={l.cluster_id} options={clusters.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}${c.region_id ? ` (${regionName.get(c.region_id) ?? ''})` : ''}` }))} />
          </Section>
          <Section id="loc-nvrs" title={`NVRs (${live.length})`} description="Each NVR has its own address, login and cameras. Open one to change it, test it, find its cameras or move cameras between NVRs.">
            {recorders.length === 0 ? <p className="text-sm text-muted-foreground">No NVR yet. A head office or DC may have none.</p> : (
              <ul className="divide-y rounded-md border text-sm">
                {recorders.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <Link href={`/admin/locations/${l.id}/nvrs/${r.id}`} className={LINK}>{r.name}</Link>
                    <span className="font-mono">{r.host ?? '—'}:{r.http_port}</span>
                    <span>{r.cameras} {r.cameras === 1 ? 'camera' : 'cameras'}</span>
                    <span>{r.archived_at ? 'Archived' : r.monitored ? 'Monitored' : 'Switched off'}</span>
                    <span>{r.password_saved ? 'Password saved' : 'No password saved'}</span>
                  </li>
                ))}
              </ul>
            )}
            {detail.unmappedCameras > 0 && <p className="text-sm">{detail.unmappedCameras} {detail.unmappedCameras === 1 ? 'camera is' : 'cameras are'} not linked to an NVR channel (they are not checked or shown). Link them on an NVR’s page.</p>}
            {findings.length > 0 && <p className="text-sm"><Link href="/admin/reconciliation" className={LINK}>{findings.length} {findings.length === 1 ? 'item needs' : 'items need'} a look</Link> after the last camera discovery.</p>}
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">Add an NVR</summary>
              <div className="mt-3"><RecorderForm locationId={l.id} /></div>
            </details>
          </Section>
          <Section id="loc-network" title="Network definition" description="The location’s management network, VLANs and the ranges discovery may look at. Optional.">
            <NetworkForm locationId={l.id} definition={network} />
          </Section>
        </>
      )}
    </div>
  )
}
