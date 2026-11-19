import Link from 'next/link'
import { z } from 'zod'
import { FindingsList } from '@/components/admin/inventory/FindingsList'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { listFindings } from '@/lib/inventory/findings'
import { camerasByLocation } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Reconciliation' }
const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

// P2-5c-1 brief item 3: every NVR's open findings from its last camera discovery, with the action that fits each one. Final clean-up
// (review C M-20): `?location=<id>` shows one location's findings only (the link on the location's page); a malformed id is ignored.
export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const me = await requireAdministration('admin.inventory')
  const asked = one(sp.location)
  const locationId = z.uuid().safeParse(asked).success ? asked : null
  const admin = createAdminClient()
  const findings = await listFindings(admin, me.org_id, locationId ? { locationId } : {})
  const byLocation = await camerasByLocation(admin, me.org_id, findings.map((f) => f.locationId))
  const candidates = Object.fromEntries(findings.map((f) => [f.cameraId, (byLocation.get(f.locationId) ?? []).filter((c) => c.id !== f.cameraId)]))
  const code = locationId ? findings[0]?.locationCode ?? null : null
  return (
    <div className="space-y-4">
      <PageHeader
        title="Reconciliation"
        description="Cameras that “Find cameras” could not place. A camera never gets a second identity without a person choosing so."
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: 'Reconciliation' }]}
      />
      {locationId && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>Only location <span translate="no">{code ?? 'chosen'}</span>{code ? '' : ' (nothing to look at there)'}.</span>
          <Link href="/admin/reconciliation" className={LINK}>Show every location</Link>
          <Link href={`/admin/locations/${locationId}`} className={LINK}>Back to the location</Link>
        </p>
      )}
      <Section id="findings" title={`To look at (${findings.length})`}>
        <FindingsList findings={findings} mergeCandidates={candidates} />
      </Section>
    </div>
  )
}
