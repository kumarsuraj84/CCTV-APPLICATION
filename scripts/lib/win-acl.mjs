// Review I-7 (P5.4): the env files hold secrets, so on Windows they never exist, not even for a moment, with the folder's inherited
// ACL (on Windows 10/11 C:\ gives Authenticated Users modify, inherited by everything below). A NEW file or folder is locked before a
// secret is written into it: inherited entries removed, SYSTEM and Administrators full, plus the person running this when they are not
// elevated (so a test run under the temp folder can still read and remove what it made). An EXISTING file is rewritten in place, which
// keeps its ACL (for example the service account's read right granted by drishti-services.ps1). Well-known SIDs, never localised names.
// Nothing here prints; on other systems these do nothing (the 0600 mode applies there).
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const isWindows = process.platform === 'win32'
// The Windows tools by full path: under Git Bash, PATH finds coreutils' whoami first (which does not know /user).
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe)
let operator

/** The current user's SID when the process is NOT elevated (net session needs elevation), else null. */
function operatorSid() {
  if (operator !== undefined) return operator
  let elevated = false
  try {
    execFileSync(sys32('net.exe'), ['session'], { stdio: 'ignore' })
    elevated = true
  } catch {
    elevated = false
  }
  if (elevated) return (operator = null)
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

export const windowsAcl = isWindows
