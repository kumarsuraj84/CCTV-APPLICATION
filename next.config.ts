import type { NextConfig } from 'next'
// The policy text only (no other import: next.config is loaded by Node before the app's path aliases exist).
const REDIRECT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// One stamp per production build (set by the build script); "dev" locally. Open pages compare it with /api/version.
const BUILD_ID = process.env.CK_BUILD_ID || 'dev'

const nextConfig: NextConfig = {
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
  // T-1 (ruling T-1): "Store" became "Location". The old addresses keep working: bookmarks, e-mailed links and the browser history are sent to the
  // new page with a permanent redirect; the id and the query string are kept (Next.js passes the query on to the destination).
  async redirects() {
    return [
      // The old edit link of the "Manage stores" page opens that location on its administration page (only a real id is put into the path).
      { source: '/admin/stores', has: [{ type: 'query' as const, key: 'edit', value: '(?<editId>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})' }], destination: '/admin/locations/:editId', permanent: true },
      { source: '/admin/stores', destination: '/admin/locations', permanent: true },
      { source: '/stores', destination: '/locations', permanent: true },
      { source: '/stores/:id', destination: '/locations/:id', permanent: true },
    ]
  },
  // P3-1 (D-12, SO-8): the Content Security Policy of pages, API routes and the proxy's own redirects is set per request in proxy.ts
  // (with its nonce). The redirects above are answered before the proxy runs, so they get the policy that allows nothing here.
  // X-Frame-Options DENY matches the policy's frame-ancestors 'none' for browsers that read only the older header.
  async headers() {
    return [...['/stores', '/stores/:id', '/admin/stores'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: REDIRECT_CSP }] })), {
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
