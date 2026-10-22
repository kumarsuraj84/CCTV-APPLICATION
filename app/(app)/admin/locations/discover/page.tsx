import { DiscoverAll } from '@/components/admin/inventory/DiscoverAll'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { discoverAllCounts, latestDiscoverAll } from '@/lib/inventory/discover-all'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Find cameras for all locations' }

// P2-5c-2 brief item 2. An administrative role AND admin.inventory (requireAdministration); only then are the counts read with the
// service role, scoped to the organisation.
export default async function DiscoverAllPage() {
  const me = await requireAdministration('admin.inventory')
  const counts = await discoverAllCounts(createAdminClient(), me.org_id)
  return (
    <div className="space-y-4">
      <PageHeader
        title="Find cameras for all locations"
        description="Ask every NVR for its list of cameras in one go. Read-only towards the NVRs."
        breadcrumbs={[{ label: 'Locations and NVRs', href: '/admin/locations' }, { label: 'Find cameras for all' }]}
      />
      <Section id="discover-all" title="Find cameras">
        <DiscoverAll initial={latestDiscoverAll(me.org_id)} counts={counts} />
      </Section>
    </div>
  )
}
