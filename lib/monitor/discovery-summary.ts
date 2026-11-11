import type { LocationDiscovery, Reconciliation } from '@/lib/monitor/discovery'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** One plain line for an item of the reconciliation list (review P2-5b M-8: say what it is, never "may have moved" for everything). */
function line(nvr: string, r: Reconciliation): string {
  switch (r.kind) {
    case 'possible_move':
      return `${nvr}, channel ${r.channel} ("${r.reportedName}"): may be the existing camera "${r.cameraName}"; nothing was added.`
    case 'missing':
      return `${nvr}, channel ${r.channel}: camera "${r.cameraName}" is no longer listed by the NVR; it was kept.`
    case 'renamed':
      return `${nvr}, channel ${r.channel}: "${r.from}" is now called "${r.to}" by the NVR.`
    case 'channel_taken':
      return `${nvr}, channel ${r.channel}: the restored camera "${r.cameraName}" was on this channel, which another camera now uses; it was left unlinked.`
    case 'unplaced':
      // Review C M-30: the Reconciliation page cannot link an "unplaced" camera (its old channel is gone); say what can be done.
      return `${nvr}: the restored camera "${r.cameraName}" (last on channel ${r.channel}) could not be placed; on the Reconciliation page merge it with the camera the NVR shows now, link it to a channel in the mapping editor, or take it off the list.`
  }
}

/** The message after "Find cameras" for a store: counts, then one line per thing to look at and per NVR that could not be asked. */
export function discoverySummary(res: LocationDiscovery): { message: string; details: string[] } {
  const details: string[] = []
  let toCheck = 0
  for (const r of res.recorders) {
    if (r.ok) {
      toCheck += r.result.reconciliation.length
      for (const item of r.result.reconciliation) details.push(line(r.name, item))
    } else details.push(`${r.name}: ${r.error}`)
  }
  const failed = res.recorders.filter((r) => !r.ok).length
  const counts = [`${res.created} new`]
  if (res.moved > 0) counts.push(`${res.moved} moved to another channel`)
  const parts = [`Found ${plural(res.cameras, 'camera', 'cameras')} (${counts.join(', ')}).`]
  if (toCheck > 0) parts.push(`${plural(toCheck, 'thing needs', 'things need')} a look.`)
  if (failed > 0) parts.push(`${plural(failed, 'NVR', 'NVRs')} could not be asked.`)
  return { message: parts.join(' '), details }
}
