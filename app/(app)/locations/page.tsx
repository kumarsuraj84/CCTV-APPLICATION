import Link from 'next/link'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { redirect } from 'next/navigation'
import { coversLocation, holdsAnyLocationGrant, holdsItView, IT_VIEW } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { locationListFilter, LOCATION_STATE_LABELS, locationCountsText, parseLocationState } from '@/lib/live/location-list'
import { getMonitoringState } from '@/lib/monitor/uptime'
import { listVisibleStores } from '@/lib/queries/inventory'
import { listStoreStatus } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Locations' }

// Final fix Y (final review C M-10, M-12, M-21): the camera counts say what is not checked as well (never a bare "0 / 8"), the Home tiles
// open this list filtered by what they count (?state=), the search field is 16 px on phones (no zoom on iOS), and the table has a
// caption and column headers.
export default async function LocationsPage({ searchParams }: { searchParams: Promise<{ q?: string; state?: string }> }) {
  const { q, state: stateParam } = await searchParams
  const state = parseLocationState(stateParam)
  // P2-2: any CCTV, IT or Wi-Fi grant shows locations. The NVR column is IT information (AC-4): only with the IT view of that location.
  const profile = await requireProfile()
  if (!holdsAnyLocationGrant(profile.capabilities)) redirect('/home')
  const itAnywhere = holdsItView(profile.capabilities)
  const supabase = await createClient()
  const [allStores, statuses, monitoring] = await Promise.all([listVisibleStores(supabase, q), listStoreStatus(supabase), getMonitoringState(createAdminClient())])
  const stores = allStores.filter((s) => locationListFilter(state, statuses.get(s.id)))
  return (
    <div className="space-y-4">
      {/* Only while monitoring runs: with the checker stopped nothing new will appear. */}
      {monitoring.running && <AutoRefresh busy={false} />}
      <PageHeader title="Locations" description="The locations you can see." />
      <MonitoringBanner monitoring={monitoring} />
      <form className="flex flex-wrap gap-2" role="search" aria-label="Find locations">
        <input name="q" aria-label="Search locations" defaultValue={q ?? ''} placeholder="Search by name, code or city"
          className="h-10 w-full max-w-sm rounded-lg border bg-background px-2 text-base sm:h-8 sm:text-sm" />
        {state && <input type="hidden" name="state" value={state} />}
        <button type="submit" className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      {state && (
        <p role="status" className="text-sm">
          Showing locations with cameras: {LOCATION_STATE_LABELS[state].toLowerCase()} ({stores.length}).{' '}
          <Link href={q ? `/locations?q=${encodeURIComponent(q)}` : '/locations'} className="underline">Show every location</Link>
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <caption className="sr-only">Locations you can see, with their cameras</caption>
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2">Code</th><th scope="col" className="px-3 py-2">Location</th>
              <th scope="col" className="px-3 py-2">Cameras live</th>
              {itAnywhere && <th scope="col" className="px-3 py-2">NVR</th>}
              <th scope="col" className="px-3 py-2">City</th><th scope="col" className="px-3 py-2">Zone</th><th scope="col" className="px-3 py-2 text-right">Cameras</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => {
              const status = statuses.get(s.id)
              const text = locationCountsText(status)
              return (
                <tr key={s.id} className="border-t hover:bg-muted/50">
                  <td className="px-3 py-2 font-mono"><Link href={`/locations/${s.id}`} className="underline">{s.code}</Link></td>
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2">
                    <span className={text.bad ? 'font-medium text-red-600 dark:text-red-400' : text.quiet ? 'text-muted-foreground' : ''}>{text.text}</span>
                  </td>
                  {itAnywhere && (
                    <td className="px-3 py-2">
                      {coversLocation(profile.capabilities, IT_VIEW, s.id) ? <StatusBadge status={status?.nvr_status} stale={status?.nvr_stale} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2">{s.city ?? '—'}</td>
                  <td className="px-3 py-2">{s.zone ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{s.camera_count}</td>
                </tr>
              )
            })}
            {stores.length === 0 && (
              <tr><td colSpan={itAnywhere ? 7 : 6} className="px-3 py-6 text-center text-muted-foreground">No locations to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
