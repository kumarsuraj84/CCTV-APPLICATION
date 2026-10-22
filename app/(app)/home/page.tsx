import Link from 'next/link'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { CheckNowButton } from '@/components/monitor/CheckNowButton'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { canRunChecks } from '@/lib/admin/roles'
import { getWorkerStatus } from '@/lib/monitor/health'
import { lastCheckedAt } from '@/lib/monitor/last-checked'
import { getMonitoringState } from '@/lib/monitor/uptime'
import { getDashboard } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  // The numbers come through the person's own client (row-level security); only the monitoring heartbeat, which is not about any store, uses the service role.
  const admin = createAdminClient()
  const [d, monitoring, worker] = await Promise.all([
    getDashboard(await createClient()),
    getMonitoringState(admin),
    // Only the time of the last full check is shown; if it cannot be read, the line is simply left out.
    getWorkerStatus(admin).catch(() => null),
  ])
  // The most recent of the last devices round, the last cameras round and the last full check.
  const checkedAt = worker ? lastCheckedAt(worker) : null
  const nothing = d.stores.total === 0 && d.cameras.total === 0 && Object.keys(d.devices).length === 0
  const tile = (key: string, label: string, value: string | number, href: string, tone?: 'good' | 'bad') => (
    <Link key={key} href={href} className="rounded-xl border bg-card p-4 hover:bg-muted">
      <div className={`text-2xl font-semibold ${tone === 'bad' && Number(value) > 0 ? 'text-red-600 dark:text-red-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Link>
  )
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${profile.full_name || profile.email}`}
        description="What is working and what is not, right now."
        actions={canRunChecks(profile.role) ? <CheckNowButton /> : undefined}
      />
      {/* Only while monitoring runs: with the checker stopped nothing new will appear. Same pacing as the Monitoring page. */}
      {monitoring.running && <AutoRefresh busy={!!worker?.running} />}
      {worker && (
        <p className="text-sm text-muted-foreground">
          {worker.running ? 'Checking everything now…' : checkedAt ? `Last checked ${formatDateTime(checkedAt)}` : 'Nothing has been checked yet.'}
        </p>
      )}
      <MonitoringBanner monitoring={monitoring} />
      {nothing ? (
        <p className="text-sm text-muted-foreground">You have not been given access to anything yet. Ask an administrator.</p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Cameras</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {tile('cam-live', 'Live', d.cameras.live, '/stores', 'good')}
              {tile('cam-down', 'Offline', d.cameras.down, '/stores', 'bad')}
              {d.cameras.stale > 0 && tile('cam-stale', 'Not checked lately', d.cameras.stale, '/stores')}
              {tile('cam-unknown', 'Not checked yet', d.cameras.unknown, '/stores')}
              {tile('stores', 'Stores', d.stores.total, '/stores')}
            </div>
            {d.stores.nvrStale > 0 && (
              <p className="text-sm text-muted-foreground">
                {d.stores.nvrStale} {d.stores.nvrStale === 1 ? 'NVR has' : 'NVRs have'} not been checked lately. Their cameras and status may be out of date.
              </p>
            )}
          </section>

          {d.stores.nvrDown.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Stores with the NVR down ({d.stores.nvrDown.length})</h2>
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {d.stores.nvrDown.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                    <Link href={`/stores/${s.id}`} className="underline">{s.code} · {s.name}</Link>
                    <span className="text-muted-foreground">Offline since {formatDateTime(s.since)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {Object.keys(d.devices).length > 0 && (
            <section className="space-y-2">
              <h2 className="font-medium">Devices</h2>
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
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Recent problems</h2>
            {d.recentOutages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {d.recentOutagesLimited
                  ? 'Showing the most recent problems: there is nothing else to list. Most recent problems are cameras that are offline because their NVR is offline (see the stores above).'
                  : 'No problems have been recorded yet.'}
              </p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card text-sm">
                {d.recentOutages.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 break-words">
                      {o.kind === 'nvr' ? 'NVR' : o.kind === 'camera' ? 'Camera' : 'Device'} · {o.label}
                      {o.store && o.kind !== 'nvr' ? <span className="text-muted-foreground"> · {o.store}</span> : null}
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
            )}
          </section>
        </>
      )}
    </div>
  )
}
