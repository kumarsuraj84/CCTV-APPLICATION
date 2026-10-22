import { FindingsList } from '@/components/admin/inventory/FindingsList'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { listFindings } from '@/lib/inventory/findings'
import { camerasByLocation } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Reconciliation' }

// P2-5c-1 brief item 3: every NVR's open findings from its last camera discovery, with the action that fits each one.
export default async function ReconciliationPage() {
  const me = await requireAdministration('admin.inventory')
  const admin = createAdminClient()
  const findings = await listFindings(admin, me.org_id)
  const byLocation = await camerasByLocation(admin, me.org_id, findings.map((f) => f.locationId))
  const candidates = Object.fromEntries(findings.map((f) => [f.cameraId, (byLocation.get(f.locationId) ?? []).filter((c) => c.id !== f.cameraId)]))
  return (
    <div className="space-y-4">
      <PageHeader
        title="Reconciliation"
        description="Cameras that “Find cameras” could not place. A camera never gets a second identity without a person choosing so."
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: 'Reconciliation' }]}
      />
      <Section id="findings" title={`To look at (${findings.length})`}>
        <FindingsList findings={findings} mergeCandidates={candidates} />
      </Section>
    </div>
  )
}
