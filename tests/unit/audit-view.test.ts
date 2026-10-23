import { describe, expect, it } from 'vitest'
import { auditHref, istRange, parseAuditFilters } from '@/lib/admin/audit-view'

// P5.4 brief item 5: the audit page's filters. Every value from the address is checked before it reaches a query; anything unknown or
// malformed is ignored (never an error page, never part of a filter expression).

describe('audit page filters (P5.4)', () => {
  it('defaults: actions, no filter, first page', () => {
    expect(parseAuditFilters({})).toEqual({ kind: 'actions', category: null, action: null, person: null, from: null, to: null, q: null, page: 0 })
  })

  it('takes known values', () => {
    expect(parseAuditFilters({ kind: 'sign_ins', category: 'two_step', action: 'mfa_enrolled', person: 'Ravi K', from: '2026-10-01', to: '2026-10-23', q: 'archived', page: '2' }))
      .toEqual({ kind: 'sign_ins', category: 'two_step', action: 'mfa_enrolled', person: 'Ravi K', from: '2026-10-01', to: '2026-10-23', q: 'archived', page: 2 })
  })

  it('an action of the other table, an unknown category or action, and a bad page are ignored', () => {
    expect(parseAuditFilters({ kind: 'actions', action: 'sign_in' }).action).toBeNull() // sign_in is an auth event
    expect(parseAuditFilters({ category: 'everything' }).category).toBeNull()
    expect(parseAuditFilters({ action: 'drop_table' }).action).toBeNull()
    for (const page of ['-1', '1.5', 'x', '100000']) expect(parseAuditFilters({ page }).page, page).toBe(0)
  })

  it('a search or person that could break a filter expression is ignored', () => {
    for (const q of ['a,b', 'x)', 'name.eq.y', "o'neil;", '*', 'a']) {
      const f = parseAuditFilters({ q })
      if (q === 'name.eq.y') expect(f.q).toBe('name.eq.y') // dots are fine: the value is quoted into one ilike pattern
      else expect(f.q, q).toBeNull()
    }
    for (const person of ['a,b', 'x(y)', 'x*', '%', 'é']) expect(parseAuditFilters({ person }).person, person).toBeNull()
    expect(parseAuditFilters({ person: 'priya.s@citykart.example' }).person).toBe('priya.s@citykart.example')
  })

  it('days: only YYYY-MM-DD; a reversed range is put in order', () => {
    expect(parseAuditFilters({ from: '23-10-2026', to: '2026-13-40' })).toMatchObject({ from: null, to: null })
    expect(parseAuditFilters({ from: '2026-10-23', to: '2026-10-01' })).toMatchObject({ from: '2026-10-01', to: '2026-10-23' })
  })

  it('istRange: from 00:00 IST of the first day to 00:00 IST after the last day', () => {
    expect(istRange('2026-10-01', '2026-10-23')).toEqual({ gte: '2026-09-30T18:30:00.000Z', lt: '2026-10-23T18:30:00.000Z' })
    expect(istRange(null, null)).toEqual({ gte: null, lt: null })
  })

  it('auditHref keeps only what is set and changes what is asked', () => {
    const f = parseAuditFilters({ kind: 'sign_ins', person: 'Ravi', page: '1' })
    expect(auditHref(f)).toBe('/admin/audit?kind=sign_ins&person=Ravi&page=1')
    expect(auditHref(f, { page: 0, person: null })).toBe('/admin/audit?kind=sign_ins')
    expect(auditHref(parseAuditFilters({}))).toBe('/admin/audit')
  })
})
