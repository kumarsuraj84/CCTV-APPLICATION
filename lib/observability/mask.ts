/**
 * Hides anything in a piece of text that looks like a secret: `password=...`, `apikey: ...`, `Bearer ...` and JWT-shaped tokens.
 * The logger hides secrets by field name only; error messages from libraries are free text, so they go through this first.
 * P2-6 (brief item 7): also the login inside any URL (an NVR's rtsp:// or http:// source), the WHOLE value of an Authorization header
 * (Basic, Digest, Bearer), Supabase's sb_secret_ keys and the environment keys of the secrets and service keys with their values.
 */
export function maskSecrets(text: string): string {
  return text
    // scheme://user:password@host  →  scheme://[redacted]@host (the user name too: it is half of the login)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[redacted]@')
    // Authorization: <scheme> <credentials> — a quoted value, or everything to the end of the line (a Digest answer holds quotes)
    .replace(/\b(authorization)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|_KEY))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1$2[redacted]')
    .replace(/\b(pass(?:word|wd)?|pwd|secret|token|api[-_ ]?key|apikey|service[-_ ]?role)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/("(?:pass(?:word)?|secret|token|api[-_]?key|apikey|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
}
