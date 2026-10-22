// Writes .env.local from the running local Supabase stack. Prints only variable NAMES, never values.
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { parseEnvOutput } from './lib/env-output.mjs'
import { PLAIN_DEFAULTS, RANDOM_SECRETS, SERVICE_KEYS, valueFor } from './lib/gen-secrets-core.mjs'

if (existsSync('.env.local') && !process.argv.includes('--force')) {
  console.log('.env.local already exists. Run with --force to replace it.')
  process.exit(0)
}

const status = parseEnvOutput(execSync('npx supabase status -o env', { encoding: 'utf8' }))
const need = ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']
const missing = need.filter((k) => !status[k])
if (missing.length) {
  console.error(`supabase status did not give: ${missing.join(', ')}. Is the stack running (npm run db:start)?`)
  process.exit(1)
}

const lines = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_APP_URL: 'http://localhost:3212',
  NEXT_PUBLIC_STREAM_GATEWAY_URL: 'http://localhost:3412',
  TZ: 'Asia/Kolkata',
  // P2-6: every secret purpose, go2rtc's API login and the per-service database keys (scripts/gen-secrets.mjs adds them to an existing file).
  ...Object.fromEntries([...RANDOM_SECRETS, ...Object.keys(PLAIN_DEFAULTS)].map((k) => [k, valueFor(k)])),
  ...(status.JWT_SECRET ? Object.fromEntries(SERVICE_KEYS.map((k) => [k, valueFor(k, { jwtSecret: status.JWT_SECRET })])) : {}),
  // Local development sign-in for create-dev-admin.mjs (synthetic address, random password, never printed).
  DEV_ADMIN_EMAIL: 'dev-admin@example.test',
  DEV_ADMIN_PASSWORD: randomBytes(15).toString('base64url') + 'aA1',
}
writeFileSync('.env.local', Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
console.log('Wrote .env.local with: ' + Object.keys(lines).join(', '))
