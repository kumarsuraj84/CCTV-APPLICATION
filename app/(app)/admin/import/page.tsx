import { ImportForm } from '@/components/admin/ImportForm'
import { LocationImport } from '@/components/admin/import/LocationImport'
import { Section } from '@/components/admin/inventory/fields'
import { PageHeader } from '@/components/ui/PageHeader'
import { importDevicesAction } from '@/lib/actions/admin/inventory'
import { requireAdministration } from '@/lib/auth/profile'
import { DEVICES_IMPORT_HELP } from '@/lib/import/help'

export const metadata = { title: 'Import' }

const LINK = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export default async function ImportPage() {
  await requireAdministration('admin.inventory') // P2-2: an administrative role AND admin.inventory
  return (
    <div className="space-y-6">
      <PageHeader title="Import" description="Add or update many locations, NVRs or devices from a CSV file." />
      {/* P2-5c-2: the validated location import (check first, then import in one go). The guide: docs/drishti/admin-guide-import.md. */}
      <Section
        id="import-locations"
        title="Locations and NVRs"
        description="Check the file first: nothing is saved until you press Import, and then everything is saved in one go (or nothing). Importing the same file again changes nothing."
        actions={<a href="/samples/locations-sample.csv" download className={LINK}>Download a sample file</a>}
      >
        <LocationImport />
      </Section>
      <ImportForm
        title="Devices"
        help={DEVICES_IMPORT_HELP}
        sampleHref="/samples/devices-sample.csv"
        action={importDevicesAction}
      />
    </div>
  )
}
