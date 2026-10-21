import { describe, expect, it } from 'vitest'
import { parseEnvOutput } from '@/scripts/lib/env-output.mjs'

describe('parseEnvOutput', () => {
  it('reads KEY="value" and KEY=value lines and ignores everything else', () => {
    const text = ['API_URL="http://127.0.0.1:55321"', 'ANON_KEY=abc.def.ghi', '', '# comment', 'not a pair', 'SERVICE_ROLE_KEY="x=y"'].join('\n')
    expect(parseEnvOutput(text)).toEqual({
      API_URL: 'http://127.0.0.1:55321',
      ANON_KEY: 'abc.def.ghi',
      SERVICE_ROLE_KEY: 'x=y',
    })
  })

  it('handles Windows line endings', () => {
    expect(parseEnvOutput('A="1"\r\nB="2"\r\n')).toEqual({ A: '1', B: '2' })
  })
})
