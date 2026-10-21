// Parses the KEY="value" lines printed by `supabase status -o env`.
export function parseEnvOutput(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim())
    if (!m) continue
    let value = m[2]
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}
