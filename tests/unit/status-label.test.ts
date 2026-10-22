import { describe, expect, it } from 'vitest'
import { statusLabel } from '@/lib/queries/status'

describe('statusLabel', () => {
  it('uses the three words the screens use', () => {
    expect(statusLabel('up')).toBe('Live')
    expect(statusLabel('down')).toBe('Offline')
    expect(statusLabel('unknown')).toBe('Not checked yet')
    expect(statusLabel(null)).toBe('Not checked yet')
    expect(statusLabel(undefined)).toBe('Not checked yet')
  })
})
