// Writes .env.local from the running local Supabase stack. Prints only variable NAMES, never values.
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { parseEnvOutput } from './lib/env-output.mjs'

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

const secret = () => randomBytes(32).toString('base64url')
const lines = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_APP_URL: 'http://localhost:3212',
  NEXT_PUBLIC_STREAM_GATEWAY_URL: 'http://localhost:3213',
  TZ: 'Asia/Kolkata',
  CRON_SECRET: secret(),
  WORKER_SECRET: secret(),
  STREAM_TOKEN_SECRET: secret(),
  SYSTEM_LOG_INGEST_SECRET: secret(),
  ACCESS_PREVIEW_SECRET: secret(),
  // Local development sign-in for create-dev-admin.mjs (synthetic address, random password, never printed).
  DEV_ADMIN_EMAIL: 'dev-admin@example.test',
  DEV_ADMIN_PASSWORD: randomBytes(15).toString('base64url') + 'aA1',
}
writeFileSync('.env.local', Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
console.log('Wrote .env.local with: ' + Object.keys(lines).join(', '))
