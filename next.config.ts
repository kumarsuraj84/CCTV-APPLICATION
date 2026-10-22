import type { NextConfig } from 'next'

// One stamp per production build (set by the build script); "dev" locally. Open pages compare it with /api/version.
const BUILD_ID = process.env.CK_BUILD_ID || 'dev'
// P3-1 review round 1: a build or a second server beside the running dev server goes into its own folder (NEXT_DIST_DIR=.next-<name>):
// a production build in .next knocked over the dev server on 3212. Accepted: ".next<suffix>" or ".next/<name>" (inside the ignored .next/,
// for example NEXT_DIST_DIR=.next/build-p31); anything else is the default.
const DIST_DIR = /^\.next(?:[A-Za-z0-9._-]*|\/(?!dev$)[A-Za-z0-9._-]+)$/.test(process.env.NEXT_DIST_DIR ?? '') ? (process.env.NEXT_DIST_DIR as string) : '.next'

const nextConfig: NextConfig = {
  distDir: DIST_DIR,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  generateBuildId: async () => BUILD_ID,
  output: 'standalone',
  devIndicators: false,
  // Development only: the dev server refuses scripts and the hot-reload socket from any host but localhost, which left the page on another
  // PC unhydrated (video tiles stuck on "Connecting…"). Extra hosts, comma separated, e.g. DEV_ALLOWED_ORIGINS=10.0.0.47,pc-name.
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? '10.0.0.47').split(',').map((s) => s.trim()).filter(Boolean),
  turbopack: { root: __dirname },
  experimental: {
    serverActions: { bodySizeLimit: '30mb' },
    proxyClientMaxBodySize: '30mb',
    staleTimes: { dynamic: 30, static: 180 },
  },
  // T-1 (ruling T-1): "Store" became "Location"; the old addresses keep working with permanent redirects. P3-1: they are answered by
  // proxy.ts (lib/web/legacy-redirects.ts), because Next.js sends a redirect of this file without any security header.
  // P3-1 (D-12, SO-8): the Content Security Policy of pages, API routes and the proxy's redirects is set per request in proxy.ts (with
  // its nonce). X-Frame-Options DENY matches the policy's frame-ancestors 'none' for browsers that read only the older header.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        // only when the site really is served over https
        ...((process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
          ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
          : []),
      ],
    }]
  },
}

export default nextConfig
