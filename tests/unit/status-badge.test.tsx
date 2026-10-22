import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from '@/components/monitor/StatusBadge'

const html = (props: Parameters<typeof StatusBadge>[0]) => renderToStaticMarkup(<StatusBadge {...props} />)

describe('StatusBadge', () => {
  it('shows the usual words', () => {
    expect(html({ status: 'up' })).toContain('Live')
    expect(html({ status: 'down' })).toContain('Offline')
    expect(html({ status: undefined })).toContain('Not checked yet')
  })

  it('shows "Not checked lately" for a stale live result, with its own look and an explanation', () => {
    const stale = html({ status: 'up', stale: true })
    expect(stale).toContain('Not checked lately')
    expect(stale).not.toContain('>Live<')
    expect(stale).toContain('title="It was live, but has not been checked for more than 20 minutes."')
    expect(stale).toContain('amber')
    expect(stale).not.toBe(html({ status: 'up' }))
    // The icon is decoration; the words carry the meaning.
    expect(stale).toContain('aria-hidden="true"')
  })

  it('stale means nothing for offline or never-checked targets', () => {
    expect(html({ status: 'down', stale: true })).toContain('Offline')
    expect(html({ status: 'unknown', stale: true })).toContain('Not checked yet')
  })
})
