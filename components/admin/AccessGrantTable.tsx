import type { GrantView } from '@/lib/admin/access'
import { formatDateTime } from '@/lib/time'
import { AREA_LABELS, AREAS, SOURCE_LABELS, STATE_LABELS, validityText } from './access-labels'
import { BADGE, FOCUS, RT } from './fields'

/**
 * The person's grants, grouped by area (P2-3). `mode="current"`: every grant that is not removed (in effect, not started, ended), each
 * with a Remove button when the administrator may change this person; nothing is ever edited in place. `mode="history"`: removed
 * grants with who removed them and why.
 */
export function AccessGrantTable(props: {
  grants: GrantView[]
  mode: 'current' | 'history'
  staged?: ReadonlySet<string>
  onRevoke?: (g: GrantView) => void
}) {
  const rows = props.grants.filter((g) => (props.mode === 'history' ? g.state === 'revoked' : g.state !== 'revoked'))
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{props.mode === 'history' ? 'Nothing has been removed yet.' : 'This person has no access yet.'}</p>
  }
  return (
    <div className="space-y-4">
      {AREAS.map((area) => {
        const list = rows.filter((g) => g.area === area)
        if (list.length === 0) return null
        const caption = `${AREA_LABELS[area]}: ${list.length} ${list.length === 1 ? 'grant' : 'grants'}`
        return (
          <div key={area} className="overflow-x-auto rounded-lg border bg-card">
            <table className={RT.table}>
              <caption className={RT.caption}>{caption}</caption>
              <thead className={RT.thead}>
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Right</th>
                  <th scope="col" className="px-3 py-2 font-medium">Where</th>
                  <th scope="col" className="px-3 py-2 font-medium">{props.mode === 'history' ? 'Removed' : 'When'}</th>
                  <th scope="col" className="px-3 py-2 font-medium">Came from</th>
                  {props.mode === 'current' && props.onRevoke && <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className={RT.tbody}>
                {list.map((g) => {
                  const staged = props.staged?.has(g.id) ?? false
                  return (
                    <tr key={g.id} className={RT.tr}>
                      <td className={RT.td}>
                        <div className="font-medium">{g.capabilityLabel}</div>
                        <div className="text-xs text-muted-foreground">{g.capability}{g.risk === 'high' ? ' · high risk' : ''}</div>
                      </td>
                      <td className={RT.td}><span className={RT.label}>Where:</span>{g.scopeLabel}</td>
                      <td className={RT.td}>
                        {props.mode === 'history' ? (
                          <>
                            <div>{formatDateTime(g.revokedAt)}{g.revokedByName ? ` by ${g.revokedByName}` : ''}</div>
                            {g.revokeReason && <div className="text-xs text-muted-foreground">Reason: {g.revokeReason}</div>}
                          </>
                        ) : (
                          <>
                            <div>{validityText(g)}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              <span className={g.state === 'active' ? BADGE.ok : BADGE.neutral}>{STATE_LABELS[g.state]}</span>
                              {g.expiresSoon && <span className={BADGE.warn}>Expires soon</span>}
                            </div>
                          </>
                        )}
                      </td>
                      <td className={RT.td}>
                        <div><span className={RT.label}>Came from:</span>{SOURCE_LABELS[g.source] ?? g.source}{g.grantedByName ? ` (${g.grantedByName})` : ''}</div>
                        {g.reason && <div className="text-xs text-muted-foreground">Reason: {g.reason}</div>}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.needsReview && !g.keptAt && <span className={BADGE.warn}>Please review</span>}
                          {g.keptAt && <span className={BADGE.info}>Review: kept {formatDateTime(g.keptAt)}</span>}
                        </div>
                      </td>
                      {props.mode === 'current' && props.onRevoke && (
                        <td className={RT.tdAction}>
                          {staged ? (
                            <span className={BADGE.danger}>Will be removed</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => props.onRevoke?.(g)}
                              className={`rounded-md border border-[#7C8795] px-2.5 py-1 text-sm hover:bg-muted ${FOCUS}`}
                              aria-label={`Remove ${g.capabilityLabel} for ${g.scopeLabel}`}
                            >
                              Remove…
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}
