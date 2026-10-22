import { ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-react'
import { freshAuthRefusal, sessionPolicy } from '@/lib/auth/session-policy'
import type { SessionStatus } from '@/lib/auth/session-status'
import { formatDateTime } from '@/lib/time'

/**
 * P3-1 (D-10): at the top of the pages whose changes need a fresh sign-in (people, access, access review, NVR passwords, the location
 * import). Says whether changes are allowed now and until when, and offers "Confirm it's you" in a NEW tab, so nothing typed on this
 * page is lost; after confirming there, this page's next save works.
 */
export function FreshAuthNotice({ session, what = 'Changes on this page' }: { session: SessionStatus | null; what?: string }) {
  const { freshMinutes } = sessionPolicy()
  const ok = freshAuthRefusal({ session }) === null
  const until = ok && session?.lastAuthAt ? formatDateTime(new Date((session.lastAuthAt + freshMinutes * 60) * 1000)) : null
  return (
    <div
      role="status"
      className={`mb-4 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between ${ok ? 'border-success-strong/40 bg-success-soft/40' : 'border-warning-strong/50 bg-warning-soft/40'}`}
    >
      <p className="flex items-start gap-2">
        {ok ? <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-strong" /> : <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-strong" />}
        <span>
          {ok ? (
            <>
              You confirmed it is you. {what} can be saved until <time translate="no">{until?.split(', ')[1] ?? until}</time> (IST).
            </>
          ) : (
            <>
              {what} need you to confirm it is you (a sign-in or code within the last {freshMinutes} minutes).
            </>
          )}
        </span>
      </p>
      <a
        href="/confirm"
        target="_blank"
        rel="noopener"
        className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border bg-background px-3 py-1.5 font-medium hover:bg-muted sm:self-auto"
      >
        Confirm it’s you
        <ExternalLink aria-hidden="true" className="size-3.5" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </div>
  )
}
