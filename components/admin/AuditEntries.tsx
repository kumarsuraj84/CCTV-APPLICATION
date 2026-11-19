import type { AuditRow } from '@/lib/admin/audit-view'
import { formatDateTime } from '@/lib/time'

// The entries of the audit log (P5.4 brief item 5). Final clean-up (review C M-21): readable at 375 px. On a phone every entry is a
// stacked card with its labels; from the small breakpoint up the five-column table is shown (it may scroll sideways inside its frame).
export function AuditEntries({ rows }: { rows: AuditRow[] }) {
  return (
    <>
      <ul className="space-y-2 sm:hidden" aria-label="Audit entries, newest first">
        {rows.map((r) => (
          <li key={r.id} className="rounded-xl border bg-card p-3 text-sm">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
              <dt className="text-muted-foreground">When</dt>
              <dd>{formatDateTime(r.at)}</dd>
              <dt className="text-muted-foreground">Who</dt>
              <dd className="break-words"><span translate="no">{r.who}</span></dd>
              <dt className="text-muted-foreground">What</dt>
              <dd className="break-words font-medium">{r.what}</dd>
              <dt className="text-muted-foreground">About</dt>
              <dd className="break-words"><span translate="no">{r.target}</span></dd>
              <dt className="text-muted-foreground">Details</dt>
              <dd className="break-words text-muted-foreground">{r.detail}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border bg-card sm:block">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Audit entries, newest first</caption>
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="px-3 py-2 font-medium">When</th>
              <th scope="col" className="px-3 py-2 font-medium">Who</th>
              <th scope="col" className="px-3 py-2 font-medium">What</th>
              <th scope="col" className="px-3 py-2 font-medium">About</th>
              <th scope="col" className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2">{formatDateTime(r.at)}</td>
                <td className="px-3 py-2"><span translate="no">{r.who}</span></td>
                <td className="px-3 py-2">{r.what}</td>
                <td className="px-3 py-2"><span translate="no">{r.target}</span></td>
                <td className="max-w-[28rem] break-words px-3 py-2 text-muted-foreground">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
