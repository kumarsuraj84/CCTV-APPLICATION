import { notFound } from 'next/navigation'
import { AccessEditor } from '@/components/admin/AccessEditor'
import { PageHeader } from '@/components/ui/PageHeader'
import { getUserAccess, listCamerasForAccess, listStoresForAccess } from '@/lib/admin/users'
import { requireAdministration } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Access' }

// Interim editor (P2-1): every role, managers included, gets its access from explicit grants (AC-8). The full editor with modes,
// expiry and the effective-access preview is P2-3. P2-2: an administrative role AND admin.access (the save action asks the same).
export default async function AccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireAdministration('admin.access')
  const admin = createAdminClient()
  const { data: person } = await admin.from('profiles').select('id, full_name, email, role').eq('id', id).eq('org_id', me.org_id).maybeSingle()
  if (!person) notFound()
  const [stores, cameras, initial] = await Promise.all([
    listStoresForAccess(admin, me.org_id),
    listCamerasForAccess(admin, me.org_id),
    getUserAccess(admin, me.org_id, id),
  ])
  return (
    <div className="space-y-4">
      <PageHeader title={`Access for ${person.full_name || person.email}`} description="Choose the stores and cameras this person can watch live and play back." />
      <AccessEditor userId={id} stores={stores} cameras={cameras} initial={initial} />
    </div>
  )
}
