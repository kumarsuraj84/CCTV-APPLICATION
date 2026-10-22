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

// P2-6 brief item 7: the samples that can reach a log or an error from the video path, the NVR clients and the service keys.
describe('maskSecrets: recorder sources, URLs, Authorization headers and keys (P2-6)', () => {
  it('hides the login of any URL (rtsp, rtsps, http, https), percent-encoded or not', () => {
    for (const [url, secretPart] of [
      ['rtsp://admin:N%40vr-Pass_9@192.168.20.100:554/Streaming/Channels/102', 'N%40vr-Pass_9'],
      ['rtsps://viewer:pa:ss@10.0.3.4:322/x', 'pa:ss'],
      ['http://admin:Secret123@192.168.1.64/ISAPI/System/status', 'Secret123'],
      ['https://user:p%23w@nvr.example.test:8443/', 'p%23w'],
    ]) {
      const out = maskSecrets(`go2rtc said: could not open ${url} (timeout)`)
      expect(out, url).not.toContain(secretPart)
      expect(out, url).toContain('[redacted]@')
      expect(out, url).toContain('(timeout)')
    }
  })

  it('hides the whole value of Authorization headers: Basic, Digest and Bearer', () => {
    const basic = maskSecrets('request had Authorization: Basic ZHJpc2h0aTpzZWNyZXQtcGFzcw== and failed')
    expect(basic).not.toContain('ZHJpc2h0aTpzZWNyZXQtcGFzcw==')
    const digest = maskSecrets('Authorization: Digest username="admin", realm="IP Camera", nonce="abc", uri="/ISAPI", response="6629fae49393a05397450978507c4ef1"')
    expect(digest).not.toContain('6629fae49393a05397450978507c4ef1')
    expect(digest).not.toContain('username="admin"')
    expect(maskSecrets('authorization=Bearer abc.def')).not.toContain('abc.def')
  })

  it('hides service keys in every shape: a JWT anywhere, the new sb_secret_ keys, and the env names with their values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidmlkZW9fZ2F0ZXdheSJ9.sig-nature_part'
    for (const text of [
      `apikey=${jwt}`, `{"apikey":"${jwt}"}`, `SUPABASE_VIDEO_GATEWAY_KEY=${jwt}`, 'key sb_secret_FAKEfakeFAKEfake-0000_1111aaaa in use',
      'GO2RTC_API_PASSWORD=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg', 'STREAM_TOKEN_SECRET: abcdefghijklmnopqrstuvwxyz0123456789',
    ]) {
      const out = maskSecrets(text)
      expect(out, text).not.toMatch(/eyJhbGci|sb_secret_FAKE|Zm9vYmFy|abcdefghijklmnop/)
    }
  })
})
