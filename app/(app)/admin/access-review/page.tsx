import { AccessReviewList, type ReviewGroup } from '@/components/admin/AccessReviewList'
import { formatDay, SOURCE_LABELS } from '@/components/admin/access-labels'
import { BADGE, STATUS } from '@/components/admin/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { listReview } from '@/lib/admin/access'
import { istDate, manageRefusal } from '@/lib/admin/access-rules'
import type { Role } from '@/lib/admin/roles'
import { requireAdministration } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Access review' }

// P2-3 (D-2a): the grants that the move to the capability model created from the old home-location rule, the manager role and the
// administrator role, and the notes of that move (including people who deliberately lost the view of IT devices, AC-4).
// The administrative role AND admin.access, like the editor.
export default async function AccessReviewPage() {
  const me = await requireAdministration('admin.access')
  const review = await listReview(createAdminClient(), me.org_id)
  const groups = new Map<string, ReviewGroup>()
  for (const i of review.open) {
    const g = groups.get(i.userId) ?? {
      userId: i.userId, personName: i.personName, personEmail: i.personEmail, personRole: i.personRole, personActive: i.personActive, items: [], self: i.userId === me.id,
      manageable: manageRefusal({ actorRole: me.role, actorId: me.id, targetId: i.userId, targetRole: (i.personRole || 'user') as Role }) === null || i.userId === me.id,
    }
    g.items.push(i)
    groups.set(i.userId, g)
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Access review"
        description="Access that was moved over from the old rules (home location, manager role, administrator role). Keep it, remove it, or replace it with narrower grants."
        breadcrumbs={[{ label: 'Users', href: '/admin/users' }, { label: 'Access review' }]}
      />
      <p className={STATUS} role="status">
        {review.openCount === 0 ? 'Nothing is waiting for review.' : `${review.openCount} ${review.openCount === 1 ? 'grant is' : 'grants are'} waiting for review, for ${groups.size} ${groups.size === 1 ? 'person' : 'people'}.`}
      </p>

      <AccessReviewList groups={[...groups.values()]} />

      <section aria-labelledby="notes" className="space-y-2">
        <h2 id="notes" className="text-base font-semibold">Notes from the move to the new access model</h2>
        {review.notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes.</p> : (
          <ul className="space-y-2">
            {review.notes.map((n) => (
              <li key={n.userId} className="rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.personName}</span>
                  {n.lostDevices && <span className={BADGE.warn}>No longer sees IT devices (on purpose)</span>}
                  <span className="text-xs text-muted-foreground">{formatDay(istDate(n.createdAt))}</span>
                </div>
                <p className="mt-1">{n.note}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">A CCTV grant no longer shows IT devices. People who saw devices only through a location, zone or home-location grant lost that view on purpose; give them an IT right if they need it.</p>
      </section>

      <details className="rounded-xl border bg-card p-4">
        <summary className="cursor-pointer text-base font-semibold">Already reviewed and kept ({review.kept.length})</summary>
        {review.kept.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">None yet.</p> : (
          <ul className="mt-2 space-y-1 text-sm">
            {review.kept.map((k) => <li key={k.grantId}>{k.personName} · {k.capabilityLabel} · {k.scopeLabel} · {SOURCE_LABELS[k.source] ?? k.source} · kept {formatDay(istDate(k.keptAt!))}</li>)}
          </ul>
        )}
      </details>
    </div>
  )
}
