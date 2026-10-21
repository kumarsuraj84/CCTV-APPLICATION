import { ImportForm } from '@/components/admin/ImportForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { importDevicesAction, importStoresAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'

export const metadata = { title: 'Import' }

export default async function ImportPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <PageHeader title="Import" description="Add or update many stores or devices from a CSV file." />
      <ImportForm
        title="Stores"
        help="Columns: name, city, zone, ip, port, http_port, user, password, channels (optional: code, state, address). Importing the same store again updates it; leave the password empty to keep the saved one."
        sampleHref="/samples/stores-sample.csv"
        action={importStoresAction}
      />
      <ImportForm
        title="Devices"
        help="Columns: name, type (nvr, server, attendance, footfall, other), store_code (optional), ip, port (optional), notes (optional)."
        sampleHref="/samples/devices-sample.csv"
        action={importDevicesAction}
      />
    </div>
  )
}
