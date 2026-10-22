import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TriangleAlert } from 'lucide-react'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/PageHeader'
import { coversCamera, coversLocation, holdsAnyLocationGrant, holdsItView, IT_VIEW } from '@/lib/auth/capabilities'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { getMonitoringState, uptimeForPage, uptimeSuffix } from '@/lib/monitor/uptime'
import { getVisibleStore } from '@/lib/queries/inventory'
import { cameraReason, formatUptime, getStates, isStale, nvrLoginProblem, type StateRow } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'

export const metadata = { title: 'Store' }

/** "Offline since …" or "Last seen live …", or nothing for a target that was never checked. */
function Since({ state }: { state: StateRow | undefined }) {
  if (!state || state.status === 'unknown' || state.status === 'off') return null
  if (state.status === 'down') return <div className="text-muted-foreground">Offline since {formatDateTime(state.down_since)}</div>
  return <div className="text-muted-foreground">Last seen live {formatDateTime(state.last_up_at ?? state.last_checked_at)}</div>
}

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const profile = await requireProfile()
  if (!holdsAnyLocationGrant(profile.capabilities)) notFound()
  const supabase = await createClient()
  const store = await getVisibleStore(supabase, id)
  if (!store) notFound()

  // P2-2 (AC-4). What is shown follows the person's capabilities; the rows themselves come through their own client (row security),
  // so a display decision can never reveal data. P2-5b (ruling C-1): a location may have several NVRs. People with the IT view of an
  // NVR see that NVR — its status, the login hint, its cameras grouped under it and the checker's own words about them; everybody else
  // sees all the cameras of the location they may see, with no recorder detail. Devices: only with an IT view. Live / Playback links
  // only where the person may use them; the screens behind them check each camera again in the database.
  const caps = profile.capabilities
  const itStore = coversLocation(caps, IT_VIEW, store.id)
  const devices = holdsItView(caps) ? store.devices : []
  const cam = (c: { id: string }) => ({ id: c.id, location_id: store.id })
  const anyLive = store.cameras.some((c) => coversCamera(caps, 'cctv.live', cam(c)))

  // Status comes through the person's own client. The ids passed to the uptime function came from rows they may see.
  const admin = createAdminClient()
  const cameraIds = store.cameras.map((c) => c.id)
  const deviceIds = devices.map((d) => d.id)
  const recorderIds = store.recorders.map((r) => r.id)
  const monitoring = await getMonitoringState(admin)
  const [cameraStates, deviceStates, nvrStates, camUp24, camUp7, devUp24] = await Promise.all([
    getStates(supabase, 'camera', cameraIds),
    getStates(supabase, 'device', deviceIds),
    getStates(supabase, 'recorder', recorderIds),
    uptimeForPage(admin, profile.org_id, 'camera', cameraIds, '24h', monitoring),
    uptimeForPage(admin, profile.org_id, 'camera', cameraIds, '7d', monitoring),
    uptimeForPage(admin, profile.org_id, 'device', deviceIds, '24h', monitoring),
  ])
  const now = new Date()
  const stale = (st: StateRow | undefined) => !!st && isStale(st.last_checked_at, now)
  const camerasOf = (recorderId: string | null) => store.cameras.filter((c) => c.recorder_id === recorderId)
  // The cameras grouped by their NVR for people who see the NVRs; one list for everybody else.
  const groups: { key: string; title: string | null; cameras: typeof store.cameras }[] =
    store.recorders.length === 0
      ? [{ key: 'all', title: null, cameras: store.cameras }]
      : [
          ...store.recorders.map((r) => ({ key: r.id, title: `Cameras on NVR ${r.name}`, cameras: camerasOf(r.id) })),
          ...(camerasOf(null).length > 0 ? [{ key: 'other', title: 'Other cameras', cameras: camerasOf(null) }] : []),
        ]

  return (
    <div className="space-y-6">
      {/* Only while monitoring runs: with the checker stopped nothing new will appear. */}
      {monitoring.running && <AutoRefresh busy={false} />}
      <PageHeader title={`${store.code} · ${store.name}`} description={[store.city, store.zone].filter(Boolean).join(' · ')}
        actions={anyLive ? <Link href={`/live?store=${store.id}`} className={cn(buttonVariants())}>Watch live</Link> : undefined}
      />
      <MonitoringBanner monitoring={monitoring} />
      {store.recorders.length > 0 && (
        <section className="space-y-2 text-sm" aria-label="NVRs">
          {store.recorders.map((r) => {
            const nvr = nvrStates.get(r.id)
            const ids = camerasOf(r.id).map((c) => c.id)
            const loginProblem = monitoring.running && nvrLoginProblem({ nvr, cameraIds: ids, cameraStates, now })
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">NVR {r.name}</span>
                  <StatusBadge status={nvr?.status} stale={stale(nvr)} />
                  {nvr?.status === 'down' && <span className="text-muted-foreground">Offline since {formatDateTime(nvr.down_since)}</span>}
                  {nvr?.status === 'up' && <span className="text-muted-foreground">Checked {formatDateTime(nvr.last_checked_at)}</span>}
                </div>
                {nvr?.status === 'down' && nvr.error && <div className="break-words text-muted-foreground">Reason: {nvr.error}</div>}
                {loginProblem && (
                  <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      <span className="font-medium">NVR login problem?</span> This NVR is reachable, but none of its cameras has been checked lately. The NVR user name or password saved for it may be wrong. Ask an administrator to check them.
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </section>
      )}
      {groups.map((g) => (
        <section key={g.key}>
          <h2 className="mb-2 font-medium">{`${g.title ?? 'Cameras'} (${g.cameras.length})`}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {g.cameras.map((c) => {
              const st = cameraStates.get(c.id)
              const u24 = camUp24.get(c.id)
              const u7 = camUp7.get(c.id)
              // The checker's own words only with the IT view of the camera's NVR (the database decides the same in status_reasons).
              const itView = itStore || c.recorder_id !== null
              return (
                <div key={c.id} className="space-y-1 rounded-lg border bg-card p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-medium">{c.channel} · {c.name}</span>
                    <StatusBadge status={st?.status} stale={stale(st)} />
                  </div>
                  {/* Camera addresses are for people with the IT view of the camera's NVR only (P2-1, review I-1). */}
                  {store.showsAddresses && <div className="text-muted-foreground">{c.camera_ip ?? 'Address not known yet'}</div>}
                  <Since state={st} />
                  <div className="text-muted-foreground">
                    {u24 == null && u7 == null ? 'Uptime: no data yet' : `Uptime 24h ${formatUptime(u24)} · 7d ${formatUptime(u7)}${uptimeSuffix(monitoring)}`}
                  </div>
                  {st?.status === 'down' && cameraReason(st.error, { itView }) && (
                    <div className="break-words text-muted-foreground">Reason: {cameraReason(st.error, { itView })}</div>
                  )}
                  {(coversCamera(caps, 'cctv.live', cam(c)) || coversCamera(caps, 'cctv.playback', cam(c))) && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                      {coversCamera(caps, 'cctv.live', cam(c)) && (
                        <Link href={`/live?camera=${c.id}`} className="underline underline-offset-2" aria-label={`Watch ${c.name} live`}>Live</Link>
                      )}
                      {coversCamera(caps, 'cctv.playback', cam(c)) && (
                        <Link href={`/playback?camera=${c.id}`} className="underline underline-offset-2" aria-label={`Play back recordings of ${c.name}`}>Playback</Link>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {g.cameras.length === 0 && <p className="text-sm text-muted-foreground">No cameras to show.</p>}
          </div>
        </section>
      ))}
      {devices.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">Devices</h2>
          <ul className="space-y-2 text-sm">
            {devices.map((d) => {
              const st = deviceStates.get(d.id)
              const u24 = devUp24.get(d.id)
              return (
                <li key={d.id} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words">{d.name} · {DEVICE_TYPE_LABELS[d.type as DeviceType]} · <span className="font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</span></span>
                    <StatusBadge status={st?.status} stale={stale(st)} />
                  </div>
                  <Since state={st} />
                  <div className="text-muted-foreground">{u24 == null ? 'Uptime: no data yet' : `Uptime 24h ${formatUptime(u24)}${uptimeSuffix(monitoring)}`}</div>
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
