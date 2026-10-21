import { describe, expect, it } from 'vitest'
import { submittedValues } from '@/lib/forms/submitted-values'

function form(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

describe('submittedValues', () => {
  it('returns the named fields that were submitted', () => {
    const v = submittedValues(form({ name: 'Store A', city: 'Pune', other: 'x' }), ['name', 'city', 'zone'])
    expect(v).toEqual({ name: 'Store A', city: 'Pune' })
  })

  it('never includes a password field, even when asked for it', () => {
    const f = form({ name: 'Store A', nvr_password: 'secret-value-123', password: 'another-secret', New_Password: 'x' })
    const v = submittedValues(f, ['name', 'nvr_password', 'password', 'New_Password'])
    expect(v).toEqual({ name: 'Store A' })
    expect(JSON.stringify(v)).not.toContain('secret')
  })

  it('ignores uploaded files', () => {
    const f = new FormData()
    f.set('file', new File(['abc'], 'a.csv'))
    expect(submittedValues(f, ['file'])).toEqual({})
  })

  it('records a checkbox as "on" when ticked and empty when not', () => {
    expect(submittedValues(form({ is_active: 'on' }), [], ['is_active'])).toEqual({ is_active: 'on' })
    expect(submittedValues(form({}), [], ['is_active'])).toEqual({ is_active: '' })
  })
})
