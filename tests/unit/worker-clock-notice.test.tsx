import { readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkerClockNotice } from '@/components/monitor/WorkerClockNotice'

// Release 1 clean-ups (P2-7 re-review R-2): the worker's clock difference (WorkerStatus.clockSkewSec / clockSkewWarning) is shown on
// the Monitoring page, where the people who read the checker's results look, not only in the log and on the Health page.

describe('the worker clock notice on the Monitoring page', () => {
  it('says how far the worker clock is ahead or behind, and what it does to the results, only beyond the warning limit', () => {
    const ahead = renderToStaticMarkup(<WorkerClockNotice skewSec={125} warning />)
    expect(ahead).toContain('2 minutes ahead of')
    expect(ahead).toMatch(/time sync/i)
    expect(ahead).toContain('role="status"')
    const behind = renderToStaticMarkup(<WorkerClockNotice skewSec={-45} warning />)
    expect(behind).toContain('45 seconds behind')
    expect(behind).toMatch(/Not checked lately/)
    expect(renderToStaticMarkup(<WorkerClockNotice skewSec={12} warning={false} />)).toBe('')
    expect(renderToStaticMarkup(<WorkerClockNotice skewSec={null} warning={false} />)).toBe('')
  })

  it('the Monitoring page renders it from the worker status', () => {
    const page = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/monitoring/page.tsx'), 'utf8')
    expect(page).toMatch(/<WorkerClockNotice skewSec=\{worker\.clockSkewSec\} warning=\{worker\.clockSkewWarning\} \/>/)
  })
})
