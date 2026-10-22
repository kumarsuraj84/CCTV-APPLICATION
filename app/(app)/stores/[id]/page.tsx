import { notFound } from 'next/navigation'
import { TriangleAlert } from 'lucide-react'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { getMonitoringState, uptimeForPage } from '@/lib/monitor/uptime'
import { getVisibleStore } from '@/lib/queries/inventory'
import { formatUptime, getStates, nvrLoginProblem, type StateRow } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Store' }

/** "Offline since …" or "Last seen live …", or nothing for a target that was never checked. */
function Since({ state }: { state: StateRow | undefined }) {
  if (!state || state.status === 'unknown') return null
  if (state.status === 'down') return <div className="text-muted-foreground">Offline since {formatDateTime(state.down_since)}</div>
  return <div className="text-muted-foreground">Last seen live {formatDateTime(state.last_up_at ?? state.last_checked_at)}</div>
}

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const profile = await requireProfile()
  const supabase = await createClient()
  const store = await getVisibleStore(supabase, id)
  if (!store) notFound()

  // Status comes through the person's own client. The ids passed to the uptime function came from rows they may see.
  const admin = createAdminClient()
  const cameraIds = store.cameras.map((c) => c.id)
  const deviceIds = store.devices.map((d) => d.id)
  const monitoring = await getMonitoringState(admin)
  const [cameraStates, deviceStates, nvrStates, camUp24, camUp7, devUp24] = await Promise.all([
    getStates(supabase, 'camera', cameraIds),
    getStates(supabase, 'device', deviceIds),
    getStates(supabase, 'nvr', [id]),
    uptimeForPage(admin, profile.org_id, 'camera', cameraIds, '24h', monitoring),
    uptimeForPage(admin, profile.org_id, 'camera', cameraIds, '7d', monitoring),
    uptimeForPage(admin, profile.org_id, 'device', deviceIds, '24h', monitoring),
  ])
  const nvr = nvrStates.get(id)
  const loginProblem = monitoring.running && nvrLoginProblem({ nvr, cameraIds, cameraStates, now: new Date() })

  return (
    <div className="space-y-6">
      <PageHeader title={`${store.code} · ${store.name}`} description={[store.city, store.zone].filter(Boolean).join(' · ')} />
      <MonitoringBanner monitoring={monitoring} />
      <section className="space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">NVR</span>
          <StatusBadge status={nvr?.status} />
          {nvr?.status === 'down' && <span className="text-muted-foreground">Offline since {formatDateTime(nvr.down_since)}</span>}
          {nvr?.status === 'up' && <span className="text-muted-foreground">Checked {formatDateTime(nvr.last_checked_at)}</span>}
        </div>
        {nvr?.status === 'down' && nvr.error && <div className="break-words text-muted-foreground">Reason: {nvr.error}</div>}
        {loginProblem && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-medium">NVR login problem?</span> The NVR is reachable, but none of its cameras has been checked lately. The NVR user name or password saved for this store may be wrong. Ask an administrator to check them.
            </span>
          </div>
        )}
      </section>
      <section>
        <h2 className="mb-2 font-medium">Cameras ({store.cameras.length})</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {store.cameras.map((c) => {
            const st = cameraStates.get(c.id)
            const u24 = camUp24.get(c.id)
            const u7 = camUp7.get(c.id)
            return (
              <div key={c.id} className="space-y-1 rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words font-medium">{c.channel} · {c.name}</span>
                  <StatusBadge status={st?.status} />
                </div>
                <div className="text-muted-foreground">{c.camera_ip ?? 'Address not known yet'}</div>
                <Since state={st} />
                <div className="text-muted-foreground">
                  {u24 == null && u7 == null ? 'Uptime: no data yet' : `Uptime 24h ${formatUptime(u24)} · 7d ${formatUptime(u7)}`}
                </div>
                {st?.status === 'down' && st.error && <div className="break-words text-muted-foreground">Reason: {st.error}</div>}
              </div>
            )
          })}
          {store.cameras.length === 0 && <p className="text-sm text-muted-foreground">No cameras to show.</p>}
        </div>
      </section>
      {store.devices.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">Devices</h2>
          <ul className="space-y-2 text-sm">
            {store.devices.map((d) => {
              const st = deviceStates.get(d.id)
              const u24 = devUp24.get(d.id)
              return (
                <li key={d.id} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words">{d.name} · {DEVICE_TYPE_LABELS[d.type as DeviceType]} · <span className="font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</span></span>
                    <StatusBadge status={st?.status} />
                  </div>
                  <Since state={st} />
                  <div className="text-muted-foreground">{u24 == null ? 'Uptime: no data yet' : `Uptime 24h ${formatUptime(u24)}`}</div>
                  {st?.status === 'down' && st.error && <div className="break-words text-muted-foreground">Reason: {st.error}</div>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
