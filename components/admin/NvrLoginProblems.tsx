'use client'

import Link from 'next/link'
import { useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { tryNvrLoginAgainAction } from '@/lib/actions/admin/monitoring'
import type { NvrLoginProblem } from '@/lib/inventory/monitoring-rollout'
import { formatDateTime } from '@/lib/time'

// Final fix X (release 1 review C I-1/M-19; ruling NB-3): the NVRs whose saved login was refused. Nothing contacts them until their
// wait is over (15 minutes, doubling to 6 hours) or their saved login changes; "Try again" ends the wait once the password was fixed on
// the NVR itself. Each entry links to its NVR.

const STATE: Record<NvrLoginProblem['state'], string> = {
  refused: 'Login refused',
  paused: 'Refused 3 logins in 30 minutes',
  waiting: 'Login refused; one try at the next check',
}

export function NvrLoginProblems({ problems }: { problems: NvrLoginProblem[] }) {
  const [pending, start] = useTransition()
  if (problems.length === 0) return null
  return (
    <section className="space-y-2" aria-labelledby="nvr-login-problems">
      <h2 id="nvr-login-problems" className="font-medium">NVR login problems ({problems.length})</h2>
      <p className="text-sm text-muted-foreground">
        These NVRs refused their saved user name or password. To protect their accounts nothing contacts them for a while (no checks,
        no live video, no playback). Fix the password on the NVR page (a new password is tried at once), or fix it on the NVR itself and
        press Try again.
      </p>
      <ul className="divide-y rounded-xl border bg-card text-sm">
        {problems.map((p) => (
          <li key={p.recorderId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0">
              <Link className="underline underline-offset-2" href={`/admin/locations/${p.locationId}/nvrs/${p.recorderId}`}>
                <span translate="no">{p.locationCode}</span> · {p.locationName} · NVR {p.nvrName}
              </Link>
              <span className="block text-muted-foreground">
                {STATE[p.state]}
                {p.until ? `, left alone until ${formatDateTime(p.until)}` : ''}
                {p.level > 1 ? ` (refused ${p.level} times in a row)` : ''}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || p.state === 'paused'}
              aria-label={`Try the login of ${p.locationCode} NVR ${p.nvrName} again`}
              onClick={() =>
                start(async () => {
                  try {
                    const res = await tryNvrLoginAgainAction(p.recorderId)
                    if (res.error) toast.error(res.error)
                    else toast.success(res.message ?? 'Done.')
                  } catch {
                    toast.error('Could not send the request. Check your connection and try again.')
                  }
                })
              }
            >
              Try again
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
