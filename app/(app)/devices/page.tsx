import Link from 'next/link'
import { MonitoringBanner } from '@/components/monitor/MonitoringBanner'
import { StatusBadge } from '@/components/monitor/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { IT_VIEW } from '@/lib/auth/capabilities'
import { requireCapability } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { getMonitoringState, uptimeForPage, uptimeSuffix } from '@/lib/monitor/uptime'
import { listVisibleDevices } from '@/lib/queries/inventory'
import { formatUptime, getStates, isStale } from '@/lib/queries/status'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Device Dashboard' }

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams
  // P2-2 (AC-4): IT devices need it.inventory.view or it.monitoring.view; row security then shows only the granted locations and assets.
  const profile = await requireCapability(IT_VIEW)
  const active = (DEVICE_TYPES as readonly string[]).includes(type ?? '') ? type : undefined
  const supabase = await createClient()
  const devices = await listVisibleDevices(supabase, active)
  // Status comes through the person's own client. The ids given to the uptime function came from rows they may see.
  const admin = createAdminClient()
  const ids = devices.map((d) => d.id)
  const monitoring = await getMonitoringState(admin)
  const [states, uptime] = await Promise.all([getStates(supabase, 'device', ids), uptimeForPage(admin, profile.org_id, 'device', ids, '24h', monitoring)])
  const now = new Date()
  // The summary: OK (answers its check), NOT OK (does not), and the rest (never checked, or not checked lately).
  let ok = 0
  let notOk = 0
  for (const d of devices) {
    const st = states.get(d.id)
    if (st?.status === 'down') notOk++
    else if (st?.status === 'up' && !isStale(st.last_checked_at, now)) ok++
  }
  const unchecked = devices.length - ok - notOk
  const tiles = [
    { label: 'OK', value: ok, tone: 'text-emerald-700 dark:text-emerald-300' },
    { label: 'NOT OK', value: notOk, tone: 'text-red-700 dark:text-red-300' },
    { label: 'Not checked', value: unchecked, tone: 'text-muted-foreground' },
  ]
  return (
    <div className="space-y-4">
      <PageHeader title="Device Dashboard" description="Servers, attendance machines, footfall counters and other devices you can see. Each device is pinged about every minute." />
      <MonitoringBanner monitoring={monitoring} />
      <dl className="grid grid-cols-3 gap-3" aria-label="Device summary">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card px-4 py-3">
            <dt className="text-xs font-medium uppercase text-muted-foreground">{t.label}</dt>
            <dd className={`text-2xl font-semibold tabular-nums ${t.tone}`}>{t.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 text-sm">
        <Link href="/devices" aria-current={!active ? 'page' : undefined} className={!active ? 'font-medium underline' : 'underline'}>All</Link>
        {DEVICE_TYPES.map((t) => (
          <Link key={t} href={`/devices?type=${t}`} aria-current={active === t ? 'page' : undefined} className={active === t ? 'font-medium underline' : 'underline'}>{DEVICE_TYPE_LABELS[t]}</Link>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Location</th><th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Uptime 24h{uptimeSuffix(monitoring)}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const st = states.get(d.id)
              return (
                <tr key={d.id} className="border-t">
                  <td className="px-3 py-2">{d.name}</td>
                  <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                  <td className="px-3 py-2">{(d.stores as unknown as { code: string } | null)?.code ?? '—'}</td>
                  <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
                  <td className="px-3 py-2">
                    <StatusBadge plainWords status={st?.status} stale={!!st && isStale(st.last_checked_at, now)} />
                    {st?.status === 'down' && <div className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">since {formatDateTime(st.down_since)}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{formatUptime(uptime.get(d.id))}</td>
                </tr>
              )
            })}
            {devices.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No devices to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
