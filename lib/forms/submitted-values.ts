/**
 * The non-secret text fields of a submitted form, sent back with an error so the form can keep what the
 * person typed. Any field whose name contains "password" is never included, even if it is listed.
 * A checkbox is recorded as "on" or "" because an unticked box is missing from the form data.
 */
export function submittedValues(formData: FormData, names: readonly string[], checkboxes: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const safe = (n: string) => !/password/i.test(n)
  for (const n of names) {
    if (!safe(n)) continue
    const v = formData.get(n)
    if (typeof v === 'string') out[n] = v
  }
  for (const n of checkboxes) {
    if (safe(n)) out[n] = formData.get(n) === 'on' ? 'on' : ''
  }
  return out
}
