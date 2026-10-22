import { CircleCheck, CircleHelp, CircleX, Clock, PowerOff, type LucideIcon } from 'lucide-react'
import { formatDateTime } from '@/lib/time'
import { SUPPORT_WORDS, type Support, type WifiItem } from '@/lib/wifi/inventory'

// The Wi-Fi inventory table (P2-5c-2 brief item 4). Words and icons, never colour alone (design reference §7). Capabilities come from the
// documented matrix only: "Documented — not tested here", "Not supported" or "Unverified"; none of them is lab-validated today.

const REACH: Record<WifiItem['reachability'], { Icon: LucideIcon; tone: string }> = {
  Reachable: { Icon: CircleCheck, tone: 'text-success-strong' },
  'Not reachable': { Icon: CircleX, tone: 'text-destructive-strong' },
  'Not checked lately': { Icon: Clock, tone: 'text-warning-strong' },
  'Not checked yet': { Icon: CircleHelp, tone: 'text-muted-foreground' },
  'Monitoring off': { Icon: PowerOff, tone: 'text-muted-foreground' },
}
const SUPPORT_TONE: Record<Support, string> = { supported: 'text-success-strong', unsupported: 'text-destructive-strong', unverified: 'text-warning-strong' }
const dash = (v: string | null | undefined) => (v && v.trim() ? v : '—')

export function WifiInventoryTable({ items }: { items: WifiItem[] }) {
  if (items.length === 0) return <p className="rounded-md border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No access point, router or switch matches.</p>
  return (
    <>
    {/* Phones: one card per device; wider screens: the table. */}
    <ul className="space-y-2 sm:hidden" aria-label={`${items.length} ${items.length === 1 ? 'device' : 'devices'}`}>
      {items.map((i) => {
        const r = REACH[i.reachability]
        return (
          <li key={i.id} className="space-y-1 rounded-md border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{i.name}</span>
              <span className={`inline-flex items-center gap-1 ${r.tone}`}><r.Icon aria-hidden="true" className="size-4" />{i.reachability}</span>
            </div>
            <p className="text-muted-foreground">{i.kind} · <span className="font-mono">{dash(i.locationCode)}</span>{i.locationName ? ` ${i.locationName}` : ''}</p>
            <p>{[i.vendor, i.model].filter(Boolean).join(' ') || 'Model not recorded'} · firmware {dash(i.firmware)} · {dash(i.managementMode)} <span className="font-mono">{dash(i.managementIp)}</span></p>
            <p>Wi-Fi profile: {i.profile}</p>
            <p>{i.capabilitySummary}</p>
            {i.capabilities.length > 0 && <Capabilities rows={i.capabilities} />}
          </li>
        )
      })}
    </ul>
    <div className="hidden overflow-x-auto rounded-md border bg-card sm:block">
      <table className="w-full min-w-[960px] text-sm">
        <caption className="px-3 pt-2 text-left text-xs text-muted-foreground" aria-live="polite">{`${items.length} ${items.length === 1 ? 'device' : 'devices'}`}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Location</th><th scope="col" className="px-3 py-2 font-medium">Name and kind</th>
            <th scope="col" className="px-3 py-2 font-medium">Model and firmware</th><th scope="col" className="px-3 py-2 font-medium">Management</th>
            <th scope="col" className="px-3 py-2 font-medium">Reachability</th><th scope="col" className="px-3 py-2 font-medium">Wi-Fi profile</th>
            <th scope="col" className="px-3 py-2 font-medium">Capabilities (from the documentation)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const r = REACH[i.reachability]
            return (
              <tr key={i.id} className="border-t align-top">
                <td className="px-3 py-2"><span className="font-mono">{dash(i.locationCode)}</span>{i.locationName && <span className="block text-xs text-muted-foreground">{i.locationName}</span>}</td>
                <td className="px-3 py-2"><span className="font-medium">{i.name}</span><span className="block text-xs text-muted-foreground">{i.kind}</span></td>
                <td className="px-3 py-2">
                  {[i.vendor, i.model].filter(Boolean).join(' ') || '—'}
                  <span className="block text-xs text-muted-foreground">Firmware {dash(i.firmware)}{i.serial ? ` · serial ${i.serial}` : ''}</span>
                </td>
                <td className="px-3 py-2">{dash(i.managementMode)}<span className="block font-mono text-xs text-muted-foreground">{dash(i.managementIp)}</span></td>
                <td className={`px-3 py-2 ${r.tone}`}>
                  <span className="inline-flex items-center gap-1 whitespace-nowrap"><r.Icon aria-hidden="true" className="size-4" />{i.reachability}</span>
                  {i.lastChecked && <span className="block text-xs text-muted-foreground">Last checked {formatDateTime(i.lastChecked)}</span>}
                </td>
                <td className="px-3 py-2">{i.profile}</td>
                <td className="px-3 py-2">
                  <p>{i.capabilitySummary}</p>
                  {i.capabilities.length > 0 && <Capabilities rows={i.capabilities} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    </>
  )
}

function Capabilities({ rows }: { rows: WifiItem['capabilities'] }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Show each operation</summary>
      <ul className="mt-1 space-y-0.5">
        {rows.map((c) => (
          <li key={c.operation}>
            {c.label}: <span className={SUPPORT_TONE[c.support]}>{c.labValidated && c.support === 'supported' ? 'Tested in the lab' : SUPPORT_WORDS[c.support]}</span>
            {c.source ? <span className="text-xs text-muted-foreground"> (source {c.source})</span> : <span className="text-xs text-muted-foreground"> (no documentation found)</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}
