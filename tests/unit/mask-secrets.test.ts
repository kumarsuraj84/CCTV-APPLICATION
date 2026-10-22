import { describe, expect, it } from 'vitest'
import { maskSecrets } from '@/lib/observability/mask'

describe('maskSecrets', () => {
  it('hides passwords and keys written as name=value or name: value', () => {
    const out = maskSecrets('failed with password=hunter2 and apikey: abc123 and api_key=zzz9 secret=s3')
    expect(out).not.toMatch(/hunter2|abc123|zzz9|s3\b/)
    expect(out).toContain('failed with')
  })

  it('hides bearer tokens and JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl'
    const out = maskSecrets(`header Authorization: Bearer abc.def-ghi_jkl== then ${jwt}`)
    expect(out).not.toContain('abc.def-ghi_jkl')
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('eyJ')
  })

  it('leaves ordinary text alone', () => {
    expect(maskSecrets('connect ECONNREFUSED 127.0.0.1:55321')).toBe('connect ECONNREFUSED 127.0.0.1:55321')
  })
})
