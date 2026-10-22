// Puts three demo locations, their NVRs (one location has two) and cameras, four demo devices and one demo user for each role into the
// LOCAL database, in a separate organisation called "DEMO organisation (sample data)". Nothing else in the database is touched, and every
// address is 127.0.0.1.
//
//   npm run demo:seed                  adds the demo data (does nothing when it is already there)
//   npm run demo:seed -- --reset       removes the demo organisation and everything in it, and nothing else
//   npm run demo:seed -- --fresh       removes it and adds it again (new passwords)
//   add --nvr-port=NNNN / --second-nvr-port=NNNN if the pretend NVRs (npm run fake:nvr) were started on other ports
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
  FAKE_ATTENDANCE_2_PORT,
  FAKE_ATTENDANCE_PORT,
  FAKE_ERP_PORT,
  FAKE_RTSP_2_PORT,
  FAKE_RTSP_PORT,
  LOOPBACK,
  SECOND_NVR_PORT,
  demoEmail,
  demoGrants,
  demoPlan,
  isDemoOrg,
  makePassword,
  parseNvrPort,
} from './lib/demo'
import { findClosedPorts } from './lib/ports'

type Admin = SupabaseClient<Database>

/** A problem to tell the person in plain words. It ends the script with a non-zero code; no stack trace is printed. */
class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message)
}

function parseArgs(args: string[]): { reset: boolean; fresh: boolean; nvrPort: number; secondNvrPort: number } {
  const unknown = args.find((a) => !(a === '--reset' || a === '--fresh' || a.startsWith('--nvr-port=') || a.startsWith('--second-nvr-port=')))
  if (unknown) fail(`Unknown option "${unknown}". Use --reset, --fresh, --nvr-port=NNNN or --second-nvr-port=NNNN.`)
  const reset = args.includes('--reset')
  const fresh = args.includes('--fresh')
  if (reset && fresh) fail('Use either --reset or --fresh, not both.')
  let nvrPort = DEFAULT_NVR_PORT
  let secondNvrPort = SECOND_NVR_PORT
  try {
    const given = args.find((a) => a.startsWith('--nvr-port='))
    if (given) nvrPort = parseNvrPort(given.slice('--nvr-port='.length))
    const second = args.find((a) => a.startsWith('--second-nvr-port='))
    if (second) secondNvrPort = parseNvrPort(second.slice('--second-nvr-port='.length))
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
  return { reset, fresh, nvrPort, secondNvrPort }
}

async function findDemoOrg(admin: Admin): Promise<{ id: string; slug: string; name: string } | null> {
  const { data, error } = await admin.from('organizations').select('id, slug, name').eq('slug', DEMO_SLUG).maybeSingle()
  if (error) throw new Error(`Could not look for the demo organisation: ${error.message}`)
  return data
}

/** Removing demo data while the checker runs could leave status rows behind, so the checker must be stopped first. */
async function assertWorkerStopped(admin: Admin): Promise<void> {
  // Fails closed: when it cannot be read whether the worker runs, nothing is removed.
  const { data, error } = await admin.from('worker_state').select('last_heartbeat').eq('id', 1).single()
  if (error || !data) fail('Could not check whether the monitoring worker is running, so nothing was removed. Check that the local database is up and try again.')
  if (data.last_heartbeat && Date.now() - new Date(data.last_heartbeat).getTime() < 30_000) {
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

/**
 * A demo sign-in left behind by a run that stopped half way (the person exists, the profile does not) would make the next run fail with
 * "already registered". Such leftovers are removed; a demo e-mail that belongs to a real profile is never touched.
 */
async function removeLeftoverDemoUsers(admin: Admin): Promise<void> {
  const wanted = new Set(DEMO_ROLES.map((r) => demoEmail(r)))
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) fail('Could not look for leftover demo sign-ins: ' + error.message)
    for (const u of data.users) {
      if (!u.email || !wanted.has(u.email.toLowerCase())) continue
      const { data: profile, error: pErr } = await admin.from('profiles').select('id').eq('id', u.id).maybeSingle()
      if (pErr) fail('Could not look for leftover demo sign-ins: ' + pErr.message)
      if (profile) fail(`The e-mail ${u.email} already belongs to a person outside the demo. Not touching it.`)
      const del = await admin.auth.admin.deleteUser(u.id)
      if (del.error) fail('Could not remove a leftover demo sign-in: ' + del.error.message)
    }
    if (data.users.length < 1000) return
  }
}

async function addDemo(admin: Admin, nvrPort: number, secondNvrPort: number): Promise<void> {
  // The offline targets must really be offline: ports that nothing listens on, checked now and written into the rows.
  const [nvrHttp, nvrRtsp, device, nvr2Http, nvr2Rtsp] = await findClosedPorts(5, new Set([nvrPort, secondNvrPort, FAKE_RTSP_PORT, FAKE_RTSP_2_PORT, FAKE_ERP_PORT, FAKE_ATTENDANCE_PORT, FAKE_ATTENDANCE_2_PORT]))
  const plan = demoPlan(nvrPort, { nvrHttp, nvrRtsp, device, nvr2Http, nvr2Rtsp }, secondNvrPort)
  await removeLeftoverDemoUsers(admin)
  const { data: org, error: orgError } = await admin.from('organizations').insert({ name: DEMO_ORG_NAME, slug: DEMO_SLUG }).select('id').single()
  if (orgError || !org) throw new Error(`Could not create the demo organisation: ${orgError?.message}`)
  const orgId = org.id
  const authIds: string[] = [] // every sign-in made here, so that a failure can remove them even if their profile was never made
  const passwords: { role: (typeof DEMO_ROLES)[number]; email: string; password: string }[] = []
  let cameraCount = 0
  try {
    const storeIds: Record<string, string> = {}
    for (const s of plan.stores) {
      const { data, error } = await admin.from('locations').insert({ org_id: orgId, code: s.code, name: s.name, city: s.city, zone: s.zone }).select('id').single()
      if (error || !data) throw new Error(`location ${s.code}: ${error?.message}`)
      storeIds[s.code] = data.id
      // P2-5b: each NVR is a recorder of its own (the same function the app uses; two NVRs of one location may both have channel 1).
      for (const r of s.recorders) {
        const rec = await admin.rpc('recorder_save', {
          p_org: orgId, p_location: data.id, p_recorder: null as unknown as string, p_host: LOOPBACK, p_http_port: r.httpPort, p_rtsp_port: r.rtspPort,
          p_username: DEMO_NVR_USER, p_expected_channels: r.cameras, p_name: r.name,
        })
        if (rec.error || !rec.data) throw new Error(`NVR ${r.name} of ${s.code}: ${rec.error?.message}`)
        const recorderId = rec.data as string
        // The NVR password goes into the vault through the same helper the app uses, never into a table.
        const cred = await admin.rpc('recorder_store_credential', { p_recorder: recorderId, p_secret: DEMO_NVR_PASSWORD })
        if (cred.error) throw new Error(`password for ${s.code} ${r.name}: ${cred.error.message}`)
        const cams = await admin.from('cameras').insert(
          Array.from({ length: r.cameras }, (_, i) => ({ org_id: orgId, location_id: data.id, recorder_id: recorderId, channel: i + 1, name: `${r.name} camera ${i + 1}` })),
        )
        if (cams.error) throw new Error(`cameras of ${s.code} ${r.name}: ${cams.error.message}`)
        cameraCount += r.cameras
      }
    }
    const devs = await admin.from('assets').insert(
      plan.devices.map((d) => ({ org_id: orgId, location_id: d.storeCode ? storeIds[d.storeCode] : null, type: d.type, name: d.name, ip: LOOPBACK, tcp_port: d.port })),
    )
    if (devs.error) throw new Error(`devices: ${devs.error.message}`)

    for (const role of DEMO_ROLES) {
      const email = demoEmail(role)
      const password = makePassword()
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (created.error || !created.data.user) throw new Error(`user ${role}: ${created.error?.message}`)
      const id = created.data.user.id
      authIds.push(id)
      const profile = await admin
        .from('profiles')
        .insert({ id, org_id: orgId, email, full_name: `Demo ${DEMO_ROLE_LABELS[role]}`, role, must_reset_password: false })
      if (profile.error) throw new Error(`profile ${role}: ${profile.error.message}`)
      // Everybody's access is explicit grants (P2-1): no role sees anything by itself.
      const p_grants = demoGrants(role, plan.stores.map((s) => s.code)).flatMap((g) =>
        g.capabilities.flatMap((capability) =>
          g.scope === 'organization'
            ? [{ capability, scope_kind: 'organization' }]
            : g.scope.stores.map((code) => ({ capability, scope_kind: 'location', scope_id: storeIds[code] })),
        ),
      )
      const grants = await admin.rpc('grant_access', { p_org: orgId, p_user: id, p_grants, p_reason: 'Demo data' })
      if (grants.error) throw new Error(`access for ${role}: ${grants.error.message}`)
      passwords.push({ role, email, password })
    }
  } catch (e) {
    // Leave nothing half-made behind: the organisation with its people, then any sign-in whose profile was never made.
    await cleanupOrg(orgId).catch((c) => console.error('Clean-up after the failure also failed:', c instanceof Error ? c.message : c))
    for (const id of authIds) {
      const del = await admin.auth.admin.deleteUser(id)
      if (del.error && !/not found/i.test(del.error.message)) console.error('Could not remove a demo sign-in after the failure:', del.error.message)
    }
    throw e
  }

  console.log(`Demo data added: locations DEMO1, DEMO2, DEMO3 (${cameraCount} cameras on 4 NVRs) and 4 devices, all pointing at this computer (127.0.0.1).`)
  console.log('DEMO2 has no NVR listening on purpose (shows as down); DEMO3 has two NVRs, the second of which nobody answers (only its cameras are down);')
  console.log('the footfall counter is offline too (ports checked to be closed). Camera 3 on the first pretend NVR is offline.')
  console.log('')
  console.log('Demo people. These passwords are shown now and are NOT saved anywhere:')
  for (const p of passwords) console.log(`  ${DEMO_ROLE_LABELS[p.role].padEnd(15)} ${p.email.padEnd(40)} ${p.password}`)
  console.log('')
  console.log('Next: run `npm run fake:nvr` and `npm run worker`, sign in, open Locations and NVRs, press "Find cameras for all", then "Check now" on Monitoring.')
  console.log('Remove all of it with `npm run demo:seed -- --reset` (stop the worker first).')
}

async function main() {
  const { reset, fresh, nvrPort, secondNvrPort } = parseArgs(process.argv.slice(2))
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
  await addDemo(admin, nvrPort, secondNvrPort)
}

// Not process.exit(): on Windows that can crash node while connections are still closing. Setting the code lets it end by itself.
main().catch((e) => {
  console.error(e instanceof Stop ? e.message : e instanceof Error ? e.message : e)
  process.exitCode = 1
})
