// Creates the local development administrator from DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD in .env.local. Local stack only.
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile('.env.local')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const u = new URL(url ?? 'http://invalid.invalid')
if (!(['localhost', '127.0.0.1'].includes(u.hostname) && u.port === '55321')) {
  console.error('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  process.exit(1)
}
const email = process.env.DEV_ADMIN_EMAIL
const password = process.env.DEV_ADMIN_PASSWORD
if (!email || !password) {
  console.error('Run npm run env:local first (it writes DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD).')
  process.exit(1)
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const { data: org } = await admin.from('organizations').select('id').eq('slug', 'citykart').single()
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (error || !data.user) {
  console.error('Could not create the user: ' + (error?.message ?? 'unknown error'))
  process.exit(1)
}
const { error: pErr } = await admin.from('profiles').insert({
  id: data.user.id, org_id: org.id, email, full_name: 'Dev Admin', role: 'platform_owner', must_reset_password: false,
})
if (pErr) {
  await admin.auth.admin.deleteUser(data.user.id)
  console.error('Could not create the profile: ' + pErr.message)
  process.exit(1)
}
// No role gives access by itself (P2-1): the dev admin gets the administrator set as explicit organisation-wide grants, the same set the
// migration gives existing administrators (keep in step with ADMIN_BASELINE in scripts/lib/demo.ts).
const ADMIN_BASELINE = [
  'cctv.live', 'cctv.playback', 'cctv.export', 'it.inventory.view', 'it.monitoring.view', 'it.monitoring.operate', 'wifi.inventory.view',
  'wifi.config.view_redacted', 'admin.users', 'admin.access', 'admin.inventory', 'admin.alerts', 'admin.audit.read',
]
const { error: gErr } = await admin.rpc('grant_access', {
  p_org: org.id, p_user: data.user.id, p_grants: ADMIN_BASELINE.map((capability) => ({ capability, scope_kind: 'organization' })), p_reason: 'Dev admin',
})
if (gErr) {
  console.error('The dev admin was created, but its access could not be granted: ' + gErr.message)
  process.exit(1)
}
console.log('Dev admin created. Its e-mail and password are in .env.local (DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD).')
