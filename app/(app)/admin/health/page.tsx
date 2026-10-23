import { redirect } from 'next/navigation'
import { HealthChecks } from '@/components/admin/HealthChecks'
import { AutoRefresh } from '@/components/monitor/AutoRefresh'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { isSuperAdministrator } from '@/lib/ops/access'
import { readDetailedHealth } from '@/lib/ops/health-server'

export const metadata = { title: 'Health' }

// P5.4 brief item 3: the health of this installation for super administrators — database, Vault, video gateway, worker (lease,
// heartbeat, clocks), migration level, free disk and the clean-up of unused video sessions. Reads only; refreshes every 30 seconds.
export default async function HealthPage() {
  const me = await requireProfile()
  if (!isSuperAdministrator(me)) redirect('/home')
  const health = await readDetailedHealth()
  return (
    <div className="space-y-4">
      <AutoRefresh busy={false} everyMs={30_000} />
      <PageHeader
        title="Health"
        description="Is every part of Drishti running? What to do about a problem: docs/drishti/runbooks (incidents, start-up and shut-down)."
      />
      <HealthChecks health={health} />
    </div>
  )
}
