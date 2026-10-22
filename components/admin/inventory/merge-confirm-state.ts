// The state of a merge confirmation (P2-5c-1 review I-5, fix round 2 A-N1). A confirmation belongs to the exact pair of cameras the
// server described; choosing another camera closes it, an answer about a pair that is no longer chosen is dropped, and "Yes, merge"
// sends the pair (and the server's confirmation) the question named, never what the lists show at that moment.

export type MergeChoice = { keepId: string; duplicateId: string }
export type MergePending = MergeChoice & { sentence: string; confirmation: string }
export type MergeConfirmState = { chosen: MergeChoice | null; pending: MergePending | null }

export type MergeConfirmEvent =
  | ({ type: 'choose' } & MergeChoice)
  | ({ type: 'previewed' } & MergePending)
  | { type: 'cancel' }

export const initialMergeConfirm: MergeConfirmState = { chosen: null, pending: null }

const same = (a: MergeChoice | null, b: MergeChoice | null) => !!a && !!b && a.keepId === b.keepId && a.duplicateId === b.duplicateId

export function mergeConfirmReducer(state: MergeConfirmState, e: MergeConfirmEvent): MergeConfirmState {
  switch (e.type) {
    case 'choose': {
      const chosen = { keepId: e.keepId, duplicateId: e.duplicateId }
      // Any change of either camera closes the question; it is asked again for the new pair.
      return same(state.chosen, chosen) ? state : { chosen, pending: null }
    }
    case 'previewed':
      // Only an answer about the pair chosen now opens the question.
      return same(state.chosen, e) ? { ...state, pending: { keepId: e.keepId, duplicateId: e.duplicateId, sentence: e.sentence, confirmation: e.confirmation } } : state
    case 'cancel':
      return { ...state, pending: null }
  }
}

/** What "Yes, merge" sends: the pair the open question named, with the server's confirmation; null when no question is open. */
export function mergeRequest(state: MergeConfirmState): (MergeChoice & { confirmation: string }) | null {
  const p = state.pending
  if (!p || !same(state.chosen, p)) return null
  return { keepId: p.keepId, duplicateId: p.duplicateId, confirmation: p.confirmation }
}
