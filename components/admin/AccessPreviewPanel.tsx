import type { ChangeLine, PreviewCapability } from '@/lib/admin/access'
import { formatDay } from './access-labels'
import { BADGE, NOTE } from './fields'

const TARGET_WORDS: Record<string, [string, string]> = {
  camera: ['camera', 'cameras'], asset: ['asset', 'assets'], location: ['location or asset', 'locations and assets'], organization: ['organisation', 'organisation'],
}
const n = (count: number, target: string) => `${count} ${(TARGET_WORDS[target] ?? ['item', 'items'])[count === 1 ? 0 : 1]}`

/**
 * The effect of the changes, from preview_access_change (P2-3, AC-9): per right what the person gains and loses, the first items with
 * their location, and the exact grants that will be created and removed. Shown before saving; saving needs this very preview.
 */
export function AccessPreviewPanel(props: { capabilities: PreviewCapability[]; lines: ChangeLine[]; personActive: boolean }) {
  const grants = props.lines.filter((l) => l.op === 'grant')
  const revokes = props.lines.filter((l) => l.op === 'revoke')
  return (
    <section aria-labelledby="preview-title" className="space-y-3 rounded-xl border border-[var(--ring)] bg-card p-4" aria-live="polite">
      <h2 id="preview-title" className="text-base font-semibold">Effect of these changes</h2>
      {!props.personActive && (
        <p role="note" className={NOTE}>The person is deactivated or has not chosen a password yet: the changes apply once they can sign in.</p>
      )}
      <ul className="space-y-2">
        {props.capabilities.map((c) => (
          <li key={c.capability} className="rounded-lg border p-3 text-sm">
            <div className="font-medium">{c.label}</div>
            <div>
              {c.added === 0 && c.removed === 0 ? 'No change in what the person can reach (already covered).' : (
                <>
                  {c.added > 0 && <span className="mr-3">Gains {n(c.added, c.target)}</span>}
                  {c.removed > 0 && <span>Loses {n(c.removed, c.target)}</span>}
                </>
              )}
            </div>
            {c.sampleAdded.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Gains, for example: {c.sampleAdded.map((s) => s.label).join(', ')}{c.added > c.sampleAdded.length ? ` and ${c.added - c.sampleAdded.length} more` : ''}</div>}
            {c.sampleRemoved.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Loses, for example: {c.sampleRemoved.map((s) => s.label).join(', ')}{c.removed > c.sampleRemoved.length ? ` and ${c.removed - c.sampleRemoved.length} more` : ''}</div>}
          </li>
        ))}
      </ul>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">Grants that will be created ({grants.length})</h3>
          {grants.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {grants.map((l, i) => l.op === 'grant' && (
                <li key={i}>
                  {l.capabilityLabel} · {l.scopeLabel} · {l.lastDay ? `until the end of ${formatDay(l.lastDay)}` : 'no end date'}
                  {l.reason && <> · reason: {l.reason}</>}
                  {l.alreadyGiven && <> <span className={BADGE.neutral}>Already given: nothing changes</span></>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold">Grants that will be removed ({revokes.length})</h3>
          {revokes.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {revokes.map((l, i) => l.op === 'revoke' && <li key={i}>{l.capabilityLabel} · {l.scopeLabel} · reason: {l.reason}</li>)}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
