// Runs once when a Next.js server instance starts (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
// P2-6 review round 1 (M-16, I-1, I-2, M-3): the web app's start-up check. In production mode (DRISHTI_ENV=production or NODE_ENV=production)
// it stops the server when its own database keys, its shared secrets or go2rtc's login are missing, or while an organisation has not
// locked the service key out of NVR logins. Not during `next build` (the build has no runtime secrets) and not in the edge runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  const { runWebStartupCheck } = await import('./lib/startup-web-run')
  await runWebStartupCheck()
}
