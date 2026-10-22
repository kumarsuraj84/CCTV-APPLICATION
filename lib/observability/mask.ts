/**
 * Hides anything in a piece of text that looks like a secret: `password=...`, `apikey: ...`, `Bearer ...` and JWT-shaped tokens.
 * The logger hides secrets by field name only; error messages from libraries are free text, so they go through this first.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\b(pass(?:word|wd)?|pwd|secret|token|api[-_ ]?key|apikey|authorization|service[-_ ]?role)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
}
