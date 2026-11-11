// P5.4 fix round 3: the Windows lab suite (tests/windows-lab). It changes real access lists, plants junctions and hard links to decoy
// folders, and compiles and runs the Drishti service host: everything the default test run must never do on a managed PC (the
// owner's antivirus). It is the pre-install verification an administrator runs ON THE PRODUCTION SERVER, under that server's own
// antivirus policy (docs/drishti/runbooks/windows-services.md section 7). Its helpers live in <repo>/.scratch/windows-lab (gitignored)
// and are removed afterwards.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('The Windows lab suite runs on Windows only.')
  process.exit(1)
}
if (process.env.DRISHTI_WINDOWS_LAB !== '1') {
  console.error('Refused: the Windows lab suite changes access lists, makes junctions and compiles the service host on THIS computer.')
  console.error('Run it only on the server you are about to install (never on a managed office PC): set DRISHTI_WINDOWS_LAB=1 and run npm run test:windows-lab again.')
  console.error('What it checks: docs/drishti/runbooks/windows-services.md section 7.')
  process.exit(1)
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const r = spawnSync(process.execPath, [vitest, 'run', 'tests/windows-lab'], { cwd: root, stdio: 'inherit', env: process.env })
rmSync(path.join(root, '.scratch', 'windows-lab'), { recursive: true, force: true })
process.exit(r.status ?? 1)
