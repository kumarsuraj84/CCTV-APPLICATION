// Generates the secrets and per-service database keys of CityKart Drishti (P2-6) into an env file. NEVER prints a value: only the
// names of what was added, kept or rotated. Never overwrites a value that is already set unless --rotate says so.
//
//   node scripts/gen-secrets.mjs                         add what is missing to .env.local (local stack: the JWT secret comes from
//                                                        `supabase status`)
//   node scripts/gen-secrets.mjs --file <path>           another env file (for example a production one, outside the repository)
//   node scripts/gen-secrets.mjs --jwt-secret-env NAME   read the project JWT secret from environment variable NAME instead of the
//                                                        local stack (production: the hosted project's JWT secret)
//   node scripts/gen-secrets.mjs --rotate                replace every generated value (not the plain settings)
//   node scripts/gen-secrets.mjs --rotate=A,B            replace only these keys
//   node scripts/gen-secrets.mjs --only=A,B              look only at these keys
//   node scripts/gen-secrets.mjs --dry-run               say what would change, write nothing
//
// After writing: restart the processes that read the changed keys (docs/drishti/runbooks/secret-rotation.md says which).
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnvOutput } from './lib/env-output.mjs'
import { ALL_KEYS, plan, render, SERVICE_KEYS, valueFor } from './lib/gen-secrets-core.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) return args[i + 1]
  const eq = flag(name)
  return eq && eq.includes('=') ? eq.slice(eq.indexOf('=') + 1) : undefined
}
const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const list = (v) => new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))

const file = path.resolve(valueOf('file') ?? '.env.local')
const rotateFlag = flag('rotate')
const rotate = rotateFlag === undefined ? false : rotateFlag.includes('=') ? list(rotateFlag.slice(rotateFlag.indexOf('=') + 1)) : true
const only = flag('only') ? list(valueOf('only')) : undefined
const dryRun = args.includes('--dry-run')
for (const k of [...(rotate instanceof Set ? rotate : []), ...(only ?? [])]) if (!ALL_KEYS.includes(k)) fail(`Unknown key: ${k}`)

const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
const steps = plan(before, { rotate, only })
const writing = steps.filter((s) => s.action !== 'keep')

let jwtSecret
if (writing.some((s) => SERVICE_KEYS.includes(s.key))) {
  const envName = valueOf('jwt-secret-env')
  if (envName) jwtSecret = process.env[envName]
  else {
    try {
      jwtSecret = parseEnvOutput(execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).JWT_SECRET
    } catch {
      jwtSecret = undefined
    }
  }
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) {
    fail('The project JWT secret is needed for the service keys: start the local stack (npm run db:start) or pass --jwt-secret-env NAME.')
  }
}

const values = Object.fromEntries(writing.map((s) => [s.key, valueFor(s.key, { jwtSecret })]))
const say = (action) => steps.filter((s) => s.action === action).map((s) => s.key)
const added = say('add')
const rotated = say('rotate')
const kept = say('keep')
if (dryRun) {
  console.log(`Dry run for ${path.basename(file)} (nothing written).`)
} else if (writing.length > 0) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, render(before, steps, values), { mode: 0o600 })
  renameSync(tmp, file)
  console.log(`Wrote ${path.basename(file)}.`)
} else {
  console.log(`${path.basename(file)} already has every key; nothing written.`)
}
if (added.length) console.log(`Added: ${added.join(', ')}`)
if (rotated.length) console.log(`Rotated: ${rotated.join(', ')}`)
if (kept.length) console.log(`Kept (already set; use --rotate=NAME to replace): ${kept.join(', ')}`)
if (writing.length) console.log('Restart the processes that read these keys (docs/drishti/runbooks/secret-rotation.md).')
