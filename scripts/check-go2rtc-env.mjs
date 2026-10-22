// Runs before `docker compose up` in the stack scripts (package.json stack:up, stack:up:demo). P2-6 review round 1, I-2: in production
// mode (DRISHTI_ENV=production or NODE_ENV=production) go2rtc is not started without its API login; development only warns.
// Reads the same env file docker compose is given (`--compose-env <file>`, default .env.local; not `--env-file`, which Node itself
// takes even after the script name), with the shell's environment winning over it, as compose does.
// Prints names and plain words only, never a value. Exit 0 = go ahead, 1 = refused.
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { go2rtcEnvProblems } from './lib/go2rtc-env.mjs'

const args = process.argv.slice(2)
const at = args.indexOf('--compose-env')
const file = at >= 0 ? args[at + 1] : '.env.local'

let fromFile = {}
if (file && existsSync(file)) {
  try {
    fromFile = parseEnv(readFileSync(file, 'utf8'))
  } catch {
    console.error(`The env file ${file} could not be read.`)
    process.exit(1)
  }
}
const env = { ...fromFile, ...process.env }
const { problems, warnings } = go2rtcEnvProblems(env)
for (const w of warnings) console.warn(w)
if (problems.length > 0) {
  console.error('go2rtc is not started in production mode:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('Make them with `node scripts/gen-secrets.mjs --file <file>` (it never overwrites a value without --rotate), then run this again.')
  process.exit(1)
}
