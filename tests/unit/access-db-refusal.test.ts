import { describe, expect, it } from 'vitest'
import { dbRefusal } from '@/lib/admin/access'

// P2-5c-1 brief item 5: "the database enforces; show the DB message plainly". The editor and the Server Action already explain the
// grantor rule; when the database is the one that refuses (for example because the hierarchy changed between the check and the save),
// its refusal is turned into the same plain sentence, never the raw SQL text.
describe('database refusals of an access change, in plain words', () => {
  it('a scope the acting administrator does not hold (equal or wider) is explained, not echoed', () => {
    const msg = dbRefusal({ code: '42501', message: 'cctv.live at this scope or for this long is not held by the acting person' }, 'test')
    expect(msg).toBe('You can only give rights you hold yourself, at the same or a wider place (for example the region above a cluster), and for no longer than you hold them.')
    expect(msg).not.toContain('scope')
  })

  it('keeps the existing plain refusals', () => {
    expect(dbRefusal({ code: '42501', message: 'you cannot change your own access' }, 't')).toBe('You cannot change your own access. Ask another administrator.')
    expect(dbRefusal({ code: '42501', message: 'download rights only for administrators' }, 't')).toBe('Download rights (export) can only be given to administrators and super administrators.')
    expect(dbRefusal({ code: '42501', message: 'only a platform owner may give it.os.deploy' }, 't')).toBe('Only a super administrator can give one of these rights.')
  })
})
