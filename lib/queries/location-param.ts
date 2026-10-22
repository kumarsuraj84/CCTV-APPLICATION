// T-1: Live, Playback and the group page take the location in the query as ?location=<id>. The old ?store=<id> (bookmarks, links that
// were e-mailed) still works; when both are given, the new one wins. An empty value counts as not given.
type Param = string | string[] | undefined

const first = (v: Param): string => (Array.isArray(v) ? v[0] : v) ?? ''

export function pickLocationParam(sp: { location?: Param; store?: Param }): string {
  return first(sp.location) || first(sp.store)
}
