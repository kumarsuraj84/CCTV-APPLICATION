import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { listVisibleStores } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Stores' }

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  await requireProfile()
  const stores = await listVisibleStores(await createClient(), q)
  return (
    <div className="space-y-4">
      <PageHeader title="Stores" description="The stores you can see." />
      <form className="flex gap-2">
        <input name="q" defaultValue={q ?? ''} placeholder="Search by name, code or city" className="h-8 w-full max-w-sm rounded-lg border bg-background px-2 text-sm" />
        <button className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">City</th><th className="px-3 py-2">Zone</th><th className="px-3 py-2 text-right">Cameras</th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t hover:bg-muted/50">
                <td className="px-3 py-2 font-mono"><Link href={`/stores/${s.id}`} className="underline">{s.code}</Link></td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2">{s.city ?? '—'}</td>
                <td className="px-3 py-2">{s.zone ?? '—'}</td>
                <td className="px-3 py-2 text-right">{s.camera_count}</td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No stores to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
