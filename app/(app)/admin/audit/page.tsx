import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { auditHref, parseAuditFilters, readAuditPage, type AuditFilters } from '@/lib/admin/audit-view'
import { AUDIT_ACTIONS, AUDIT_CATEGORY_LABELS, type AuditCategory } from '@/lib/audit/catalogue'
import { requireAdministration } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/time'

export const metadata = { title: 'Audit log' }

// P5.4 brief item 5: the audit log with filters and search. Administrators with admin.audit.read for the whole organisation; the rows
// are read through the person's own sign-in (the database checks the right again). Reads only. Rows can never be changed or removed.
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireAdministration('admin.audit.read')
  const f: AuditFilters = parseAuditFilters(await searchParams)
  const result = await readAuditPage(await createClient(), createAdminClient(), me.org_id, f)
  const table = f.kind === 'sign_ins' ? 'auth_events' : 'admin_audit_log'
  const categories = (Object.keys(AUDIT_CATEGORY_LABELS) as AuditCategory[]).filter((c) => AUDIT_ACTIONS.some((a) => a.table === table && a.category === c))
  const actions = AUDIT_ACTIONS.filter((a) => a.table === table && (!f.category || a.category === f.category))

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Who did what, and every sign-in. Newest first; times in India time. Entries can never be changed or removed." />
      <nav aria-label="Kind of entry" className="flex flex-wrap gap-2 text-sm">
        {(['actions', 'sign_ins'] as const).map((k) => (
          <Link
            key={k}
            href={auditHref({ ...f, category: null, action: null, page: 0 }, { kind: k })}
            aria-current={f.kind === k ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] ${f.kind === k ? 'bg-primary text-primary-foreground' : 'bg-card'}`}
          >
            {k === 'actions' ? 'Actions' : 'Sign-ins'}
          </Link>
        ))}
      </nav>
      <form method="get" action="/admin/audit" className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        {f.kind === 'sign_ins' && <input type="hidden" name="kind" value="sign_ins" />}
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-category">Category</label>
          <Select id="audit-category" name="category" defaultValue={f.category ?? ''}>
            <option value="">Any</option>
            {categories.map((c) => <option key={c} value={c}>{AUDIT_CATEGORY_LABELS[c]}</option>)}
          </Select>
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-action">What happened</label>
          <Select id="audit-action" name="action" defaultValue={f.action ?? ''}>
            <option value="">Anything</option>
            {actions.map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
          </Select>
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-person">Person (name or e-mail)</label>
          <Input id="audit-person" name="person" defaultValue={f.person ?? ''} maxLength={80} autoComplete="off" />
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-q">Search</label>
          <Input id="audit-q" name="q" defaultValue={f.q ?? ''} maxLength={60} placeholder="for example archived" autoComplete="off" />
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-from">From (day)</label>
          <Input id="audit-from" type="date" name="from" defaultValue={f.from ?? ''} />
        </div>
        <div className="grid gap-1 text-sm">
          <label htmlFor="audit-to">To (day)</label>
          <Input id="audit-to" type="date" name="to" defaultValue={f.to ?? ''} />
        </div>
        <div className="flex items-end gap-2 sm:col-span-2">
          <button type="submit" className={buttonVariants()}>Show</button>
          <Link href={auditHref({ kind: f.kind, category: null, action: null, person: null, from: null, to: null, q: null, page: 0 })} className={buttonVariants({ variant: 'outline' })}>Clear</Link>
        </div>
      </form>

      {'error' in result ? (
        <p role="alert" className="text-sm text-destructive">{result.error}</p>
      ) : result.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches these filters.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-card">
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
                {result.rows.map((r) => (
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
          <nav aria-label="Pages" className="flex gap-2 text-sm">
            {f.page > 0 && <Link href={auditHref(f, { page: f.page - 1 })} className="rounded-md border px-3 py-1.5">Newer</Link>}
            {result.hasMore && <Link href={auditHref(f, { page: f.page + 1 })} className="rounded-md border px-3 py-1.5">Older</Link>}
          </nav>
        </>
      )}
    </div>
  )
}
