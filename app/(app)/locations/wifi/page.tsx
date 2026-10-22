import { WifiInventoryTable } from '@/components/wifi/WifiInventoryTable'
import { FormAlert } from '@/components/ui/form-alert'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/select'
import { requireCapability } from '@/lib/auth/profile'
import { createClient } from '@/lib/supabase/server'
import { wifiInventory } from '@/lib/wifi/inventory'

export const metadata = { title: 'Wi-Fi inventory' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const FIELD = 'h-10 w-full rounded-sm border border-field-border bg-field px-3 text-base md:text-sm'

// P2-5c-2 brief item 4: access points, routers and switches for holders of wifi.inventory.view (requireCapability sends everybody else
// home), read through the person's OWN client: the database decides which devices they see (wifi_inventory) and lets them read the
// documented capability matrix. Filters live in the URL.
export default async function WifiInventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  await requireCapability('wifi.inventory.view')
  const res = await wifiInventory(await createClient())
  const q = one(sp.q).trim().toLowerCase()
  const location = one(sp.location)
  const kind = one(sp.kind)
  const items = res.ok ? res.items : []
  const locations = [...new Map(items.filter((i) => i.locationCode).map((i) => [i.locationCode!, i.locationName ?? i.locationCode!])).entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const kinds = [...new Set(items.map((i) => i.kind))].sort()
  const shown = items.filter((i) => (!q || `${i.name} ${i.vendor ?? ''} ${i.model ?? ''} ${i.serial ?? ''} ${i.managementIp ?? ''}`.toLowerCase().includes(q))
    && (!location || i.locationCode === location) && (!kind || i.kind === kind))
  return (
    <div className="space-y-4">
      <PageHeader
        title="Wi-Fi inventory"
        description="Access points, routers and switches of your locations, with what their documentation says they support. Nothing here changes a device."
      />
      <form method="get" className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,12rem)_auto] sm:items-end">
        <div className="space-y-1.5">
          <label htmlFor="wifi-q" className="block text-sm font-medium">Find a device</label>
          <input id="wifi-q" name="q" type="search" defaultValue={one(sp.q)} placeholder="Name, model, serial or address" className={FIELD} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="wifi-location" className="block text-sm font-medium">Location</label>
          <Select id="wifi-location" name="location" defaultValue={location} className="h-10">
            <option value="">Every location</option>
            {locations.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="wifi-kind" className="block text-sm font-medium">Kind</label>
          <Select id="wifi-kind" name="kind" defaultValue={kind} className="h-10">
            <option value="">Every kind</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </div>
        <button type="submit" className="h-10 rounded-md border border-field-border bg-background px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Show</button>
      </form>
      {!res.ok && <FormAlert tone="error">{res.error}</FormAlert>}
      <p className="text-sm text-muted-foreground">
        The capabilities come from the vendor documentation only; none of them has been tested on a real device yet. “Unverified” means the
        documentation does not say, so nothing will be done with it automatically. Wi-Fi profiles arrive with the profile module.
      </p>
      <WifiInventoryTable items={shown} />
    </div>
  )
}
