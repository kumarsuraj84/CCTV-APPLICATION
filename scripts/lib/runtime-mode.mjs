// The one switch between development and production (P2-6 review round 1, I-1), shared by the web app, the worker, the gateway
// (through lib/runtime-mode.ts) and the stack scripts (scripts/check-go2rtc-env.mjs). NODE_ENV alone is not enough: the worker and the
// gateway run under tsx, which sets no NODE_ENV, so a production server would otherwise run them in "development" (falling back to the
// full service key, allowing loopback targets). DRISHTI_ENV=production (set in the Windows service environment and in
// deploy/production.env.example) puts every process into production mode. Fail closed: any DRISHTI_ENV value other than
// "development" also means production, and so does NODE_ENV=production.

export const MODE_ENV = 'DRISHTI_ENV'

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isProductionMode(env = process.env) {
  if (env.NODE_ENV === 'production') return true
  const mode = env[MODE_ENV]?.trim()
  return mode !== undefined && mode !== '' && mode !== 'development'
}
