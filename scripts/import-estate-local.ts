// Imports the estate CSV (location name, city, zone, NVR address/ports/user/password, channel count) into the LOCAL database through the
// same code as the Import page (ruling R-1: the file is read from where it is, never copied into the repo, and nothing from it is printed
// except counts and row numbers; passwords go straight into the Vault).
//
//   npm run import:estate -- "\\10.0.0.45\Store Soft\stores_sample.csv"            validates only (dry run, nothing written)
//   npm run import:estate -- "<path>" --apply                                       writes to the local database
//
// Needs the local stack (npm run db:start) and the local administrator (npm run admin:create or the platform owner already there).
import { readFileSync } from 'node:fs'
import { createAdminClient } from '../lib/supabase/admin'
import { parseStoresCsv } from '../lib/import/stores-csv'
import { importStores } from '../lib/import/apply'
import type { Role } from '../lib/admin/roles'

process.loadEnvFile('.env.local')
const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.invalid')
if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '55321') {
  console.error('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  process.exit(1)
}
const path = process.argv[2]
const apply = process.argv.includes('--apply')
if (!path || path.startsWith('--')) {
  console.error('Give the path of the CSV file.')
  process.exit(1)
}

const parsed = parseStoresCsv(readFileSync(path, 'utf8'))
console.log(`Read ${parsed.rows.length} locations; ${parsed.errors.length} rows have problems.`)
for (const e of parsed.errors.slice(0, 20)) console.log(`  line ${e.line}: ${e.message}`)
console.log(`Cameras expected: ${parsed.rows.reduce((n, r) => n + r.recorder.channels, 0)}.`)
if (!apply) {
  console.log('Dry run: nothing written. Add --apply to import.')
  process.exit(0)
}

async function main() {
  const admin = createAdminClient()
  const { data: org } = await admin.from('organizations').select('id').eq('slug', 'citykart').single()
  if (!org) throw new Error('Organisation "citykart" not found.')
  const { data: owner } = await admin.from('profiles').select('id, role').eq('org_id', org.id).eq('role', 'platform_owner').eq('is_active', true).limit(1).maybeSingle()
  if (!owner) throw new Error('No active platform owner found.')
  const result = await importStores(admin, { id: owner.id, orgId: org.id, role: owner.role as Role }, parsed.rows)
  console.log(`Created ${result.created}, updated ${result.updated}, errors ${result.errors.length}, warnings ${result.warnings?.length ?? 0}.`)
  for (const e of result.errors.slice(0, 30)) console.log(`  line ${e.line}: ${e.message}`)
  for (const w of (result.warnings ?? []).slice(0, 30)) console.log(`  warning line ${w.line}: ${w.message}`)
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
