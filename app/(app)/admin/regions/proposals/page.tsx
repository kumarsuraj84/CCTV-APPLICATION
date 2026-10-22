import { ProposalTool } from '@/components/admin/inventory/ProposalTool'
import { Section } from '@/components/admin/inventory/fields'
import { FormAlert } from '@/components/ui/form-alert'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { hierarchyProposals } from '@/lib/inventory/hierarchy'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Suggest clusters' }

// P2-5c-1 brief item 7: suggestions only. Nothing changes until the administrator ticks rows and applies them.
export default async function ProposalsPage() {
  const me = await requireAdministration('admin.inventory')
  const res = await hierarchyProposals({ admin: createAdminClient(), rls: await createClient() }, { id: me.id, orgId: me.org_id, role: me.role })
  return (
    <div className="space-y-4">
      <PageHeader
        title="Suggest clusters from zones"
        description="For locations without a cluster: a cluster code from the zone and a region code from the state. Check them, change them, tick the rows to apply."
        breadcrumbs={[{ label: 'Regions and clusters', href: '/admin/regions' }, { label: 'Suggestions' }]}
      />
      <Section id="proposals" title="Suggestions">
        {res.ok ? <ProposalTool rows={res.rows} /> : <FormAlert>{res.error}</FormAlert>}
      </Section>
    </div>
  )
}
