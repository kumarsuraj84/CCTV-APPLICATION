import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { CheckNowButton } from '@/components/monitor/CheckNowButton'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { coversSomeWholeLocation } from '@/lib/auth/capabilities'
import { requireAdministration } from '@/lib/auth/profile'
import { getWorkerStatus } from '@/lib/monitor/health'
import { describeRounds } from '@/lib/monitor/last-checked'
import { isStale, nvrLoginProblem, type StateRow } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Monitoring' }

const NAMES = { camera: 'Cameras', recorder: 'NVRs', device: 'Devices' } as const
const GAP_DAYS = 7
const GAPS_SHOWN = 5

function plainDuration(sec: number): string {
  if (sec < 90) return 'under 2 minutes'
  const min = Math.round(sec / 60)
  if (min < 120) return `${min} minutes`
  const hours = Math.round(min / 60)
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

export default async function MonitoringPage() {
  // P2-2: the checker's page for the whole organisation: an administrative role AND admin.inventory. "Check now" needs it.monitoring.operate.
  const me = await requireAdministration('admin.inventory')
  const canCheck = coversSomeWholeLocation(me.capabilities, 'it.monitoring.operate') // the service's rule (fix M-5)
  const admin = createAdminClient()
  const now = new Date()
  const since = new Date(now.getTime() - GAP_DAYS * 86_400_000).toISOString()
  const [worker, states, stores, cameras, recorders, gapsRead] = await Promise.all([
    getWorkerStatus(admin),
    fetchAll((from, to) =>
      admin.from('check_state').select('target_type, target_id, status, down_since, last_checked_at, last_up_at').eq('org_id', me.org_id).order('id').range(from, to),
    ),
    fetchAll((from, to) => admin.from('locations').select('id, code, name').eq('org_id', me.org_id).eq('is_active', true).is('archived_at', null).order('code').range(from, to)),
    fetchAll((from, to) => admin.from('cameras').select('id, recorder_id').eq('org_id', me.org_id).eq('is_active', true).is('archived_at', null).order('id').range(from, to)),
    // P2-5b: every NVR (recorder) of the organisation, each with its own state and its own cameras (their active mappings).
    fetchAll((from, to) => admin.from('recorders').select('id, location_id, assets!recorders_asset_fk!inner(name, archived_at)').eq('org_id', me.org_id).is('assets.archived_at', null).order('created_at').order('id').range(from, to)),
    // The gaps are about the whole checker, not one organisation. A failed read only leaves this list out.
    admin.from('monitor_gaps').select('id, started_at, ended_at').gte('ended_at', since).order('started_at', { ascending: false }).limit(GAPS_SHOWN),
  ])
  const gaps = gapsRead.error ? null : (gapsRead.data ?? [])
  const rounds = describeRounds(worker)

  // "Live" here means live and checked lately: a live result older than the limit is counted as not checked lately.
  const counts: Record<string, { up: number; down: number; unknown: number; stale: number }> = {}
  const nvrStates = new Map<string, StateRow>()
  const cameraStates = new Map<string, StateRow>()
  for (const s of states) {
    const c = (counts[s.target_type] ??= { up: 0, down: 0, unknown: 0, stale: 0 })
    if (s.status === 'up' && isStale(s.last_checked_at, now)) c.stale++
    else c[s.status as 'up' | 'down' | 'unknown']++
    const row: StateRow = { ...s, status: s.status as StateRow['status'], error: null }
    if (s.target_type === 'recorder') nvrStates.set(s.target_id, row)
    else if (s.target_type === 'camera') cameraStates.set(s.target_id, row)
  }

  // "The NVR answers but refuses our login": per NVR, judged from its OWN cameras; only meaningful while the checker is running,
  // because it is judged from how recent the results are.
  const camerasByRecorder = new Map<string, string[]>()
  for (const c of cameras) if (c.recorder_id) camerasByRecorder.set(c.recorder_id, [...(camerasByRecorder.get(c.recorder_id) ?? []), c.id])
  const storeById = new Map(stores.map((s) => [s.id, s]))
  const loginProblems = worker.ok
    ? (recorders as unknown as { id: string; location_id: string; assets: { name: string } }[])
        .filter((r) => storeById.has(r.location_id) && nvrLoginProblem({ nvr: nvrStates.get(r.id), cameraIds: camerasByRecorder.get(r.id) ?? [], cameraStates, now }))
        .map((r) => ({ id: r.id, store: storeById.get(r.location_id)!, name: r.assets.name }))
    : []

  const asked = worker.requestedAt && (!worker.runStartedAt || new Date(worker.requestedAt) > new Date(worker.runStartedAt))
  const activity = worker.running
    ? worker.progressTotal > 0
      ? `Checking: ${worker.progressDone} of ${worker.progressTotal} NVRs done`
      : 'Checking: starting'
    : asked
      ? worker.ok
        ? 'A check was asked for and will start in a few seconds'
        : 'A check was asked for, but the checker is not running'
      : 'Waiting for the next round'

  return (
    <div className="space-y-6">
      <AutoRefresh busy={worker.running || !!asked} />
      <PageHeader title="Monitoring" description="Is the checker running, and what did it find?" />
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">The checker</h2>
            <StatusBadge status={worker.ok ? 'up' : 'down'} />
            <span className="text-sm text-muted-foreground">{worker.ok ? 'Running' : 'Not running'}</span>
          </div>
          {canCheck && <CheckNowButton />}
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">Last sign of life</dt>
          <dd>{worker.heartbeatAgeSec === null ? 'Never' : worker.heartbeatAgeSec < 90 ? `${worker.heartbeatAgeSec} seconds ago` : `${plainDuration(worker.heartbeatAgeSec)} ago`}</dd>
          <dt className="text-muted-foreground">Last full check finished</dt>
          <dd>{worker.runFinishedAt && !worker.running ? formatDateTime(worker.runFinishedAt) : worker.runFinishedAt ? `${formatDateTime(worker.runFinishedAt)} (a newer one is under way)` : 'Not yet'}</dd>
          <dt className="text-muted-foreground">Now</dt>
          <dd>{activity}</dd>
          <dt className="text-muted-foreground">Devices and NVRs</dt>
          <dd>{rounds.devices}</dd>
          <dt className="text-muted-foreground">Cameras</dt>
          <dd>{rounds.cameras}</dd>
        </dl>
        {!worker.ok && (
          <p className="text-sm text-destructive">
            The checker is not running, so the status shown elsewhere may be out of date. Start it with <code className="font-mono">npm run worker</code> on the server.
          </p>
        )}
      </section>

      {loginProblems.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">NVR login problems ({loginProblems.length})</h2>
          <p className="text-sm text-muted-foreground">
            These NVRs answer, but their cameras have no recent result. The saved NVR user name or password is probably wrong. Open Manage stores and check them.
            A store that was only just added looks the same for a few minutes.
          </p>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {loginProblems.map((p) => (
              <li key={p.id} className="px-3 py-2">
                {p.store.code} · {p.store.name} · NVR {p.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">What it found</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['camera', 'recorder', 'device'] as const).map((t) => {
            const c = counts[t] ?? { up: 0, down: 0, unknown: 0, stale: 0 }
            return (
              <div key={t} className="rounded-xl border bg-card p-4">
                <div className="text-sm font-medium">{NAMES[t]}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  <span className="text-emerald-600 dark:text-emerald-400">{c.up} live</span> ·{' '}
                  <span className={c.down ? 'text-red-600 dark:text-red-400' : ''}>{c.down} offline</span>
                  {c.stale > 0 && <> · {c.stale} not checked lately</>}
                  {c.unknown > 0 && <> · {c.unknown} not checked yet</>}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Times the checker was not running (last {GAP_DAYS} days)</h2>
        {gaps === null ? (
          <p className="text-sm text-muted-foreground">This list could not be read just now.</p>
        ) : gaps.length === 0 ? (
          <p className="text-sm text-muted-foreground">None. These times are never counted as downtime.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {gaps.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                <span>
                  {formatDateTime(g.started_at)} to {formatDateTime(g.ended_at)}
                </span>
                <span className="text-muted-foreground">{plainDuration((new Date(g.ended_at).getTime() - new Date(g.started_at).getTime()) / 1000)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
