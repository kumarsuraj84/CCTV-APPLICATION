import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { AccessEditor, type EditorPrefill } from '@/components/admin/AccessEditor'
import { PageHeader } from '@/components/ui/PageHeader'
import { loadEditor, type EditorData } from '@/lib/admin/access'
import { requireAdministration } from '@/lib/auth/profile'
import { FreshAuthNotice } from '@/components/auth/FreshAuthNotice'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Access' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/**
 * ?revoke=<grant> stages the removal of that grant; ?convert=<grant> also opens "Add access" prefilled for the same right, so a
 * migrated organisation-wide or location grant can be replaced by narrower ones (from the access review, P2-3).
 */
function prefillFrom(data: EditorData, sp: Record<string, string | string[] | undefined>): EditorPrefill | undefined {
  const revoke = one(sp.revoke)
  const convert = one(sp.convert)
  const id = convert ?? revoke
  if (!id || !z.uuid().safeParse(id).success) return undefined
  const g = data.grants.find((x) => x.id === id && x.state !== 'revoked')
  if (!g) return undefined
  if (!convert) return { revokeIds: [g.id], revokeReason: 'Reviewed: not needed', builder: null }
  const area = (['cctv', 'it', 'wifi', 'admin'] as const).find((a) => a === g.area) ?? 'cctv'
  return {
    revokeIds: [g.id],
    revokeReason: 'Converted to scoped grants after review',
    builder: {
      area,
      // Organisation-wide → choose locations; a whole location → choose single cameras (or assets) in it.
      mode: g.scopeKind === 'organization' ? 'location' : area === 'cctv' ? 'camera' : 'asset',
      capabilities: [g.capability],
      locationIds: g.scopeKind === 'location' && g.scopeId ? [g.scopeId] : [],
    },
  }
}

// P2-3: the administrative role AND admin.access (the Server Actions ask the same). Every role, managers included, gets its access
// from explicit grants (AC-8); a super administrator holds every right (owner ruling P-1).
export default async function AccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  const me = await requireAdministration('admin.access')
  const data = await loadEditor(createAdminClient(), { id: me.id, orgId: me.org_id, role: me.role }, id)
  if (!data) notFound()
  const prefill = prefillFrom(data, await searchParams)
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Access for ${data.person.full_name || data.person.email}`}
        description="What this person may see and do: live video, recordings, export, IT and Wi-Fi, administration."
        breadcrumbs={[{ label: 'Users', href: '/admin/users' }, { label: 'Access' }]}
        actions={<Link href="/admin/access-review" className="text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">Access review</Link>}
      />
      <FreshAuthNotice session={me.session} what="Saving changes of access" />
      <AccessEditor key={data.person.id} userId={data.person.id} data={data} prefill={prefill} />
    </div>
  )
}
