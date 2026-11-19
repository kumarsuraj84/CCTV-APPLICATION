// Imports the estate CSV (location name, city, zone, NVR address/ports/user/password, channel count) into the LOCAL database through the
// same code as the Import page (ruling R-1: the file is read from where it is, never copied into the repo, and nothing from it is printed
// — only COUNTS, and problems as counts per line number and column; passwords go straight into the Vault).
//
// P2-5c-2: the validated import. Without --apply it is a dry run: it reads the file and the local inventory (read-only) and prints what
// the import WOULD do (new / changed / unchanged locations and NVRs, passwords to save, new cameras, what is not in the file). With
// --apply the same plan is saved in ONE transaction (all or nothing), like the Import page. It never contacts an NVR.
//
//   npx tsx scripts/import-estate-local.ts "\\10.0.0.45\Store Soft\stores_sample.csv"            dry run (nothing written)
//   npx tsx scripts/import-estate-local.ts "<path>" --apply [--skip-bad-rows] [--keep-names]      writes to the local database
//
// Needs the local stack (npm run db:start) and the local super administrator of the "citykart" organisation.
import { readFileSync } from 'node:fs'
import { createAdminClient } from '../lib/supabase/admin'
import { prepareImport, runImportPlan } from '../lib/import/locations-import'
import type { Role } from '../lib/admin/roles'

process.loadEnvFile('.env.local')
const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.invalid')
if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '55321') {
  console.error('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  process.exit(1)
}
const path = process.argv[2]
const apply = process.argv.includes('--apply')
const skipBadRows = process.argv.includes('--skip-bad-rows')
if (!path || path.startsWith('--')) {
  console.error('Give the path of the CSV file.')
  process.exit(1)
}

/** Problems as counts per column (no cell value is ever printed). */
const byColumn = (issues: { column?: string }[]) => Object.entries(issues.reduce<Record<string, number>>((m, i) => ((m[i.column ?? '(file)'] = (m[i.column ?? '(file)'] ?? 0) + 1), m), {}))
  .map(([c, n]) => `${c}: ${n}`).join(', ') || 'none'

async function main() {
  const admin = createAdminClient()
  const { data: org } = await admin.from('organizations').select('id').eq('slug', 'citykart').single()
  if (!org) throw new Error('Organisation "citykart" not found.')
  const { data: owner } = await admin.from('profiles').select('id, role').eq('org_id', org.id).eq('role', 'platform_owner').eq('is_active', true).limit(1).maybeSingle()
  if (!owner) throw new Error('No active platform owner found.')
  const actor = { id: owner.id, orgId: org.id, role: owner.role as Role }
  const started = Date.now()
  const { preview, apply: plan, stamp } = await prepareImport(admin, actor, readFileSync(path!, 'utf8'), { skipBadRows, keepNames: process.argv.includes('--keep-names') })
  const c = preview.counts
  console.log(`Rows read: ${preview.rows}. Problems: ${preview.errors.length} (by column: ${byColumn(preview.errors)}). Worth a look: ${preview.warnings.length} (by column: ${byColumn(preview.warnings)}).`)
  console.log(`Locations: ${c.locationsNew} new, ${c.locationsChanged} changing, ${c.locationsUnchanged} unchanged, ${c.locationsSkipped} skipped.`)
  console.log(`NVRs: ${c.recordersNew} new, ${c.recordersChanged} changing, ${c.recordersUnchanged} unchanged. Passwords given: ${c.passwordsSet} (written only where different). New cameras: ${c.camerasNew}, linked again: ${c.camerasRelinked}.`)
  const changes = preview.locations.flatMap((l) => l.changes.map((x) => `location ${x.replace(/ [A-Z0-9-]+$/, '')}`).concat(l.recorders.flatMap((r) => r.changes.map((x) => `NVR ${x.replace(/^\d+ /, 'n ')}`))))
  const kinds = Object.entries(changes.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none'
  console.log(`What changes (counts): ${kinds}.`)
  console.log(`Not in the file (listed only): ${c.archiveLocations} locations, ${c.archiveRecorders} NVRs, ${c.archiveCameras} cameras. New regions: ${c.regionsNew}, new clusters: ${c.clustersNew}.`)
  console.log(`Worked out in ${Date.now() - started} ms.`)
  if (!apply) {
    console.log('Dry run: nothing written. Add --apply to import.')
    return
  }
  if (preview.errors.length > 0 && !skipBadRows) throw new Error('The file has problems; nothing written. Fix them or add --skip-bad-rows.')
  if (!preview.canApply) throw new Error('Nothing in this file can be imported.')
  const t = Date.now()
  const done = await runImportPlan({ admin }, actor, plan, preview.warnings, stamp)
  if (!done.ok) throw new Error(done.error)
  const r = done.result
  console.log(`Saved in one go in ${Date.now() - t} ms: locations ${r.locationsCreated} added / ${r.locationsUpdated} changed; NVRs ${r.recordersCreated} added / ${r.recordersUpdated} changed; passwords given ${r.passwordsGiven} (written only where different); cameras ${r.camerasCreated} added, ${r.camerasRelinked} linked again.`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
