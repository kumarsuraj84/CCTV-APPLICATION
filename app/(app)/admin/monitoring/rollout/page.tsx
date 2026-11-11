import Link from 'next/link'
import { MonitoringRollout } from '@/components/admin/MonitoringRollout'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireAdministration } from '@/lib/auth/profile'
import { loadRolloutOverview } from '@/lib/inventory/monitoring-rollout'
import { createAdminClient } from '@/lib/supabase/admin'

export const metadata = { title: 'Monitoring rollout' }

// Final fix X (release 1 review C I-4; ruling NB-4): switch monitoring on or off for a whole location, cluster, region or the
// organisation (docs/drishti/runbooks/monitoring-rollout.md). The page needs an administrative role and admin.inventory; the change
// itself asks for a fresh sign-in (lib/actions/admin/monitoring.ts).
export default async function MonitoringRolloutPage() {
  const me = await requireAdministration('admin.inventory')
  const overview = await loadRolloutOverview(createAdminClient(), me.org_id)
  return (
    <div className="space-y-6">
      <PageHeader title="Monitoring rollout" description="Which NVRs the system may contact, switched on or off by location, cluster or region." />
      <p className="text-sm">
        <Link className="underline underline-offset-2" href="/admin/monitoring">Back to Monitoring</Link>
      </p>
      <MonitoringRollout overview={overview} />
      <section className="space-y-2" aria-labelledby="by-region">
        <h2 id="by-region" className="font-medium">By region</h2>
        {overview.regions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No regions yet: switch locations on one by one, or all at once.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">NVRs with monitoring on and off, per region</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-normal">Region</th>
                <th scope="col" className="py-1 pr-3 font-normal">On</th>
                <th scope="col" className="py-1 font-normal">Off</th>
              </tr>
            </thead>
            <tbody>
              {overview.regions.map((g) => (
                <tr key={g.id} className="border-t">
                  <td className="py-1 pr-3"><span translate="no">{g.code}</span> · {g.name}</td>
                  <td className="py-1 pr-3">{g.on}</td>
                  <td className="py-1">{g.off}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-sm text-muted-foreground">
          All NVRs: {overview.totals.on} on, {overview.totals.off} off.
        </p>
      </section>
    </div>
  )
}
