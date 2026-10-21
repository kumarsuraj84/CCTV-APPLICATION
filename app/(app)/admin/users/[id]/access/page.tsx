import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AccessEditor } from '@/components/admin/AccessEditor'
import { PageHeader } from '@/components/ui/PageHeader'
import { SEES_EVERYTHING } from '@/lib/admin/roles'
import { getUserAccess, listCamerasForAccess, listStoresForAccess } from '@/lib/admin/users'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Access' }

export default async function AccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireAdmin()
  const admin = createAdminClient()
  const { data: person } = await admin.from('profiles').select('id, full_name, email, role').eq('id', id).eq('org_id', me.org_id).maybeSingle()
  if (!person) notFound()
  if (SEES_EVERYTHING.includes(person.role)) {
    return (
      <div className="space-y-4">
        <PageHeader title={person.full_name || person.email} description="This role already sees everything, so it needs no access list." />
        <Link href="/admin/users" className="underline">Back to users</Link>
      </div>
    )
  }
  const [stores, cameras, initial] = await Promise.all([
    listStoresForAccess(admin, me.org_id),
    listCamerasForAccess(admin, me.org_id),
    getUserAccess(admin, me.org_id, id),
  ])
  return (
    <div className="space-y-4">
      <PageHeader title={`Access for ${person.full_name || person.email}`} description="Choose which stores, zones and cameras this person can see." />
      <AccessEditor userId={id} stores={stores} cameras={cameras} initial={initial} />
    </div>
  )
}
