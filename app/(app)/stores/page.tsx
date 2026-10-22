import Link from 'next/link'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { getMonitoringState } from '@/lib/monitor/uptime'
import { listVisibleStores } from '@/lib/queries/inventory'
import { listStoreStatus } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Stores' }

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  await requireProfile()
  const supabase = await createClient()
  const [stores, statuses, monitoring] = await Promise.all([listVisibleStores(supabase, q), listStoreStatus(supabase), getMonitoringState(createAdminClient())])
  return (
    <div className="space-y-4">
      {/* Only while monitoring runs: with the checker stopped nothing new will appear. */}
      {monitoring.running && <AutoRefresh busy={false} />}
      <PageHeader title="Stores" description="The stores you can see." />
      <MonitoringBanner monitoring={monitoring} />
      <form className="flex gap-2">
        <input name="q" aria-label="Search stores" defaultValue={q ?? ''} placeholder="Search by name, code or city" className="h-8 w-full max-w-sm rounded-lg border bg-background px-2 text-sm" />
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Code</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">City</th><th className="px-3 py-2">Zone</th>
              <th className="px-3 py-2">NVR</th><th className="px-3 py-2">Cameras live</th><th className="px-3 py-2 text-right">Cameras</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => {
              const status = statuses.get(s.id)
              const total = status?.cameras_total ?? 0
              const notChecked = !status || total === 0 || status.cameras_unknown === total
              const allStale = !!status && total > 0 && status.cameras_stale === total
              return (
                <tr key={s.id} className="border-t hover:bg-muted/50">
                  <td className="px-3 py-2 font-mono"><Link href={`/stores/${s.id}`} className="underline">{s.code}</Link></td>
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2">{s.city ?? '—'}</td>
                  <td className="px-3 py-2">{s.zone ?? '—'}</td>
                  <td className="px-3 py-2"><StatusBadge status={status?.nvr_status} stale={status?.nvr_stale} /></td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {!status || total === 0 ? '—' : notChecked ? (
                      <span className="text-muted-foreground">Not checked yet</span>
                    ) : allStale ? (
                      <span className="text-muted-foreground">Not checked lately</span>
                    ) : (
                      <span className={status.cameras_down > 0 ? 'font-medium text-red-600 dark:text-red-400' : ''}>
                        {status.cameras_live} / {total}
                        {status.cameras_down > 0 ? ` (${status.cameras_down} offline)` : ''}
                        {status.cameras_stale > 0 ? ` (${status.cameras_stale} not checked lately)` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{s.camera_count}</td>
                </tr>
              )
            })}
            {stores.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No stores to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
