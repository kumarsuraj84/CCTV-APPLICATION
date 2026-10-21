import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES } from '@/lib/inventory/device-types'
import { homeCounts } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  const counts = await homeCounts(await createClient())
  const tile = (label: string, value: number, href: string) => (
    <Link href={href} className="rounded-xl border bg-card p-4 hover:bg-muted">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Link>
  )
  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${profile.full_name || profile.email}`} description="What you can see right now." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile('Stores', counts.stores, '/stores')}
        {tile('Cameras', counts.cameras, '/stores')}
        {DEVICE_TYPES.filter((t) => counts.devices[t]).map((t) => tile(DEVICE_TYPE_LABELS[t] + 's', counts.devices[t], `/devices?type=${t}`))}
      </div>
      {counts.stores === 0 && counts.cameras === 0 && (
        <p className="text-sm text-muted-foreground">You have not been given access to anything yet. Ask an administrator.</p>
      )}
    </div>
  )
}
