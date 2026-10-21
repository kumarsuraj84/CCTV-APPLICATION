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
console.log('Dev admin created. Its e-mail and password are in .env.local (DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD).')
