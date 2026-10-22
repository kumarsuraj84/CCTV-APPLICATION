// Puts three demo stores, their cameras, four demo devices and one demo user for each role into the LOCAL database, in a separate
// organisation called "DEMO organisation (sample data)". Nothing else in the database is touched, and every address is 127.0.0.1.
//
//   npm run demo:seed                  adds the demo data (does nothing when it is already there)
//   npm run demo:seed -- --reset       removes the demo organisation and everything in it, and nothing else
//   npm run demo:seed -- --fresh       removes it and adds it again (new passwords)
//   add --nvr-port=NNNN if the pretend NVR (npm run fake:nvr) was started on another port
//
// Needs the local stack (npm run db:start). Start `npm run fake:nvr` and `npm run worker` next to it. Stop the worker before --reset.
// The demo passwords are made up on the spot, shown once in this window and kept nowhere (not in a file, not in the database in clear).
import { existsSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { assertLocalStack, cleanupOrg } from '../tests/setup/fixtures'
import {
  DEFAULT_NVR_PORT,
  DEMO_NVR_PASSWORD,
  DEMO_NVR_USER,
  DEMO_ORG_NAME,
  DEMO_ROLES,
  DEMO_ROLE_LABELS,
  DEMO_SLUG,
  LOOPBACK,
  demoEmail,
  demoPlan,
  isDemoOrg,
  makePassword,
  parseNvrPort,
} from './lib/demo'

type Admin = SupabaseClient<Database>

/** A problem to tell the person in plain words. It ends the script with a non-zero code; no stack trace is printed. */
class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message)
}

function parseArgs(args: string[]): { reset: boolean; fresh: boolean; nvrPort: number } {
  const unknown = args.find((a) => !(a === '--reset' || a === '--fresh' || a.startsWith('--nvr-port=')))
  if (unknown) fail(`Unknown option "${unknown}". Use --reset, --fresh or --nvr-port=NNNN.`)
  const reset = args.includes('--reset')
  const fresh = args.includes('--fresh')
  if (reset && fresh) fail('Use either --reset or --fresh, not both.')
  let nvrPort = DEFAULT_NVR_PORT
  try {
    const given = args.find((a) => a.startsWith('--nvr-port='))
    if (given) nvrPort = parseNvrPort(given.slice('--nvr-port='.length))
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  return { reset, fresh, nvrPort }
}

async function findDemoOrg(admin: Admin): Promise<{ id: string; slug: string; name: string } | null> {
  const { data, error } = await admin.from('organizations').select('id, slug, name').eq('slug', DEMO_SLUG).maybeSingle()
  if (error) throw new Error(`Could not look for the demo organisation: ${error.message}`)
  return data
}

/** Removing demo data while the checker runs could leave status rows behind, so the checker must be stopped first. */
async function assertWorkerStopped(admin: Admin): Promise<void> {
  const { data } = await admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
  if (data?.last_heartbeat && Date.now() - new Date(data.last_heartbeat).getTime() < 30_000) {
    fail('The monitoring worker is running. Stop it (Ctrl+C in its window) and try again.')
  }
}

async function removeDemo(admin: Admin): Promise<boolean> {
  const org = await findDemoOrg(admin)
  if (!org) return false
  // Never delete anything that is not the demo organisation.
  if (!isDemoOrg(org)) fail(`An organisation with the slug "${DEMO_SLUG}" exists but is not the demo one. Not touching it.`)
  await assertWorkerStopped(admin)
  await cleanupOrg(org.id) // NVR passwords out of the vault, then the rows, the demo people and the organisation
  return true
}

async function addDemo(admin: Admin, nvrPort: number): Promise<void> {
  const { data: org, error: orgError } = await admin.from('organizations').insert({ name: DEMO_ORG_NAME, slug: DEMO_SLUG }).select('id').single()
  if (orgError || !org) throw new Error(`Could not create the demo organisation: ${orgError?.message}`)
  const orgId = org.id
  const passwords: { role: (typeof DEMO_ROLES)[number]; email: string; password: string }[] = []
  try {
    const plan = demoPlan(nvrPort)
    const storeIds: Record<string, string> = {}
    for (const s of plan.stores) {
      const { data, error } = await admin
        .from('stores')
        .insert({
          org_id: orgId, code: s.code, name: s.name, city: s.city, zone: s.zone,
          nvr_ip: LOOPBACK, http_port: s.httpPort, rtsp_port: s.rtspPort, nvr_username: DEMO_NVR_USER, expected_channels: s.cameras,
        })
        .select('id')
        .single()
      if (error || !data) throw new Error(`store ${s.code}: ${error?.message}`)
      storeIds[s.code] = data.id
      // The NVR password goes into the vault through the same helper the app uses, never into a table.
      const cred = await admin.rpc('nvr_store_credential', { p_store: data.id, p_secret: DEMO_NVR_PASSWORD })
      if (cred.error) throw new Error(`password for ${s.code}: ${cred.error.message}`)
      const cams = await admin
        .from('cameras')
        .insert(Array.from({ length: s.cameras }, (_, i) => ({ org_id: orgId, store_id: data.id, channel: i + 1, name: `Camera ${i + 1}` })))
      if (cams.error) throw new Error(`cameras of ${s.code}: ${cams.error.message}`)
    }
    const devs = await admin.from('devices').insert(
      plan.devices.map((d) => ({ org_id: orgId, store_id: d.storeCode ? storeIds[d.storeCode] : null, type: d.type, name: d.name, ip: LOOPBACK, tcp_port: d.port })),
    )
    if (devs.error) throw new Error(`devices: ${devs.error.message}`)

    for (const role of DEMO_ROLES) {
      const email = demoEmail(role)
      const password = makePassword()
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (created.error || !created.data.user) throw new Error(`user ${role}: ${created.error?.message}`)
      const id = created.data.user.id
      const profile = await admin
        .from('profiles')
        .insert({ id, org_id: orgId, email, full_name: `Demo ${DEMO_ROLE_LABELS[role]}`, role, must_reset_password: false })
      if (profile.error) throw new Error(`profile ${role}: ${profile.error.message}`)
      // Viewers and operators see only the stores they are given; managers and administrators see everything.
      const mine = plan.stores.filter((s) => (role === 'user' || role === 'agent') && s.viewers.includes(role))
      if (mine.length) {
        const grants = await admin.from('user_store_access').insert(mine.map((s) => ({ org_id: orgId, user_id: id, store_id: storeIds[s.code] })))
        if (grants.error) throw new Error(`access for ${role}: ${grants.error.message}`)
      }
      passwords.push({ role, email, password })
    }
  } catch (e) {
    // Leave nothing half-made behind.
    await cleanupOrg(orgId).catch((c) => console.error('Clean-up after the failure also failed:', c instanceof Error ? c.message : c))
    throw e
  }

  console.log('Demo data added: stores DEMO1, DEMO2, DEMO3 (14 cameras) and 4 devices, all pointing at this computer (127.0.0.1).')
  console.log('DEMO2 has no NVR listening on purpose (shows as down), and so has the footfall counter. Camera 3 on the pretend NVR is offline.')
  console.log('')
  console.log('Demo people. These passwords are shown now and are NOT saved anywhere:')
  for (const p of passwords) console.log(`  ${DEMO_ROLE_LABELS[p.role].padEnd(15)} ${p.email.padEnd(40)} ${p.password}`)
  console.log('')
  console.log('Next: run `npm run fake:nvr` and `npm run worker`, sign in, press "Find cameras" for DEMO1 on Manage stores, then "Check now" on Monitoring.')
  console.log('Remove all of it with `npm run demo:seed -- --reset` (stop the worker first).')
}

async function main() {
  const { reset, fresh, nvrPort } = parseArgs(process.argv.slice(2))
  if (existsSync('.env.local')) process.loadEnvFile('.env.local')
  try {
    assertLocalStack()
  } catch {
    fail('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed (npm run env:local).')
  const admin = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  if (reset || fresh) {
    console.log((await removeDemo(admin)) ? 'The demo organisation and everything in it were removed.' : 'There is no demo data to remove.')
    if (reset) return
  }
  if (await findDemoOrg(admin)) {
    console.log('The demo data is already there, so nothing was changed. (Use --fresh to remove it and add it again with new passwords.)')
    return
  }
  await addDemo(admin, nvrPort)
}

// Not process.exit(): on Windows that can crash node while connections are still closing. Setting the code lets it end by itself.
main().catch((e) => {
  console.error(e instanceof Stop ? e.message : e instanceof Error ? e.message : e)
  process.exitCode = 1
})
