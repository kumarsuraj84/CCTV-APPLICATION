// Review I-7 (P5.4): the env files hold secrets, so on Windows they never exist, not even for a moment, with the folder's inherited
// ACL (on Windows 10/11 C:\ gives Authenticated Users modify, inherited by everything below). A NEW file or folder is locked before a
// secret is written into it: inherited entries removed, SYSTEM and Administrators full, plus the person running this when they are not
// elevated (so a test run under the temp folder can still read and remove what it made). An EXISTING file is rewritten in place, which
// keeps its ACL (for example the service account's read right granted by drishti-services.ps1). Well-known SIDs, never localised names.
// Nothing here prints; on other systems these do nothing (the 0600 mode applies there).
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const isWindows = process.platform === 'win32'
// The Windows tools by full path: under Git Bash, PATH finds coreutils' whoami first (which does not know /user).
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe)
let operator

/**
 * Whether this process runs elevated: its token carries the high (or system) mandatory level, S-1-16-12288 / S-1-16-16384, as
 * `whoami /groups` lists it (re-review M-new-7: `net session` also fails when the Server service is stopped, which made an elevated
 * administrator look non-elevated). Exported for the test.
 */
export function isElevated(groupsCsv) {
  return /"S-1-16-(12288|16384)"/.test(groupsCsv)
}

/** The current user's SID when the process is NOT elevated, else null. */
function operatorSid() {
  if (operator !== undefined) return operator
  let groups = ''
  try {
    groups = execFileSync(sys32('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  } catch {
    groups = ''
  }
  if (isElevated(groups)) return (operator = null)
  let sid = null
  try {
    const out = execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
    const m = /"(S-1-[0-9-]+)"/.exec(out)
    sid = m ? m[1] : null
  } catch {
    sid = null
  }
  // Not elevated and nobody to grant: locking would shut this very run out of what it is writing. Refuse instead.
  if (!sid) throw new Error('could not find the SID of the current user (whoami /user): run this from an elevated prompt')
  return (operator = sid)
}

/** Locks a file or folder: SYSTEM, Administrators (and the non-elevated operator) only. */
export function lockPath(p, { folder = false } = {}) {
  if (!isWindows) return
  const inh = folder ? '(OI)(CI)' : ''
  const args = [p, '/inheritance:r', '/grant:r', `*S-1-5-18:${inh}F`, '/grant:r', `*S-1-5-32-544:${inh}F`]
  const me = operatorSid()
  if (me) args.push('/grant:r', `*${me}:${inh}F`)
  execFileSync(sys32('icacls.exe'), args, { stdio: 'ignore' })
}

/**
 * Re-review M-new-5: a folder for the temporary copies, next to the target, created and locked BEFORE any file is made in it. A file
 * made inside then takes the locked rules from the start, even when the target's own folder is not locked (a user who opens a
 * handle early could otherwise keep it). Elsewhere (not Windows) it is the target's folder itself. Returns { dir, done() }.
 */
export function lockedWorkDir(parent) {
  if (!isWindows) return { dir: parent, done: () => {} }
  const dir = path.join(parent, `.gen-secrets-${process.pid}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir) // fails if it exists: never a folder someone else made
  lockPath(dir, { folder: true })
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

export const windowsAcl = isWindows
