import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ArchiveButton } from '@/components/admin/inventory/ArchiveButton'
import { AssetForm } from '@/components/admin/inventory/AssetForm'
import { DependencyPicker, EndpointsEditor } from '@/components/admin/inventory/AssetLinks'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { ASSET_TYPE_LABELS, type AssetType } from '@/lib/inventory/forms'
import { assetDetail } from '@/lib/queries/admin-inventory'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Asset' }

// P2-5c-1 brief item 4: one asset — attributes, dependencies (a loop is refused plainly), addresses per address space, archive.
export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireAdministration('admin.inventory')
  if (!z.uuid().safeParse(id).success) notFound()
  const admin = createAdminClient()
  const [detail, locations] = await Promise.all([
    assetDetail(admin, me.org_id, id),
    fetchAll((from, to) => admin.from('locations').select('id, code, name').eq('org_id', me.org_id).is('archived_at', null).order('code').order('id').range(from, to)),
  ])
  if (!detail) notFound()
  const a = detail.asset
  const code = new Map(locations.map((l) => [l.id, l.code]))
  const archived = !!a.archived_at
  return (
    <div className="space-y-4">
      <PageHeader
        title={a.name}
        description={`${ASSET_TYPE_LABELS[a.type as AssetType] ?? a.type}${a.location_id ? ` · ${code.get(a.location_id) ?? ''}` : ' · no location'}${archived ? ' · archived' : ''}`}
        breadcrumbs={[{ label: 'Assets', href: '/admin/assets' }, { label: a.name }]}
        actions={<ArchiveButton kind="asset" id={a.id} archived={archived} name={a.name} />}
      />
      {archived ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">This asset is archived. Restore it to change it.</p>
      ) : (
        <>
          <Section id="asset-details" title="Details"><AssetForm asset={{ ...a, warranty_until: a.warranty_until ?? null }} locations={locations} spaces={detail.spaces} /></Section>
          <Section id="asset-deps" title="Depends on" description="What this asset needs to work: its switch or router (network), its UPS (power), its NVR (recording).">
            <DependencyPicker assetId={a.id} dependencies={detail.dependencies} candidates={detail.others.map((o) => ({ id: o.id, label: `${o.name}${o.location_id ? ` (${code.get(o.location_id) ?? ''})` : ''}` }))} />
          </Section>
          <Section id="asset-endpoints" title="Addresses" description="Unique within their address space. The management address follows the address in Details.">
            <EndpointsEditor assetId={a.id} endpoints={detail.endpoints} spaces={detail.spaces} />
          </Section>
        </>
      )}
    </div>
  )
}
