/**
 * Whether an NVR counts as known to be down right now: its last result says down, and (when staleBefore is given) that result is not older
 * than staleBefore. Without staleBefore any "down" counts. The one rule for this; the data layer applies it and puts the answer on StoreJob.
 */
export function isNvrKnownDown(status: string | null | undefined, checkedAt: string | null | undefined, staleBefore?: Date): boolean {
  if (status !== 'down') return false
  if (staleBefore === undefined) return true
  if (!checkedAt) return false
  const checked = Date.parse(checkedAt)
  return Number.isFinite(checked) && checked >= staleBefore.getTime()
}
