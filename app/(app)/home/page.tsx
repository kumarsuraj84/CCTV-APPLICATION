import Link from 'next/link'
import { Inbox } from 'lucide-react'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { CheckNowButton } from '@/components/monitor/CheckNowButton'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { MSG_ACCESS_UNREADABLE, MSG_NOTHING_ASSIGNED } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { getWorkerStatus } from '@/lib/monitor/health'
import { lastCheckedAt } from '@/lib/monitor/last-checked'
import { getMonitoringState } from '@/lib/monitor/uptime'
import { homeSections } from '@/lib/nav'
import { getDashboard, type Dashboard } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Home' }

type Outage = Dashboard['recentOutages'][number]

function OutageList({ items, empty }: { items: Outage[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="divide-y rounded-xl border bg-card text-sm">
      {items.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="min-w-0 break-words">
            {o.kind === 'recorder' ? 'NVR' : o.kind === 'camera' ? 'Camera' : 'Device'} · {o.label}
            {o.store ? <span className="text-muted-foreground"> · {o.store}</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {formatDateTime(o.startedAt)}
            {o.endedAt ? (
              <>
                <StatusBadge status="up" />
                <span>back live {formatDateTime(o.endedAt)}</span>
              </>
            ) : (
              <StatusBadge status="down" />
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

// P2-2 (brief items 4 and 6): a CCTV section (camera availability only) for any CCTV capability, an IT section (devices, NVRs) for the
// IT view, "Check now" for it.monitoring.operate, and a clear state when nothing is assigned. The numbers come through the person's own
// client (row security), so each section can only ever count what the person may see; only the monitoring heartbeat, which is not
// about any store, uses the service role.
export default async function HomePage() {
  const profile = await requireProfile()
  const show = homeSections({ role: profile.role, capabilities: profile.capabilities })
  const header = (
    <PageHeader
      title={`Welcome, ${profile.full_name || profile.email}`}
      description="What is working and what is not, right now."
      actions={show.checkNow ? <CheckNowButton /> : undefined}
    />
  )

  if (show.state !== 'ok') {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Inbox}
            title={show.state === 'unreadable' ? 'Your access could not be read' : 'Nothing is assigned yet'}
            description={
              show.state === 'unreadable'
                ? MSG_ACCESS_UNREADABLE
                : show.adminPages
                  ? `${MSG_NOTHING_ASSIGNED} You can still use the administration pages in the menu.`
                  : MSG_NOTHING_ASSIGNED
            }
          />
        </div>
      </div>
    )
  }

  const admin = createAdminClient()
  const [d, monitoring, worker] = await Promise.all([
    getDashboard(await createClient()),
    getMonitoringState(admin),
    // Only the time of the last full check is shown; if it cannot be read, the line is simply left out.
    getWorkerStatus(admin).catch(() => null),
  ])
  // The most recent of the last devices round, the last cameras round and the last full check.
  const checkedAt = worker ? lastCheckedAt(worker) : null
  const cameraProblems = d.recentOutages.filter((o) => o.kind === 'camera')
  const itProblems = d.recentOutages.filter((o) => o.kind !== 'camera')
  const tile = (key: string, label: string, value: string | number, href: string, tone?: 'good' | 'bad') => (
    <Link key={key} href={href} className="rounded-xl border bg-card p-4 hover:bg-muted">
      <div className={`text-2xl font-semibold ${tone === 'bad' && Number(value) > 0 ? 'text-red-600 dark:text-red-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Link>
  )
  return (
    <div className="space-y-6">
      {header}
      {/* Only while monitoring runs: with the checker stopped nothing new will appear. Same pacing as the Monitoring page. */}
      {monitoring.running && <AutoRefresh busy={!!worker?.running} />}
      {worker && (
        <p className="text-sm text-muted-foreground">
          {worker.running ? 'Checking everything now…' : checkedAt ? `Last checked ${formatDateTime(checkedAt)}` : 'Nothing has been checked yet.'}
        </p>
      )}
      <MonitoringBanner monitoring={monitoring} />

      {show.cctv && (
        <section aria-labelledby="home-cctv" className="space-y-4">
          <div className="space-y-2">
            <h2 id="home-cctv" className="font-medium">Cameras</h2>
            {d.cameras.total === 0 ? (
              <p className="text-sm text-muted-foreground">No cameras are assigned to you yet. Ask an administrator for access.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {tile('cam-live', 'Live', d.cameras.live, '/stores', 'good')}
                {tile('cam-down', 'Offline', d.cameras.down, '/stores', 'bad')}
                {d.cameras.stale > 0 && tile('cam-stale', 'Not checked lately', d.cameras.stale, '/stores')}
                {tile('cam-unknown', 'Not checked yet', d.cameras.unknown, '/stores')}
                {tile('stores', 'Stores', d.stores.total, '/stores')}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent camera problems</h3>
            <OutageList items={cameraProblems} empty="No camera problems have been recorded yet." />
          </div>
        </section>
      )}

      {show.it && (
        <section aria-labelledby="home-it" className="space-y-4">
          <h2 id="home-it" className="font-medium">IT devices and recorders</h2>
          {d.stores.nvrStale > 0 && (
            <p className="text-sm text-muted-foreground">
              {d.stores.nvrStale} {d.stores.nvrStale === 1 ? 'NVR has' : 'NVRs have'} not been checked lately. Their cameras and status may be out of date.
            </p>
          )}
          {d.stores.nvrDown.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">NVRs that are down ({d.stores.nvrDown.length})</h3>
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {d.stores.nvrDown.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                    <Link href={`/stores/${s.locationId}`} className="underline">{s.code} · {s.name} · {s.recorder}</Link>
                    <span className="text-muted-foreground">Offline since {formatDateTime(s.since)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.keys(d.devices).length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices are assigned to you yet. Ask an administrator for access.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {DEVICE_TYPES.filter((t) => d.devices[t]).map((t) => {
                const c = d.devices[t]
                return (
                  <Link key={t} href={`/devices?type=${t}`} className="rounded-xl border bg-card p-4 hover:bg-muted">
                    <div className="text-sm font-medium">{DEVICE_TYPE_LABELS[t as DeviceType]}s</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      <span className="text-emerald-600 dark:text-emerald-400">{c.up} live</span> ·{' '}
                      <span className={c.down ? 'text-red-600 dark:text-red-400' : ''}>{c.down} offline</span>
                      {c.stale > 0 && <> · {c.stale} not checked lately</>}
                      {c.unknown > 0 && <> · {c.unknown} not checked yet</>}
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Recent device and recorder problems</h3>
            <OutageList
              items={itProblems}
              empty={
                d.recentOutagesLimited
                  ? 'Showing the most recent problems: there is nothing else to list. Most recent problems are cameras that are offline because their NVR is offline (see the NVRs above).'
                  : 'No device or recorder problems have been recorded yet.'
              }
            />
          </div>
        </section>
      )}
    </div>
  )
}
