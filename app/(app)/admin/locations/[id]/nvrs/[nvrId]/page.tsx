import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ArchiveButton } from '@/components/admin/inventory/ArchiveButton'
import { FindingsList } from '@/components/admin/inventory/FindingsList'
import { MappingEditor } from '@/components/admin/inventory/MappingEditor'
import { DiscoverNvrButton, MonitoringSwitch, RecorderForm, TestConnectionButton } from '@/components/admin/inventory/RecorderForm'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { listFindings } from '@/lib/inventory/findings'
import { recorderDetail } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'NVR' }

// P2-5c-1 brief items 2 and 3: one NVR — its settings (password write-only), monitoring switch, a read-only connection test, "Find
// cameras", its cameras with the mapping editor and history, and what its last discovery could not place.
export default async function RecorderPage({ params }: { params: Promise<{ id: string; nvrId: string }> }) {
  const { id, nvrId } = await params
  const me = await requireAdministration('admin.inventory')
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(nvrId).success) notFound()
  const admin = createAdminClient()
  const [detail, findings, loc] = await Promise.all([
    recorderDetail(admin, me.org_id, id, nvrId),
    listFindings(admin, me.org_id, { recorderId: nvrId }),
    admin.from('locations').select('code, name, archived_at').eq('id', id).eq('org_id', me.org_id).maybeSingle(),
  ])
  if (!detail || !loc.data) notFound()
  const r = detail.recorder
  const archived = !!r.archived_at
  const byLocation = { [id]: detail.mergeCandidates }
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${r.name} (${loc.data.code})`}
        description={`${r.host ?? '—'} · web port ${r.http_port} · video port ${r.rtsp_port} · ${r.cameras} ${r.cameras === 1 ? 'camera' : 'cameras'}${archived ? ' · archived' : r.monitored ? '' : ' · monitoring switched off'}`}
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: loc.data.code, href: `/admin/locations/${id}` }, { label: r.name }]}
        actions={<ArchiveButton kind="recorder" id={r.id} archived={archived} name={r.name} />}
      />
      {archived ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">This NVR is archived: nothing contacts it. Restore it to change it.</p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Section id="nvr-check" title="Check" description="Read-only: one login and the list of channels. After a refused login the NVR is left alone for a while.">
              <div className="flex flex-wrap gap-4"><TestConnectionButton recorderId={r.id} /><DiscoverNvrButton recorderId={r.id} /></div>
            </Section>
            <Section id="nvr-monitoring" title="Monitoring">
              <MonitoringSwitch recorderId={r.id} enabled={r.monitoring_enabled} reason={r.monitoring_disabled_reason} />
            </Section>
          </div>
          <Section id="nvr-settings" title="Settings">
            <RecorderForm locationId={id} recorder={r} />
          </Section>
          <Section id="nvr-cameras" title={`Cameras on this NVR (${detail.cameras.length})`} description="Move a camera to another NVR or channel of this location, or merge a duplicate into it. Its access, groups and history stay with it.">
            <MappingEditor cameras={detail.cameras} recorders={detail.recorders} mergeCandidates={detail.mergeCandidates} />
          </Section>
          {detail.unmapped.length > 0 && (
            <Section id="nvr-unlinked" title={`Cameras of this location not linked to any NVR (${detail.unmapped.length})`} description="Restored or added by hand. They are not checked or shown until they are linked to a channel.">
              <MappingEditor cameras={detail.unmapped} recorders={detail.recorders} mergeCandidates={[]} />
            </Section>
          )}
          <Section id="nvr-findings" title={`To reconcile (${findings.length})`} description="What the last “Find cameras” on this NVR could not place.">
            <FindingsList findings={findings} mergeCandidates={Object.fromEntries(findings.map((f) => [f.cameraId, (byLocation[f.locationId] ?? []).filter((c) => c.id !== f.cameraId)]))} />
          </Section>
        </>
      )}
    </div>
  )
}
