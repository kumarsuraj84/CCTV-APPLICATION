# Foundation, Identity and Inventory (Plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running CityKart Network Hub on port 3212 where an admin signs in, creates users, gives them access to stores, zones or individual cameras, and imports or edits stores, cameras and devices, and where a viewer sees only what they were granted, enforced by PostgreSQL row-level security.

**Architecture:** Next.js 16 app (App Router, Server Actions, `proxy.ts`) on Supabase (PostgreSQL + GoTrue + Vault), following the Citykart Desk conventions. Visibility rules live in database functions (`visible_store_ids()`, `visible_camera_ids()`, `visible_device_ids()`) used by RLS policies. Admin actions are thin Server Actions over plain service functions in `lib/admin` and `lib/import` that take the Supabase admin client as a parameter, so they are tested directly against the local Supabase stack.

**Tech Stack:** Next.js 16.3.8, React 19.2.4, TypeScript 5.9, Tailwind 4, shadcn/ui (base-nova, copied from Desk), Supabase CLI 2.111 (local, Docker), PostgreSQL 17, zod 4, vitest 3.

**Spec:** `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`

**Reference code (read-only, on this PC):** Desk repo at `D:\ANKUR AI PROJECTS\CitykartDesk-ZOHO Alternate` (called `$DESK` below). Never run its servers, never read its `.env.local`, never connect to anything in its production notes.

**Later plans (not in this plan):** Plan 2 monitoring worker, uptime and status screens. Plan 3 live feeds, playback, camera groups. Plan 4 backup, reports, hardening, production packaging.

## Global Constraints

- Stack: Next.js 16.3 App Router with `proxy.ts` (a `middleware.ts` file crashes Next 16), React 19, TypeScript 5.9, Tailwind 4, Supabase (PostgreSQL, PostgREST, GoTrue, Storage, Vault). Read the guide under `node_modules/next/dist/docs/` before writing Next.js code; `cookies()`, `headers()` and route `params` are async.
- App port **3212**. Stream gateway port 3213 (Plan 3). Local Supabase ports 55320 to 55329 (API 55321, DB 55322, Studio 55323, mail catcher 55324, shadow DB 55320), chosen to avoid the Desk stack on 543xx and 554xx.
- Server Actions live in `lib/actions/**` with `'use server'` and only async exports. Every action checks the caller (`getCurrentProfile()`), role and organisation scope first.
- Two Supabase clients: `createClient()` (cookie-bound, RLS enforced) and `createAdminClient()` (service role, server only, never sent to the browser). An admin-client write of a foreign key first proves the referenced row is in the caller's organisation.
- Never return a raw database message to a user: use `sanitizeError()`. Logs redact secrets.
- Times are stored UTC and shown in IST, 24-hour clock. Screen text is plain English, short sentences, no jargon.
- Roles are the fixed enum `user_role`: `user` (viewer), `agent` (operator), `manager`, `admin`, `platform_owner`. A person with `must_reset_password = true` resolves to no organisation and no role in row security until they choose a new password.
- Visibility (database-enforced): stores visible = stores granted by store, by zone, the profile's own `store_id`, plus stores containing an individually granted camera; `manager`, `admin`, `platform_owner` see every store of the organisation. Cameras visible = individually granted cameras plus cameras of stores in the store/zone/own-store grant set, except that in a store where the user has individual camera grants only those cameras are visible. Devices visible = devices of stores in the store/zone/own-store grant set (a camera-only grant does not reveal devices); devices with no store are visible only to `manager`, `admin`, `platform_owner`.
- Stores, cameras, devices, users, grants and imports are changed only by `admin` and `platform_owner` through Server Actions using the admin client; a plain `admin` may only create or change `user`, `agent` and `manager`; only `platform_owner` may create or change `admin` and `platform_owner`. Every change writes `admin_audit_log`.
- NVR passwords exist only in Supabase Vault (`nvr_store_credential` / `nvr_read_credential` RPCs, service role only). They are never in a table column, a log, a response or the repository.
- One secret per purpose through `getSecret(purpose)` (`cron`, `worker`, `stream_token`, `system_log_ingest`); a missing secret switches the feature off, never falls back; minimum 16 characters; two purposes must not share a value.
- No secrets, passwords or keys in the repository, logs, screens or chat. Tests use only synthetic data (`@example.test` e-mails, random passwords generated at run time) on the local stack, and never touch a real store IP.
- No public sign-up. Admins create users and see a one-time password once.
- Type errors fail the production build. `npm run typecheck`, `npm run lint` and `npm run test:unit` must be clean at the end of every task; `npm run test:integration` needs the local Supabase stack running.
- Deviations from the spec, deliberate: integration tests run against the local dev stack using disposable organisations and a safety gate (`assertLocalStack`); a separate isolated test stack and the egress guard arrive with the worker in Plan 2 and hardening in Plan 4. New cameras created from the import's `channels` column are placeholders ("Camera N") until discovery in Plan 2.
- Dev machine is Windows; commands are written for Git Bash from the repository root.

## File Structure

```
package.json  tsconfig.json  next.config.ts  vitest.config.ts  postcss.config.mjs  eslint.config.mjs
components.json  proxy.ts  .env.example  .gitignore
app/
  layout.tsx  globals.css  page.tsx
  (auth)/login/page.tsx  login/LoginForm.tsx  forgot-password/page.tsx  reset-password/page.tsx  change-password/page.tsx
  auth/callback/route.ts
  (app)/layout.tsx  home/page.tsx  stores/page.tsx  stores/[id]/page.tsx  devices/page.tsx
  (app)/admin/users/page.tsx  admin/users/[id]/access/page.tsx  admin/stores/page.tsx  admin/devices/page.tsx  admin/import/page.tsx
  api/health/route.ts  api/version/route.ts
components/ui/*  (copied from Desk)  components/layout/{AppShell,Sidebar,MobileNav,ThemeSwitcher,NewVersionBanner}.tsx
components/admin/{CreateUserForm,UserRow,AccessEditor,StoreForm,DeviceForm,ImportForm}.tsx
lib/
  utils.ts  brand.ts  nav.ts  time.ts  secrets.ts  secure-compare.ts  rate-limit.ts
  observability/{logger,sanitize-error}.ts
  supabase/{server,client,admin,resilient-fetch}.ts
  auth/{verified-user,safe-next,profile}.ts   validation/password.ts
  security/org-scope.ts
  admin/{audit,users}.ts
  import/{csv,regions,validators,stores-csv,devices-csv,apply}.ts
  inventory/{schemas,stores,devices}.ts
  queries/inventory.ts
  actions/{auth}.ts  actions/admin/{users,inventory,import}.ts
supabase/ config.toml  seed.sql  migrations/*.sql  rollback/*.sql
scripts/ env-from-supabase.mjs  lib/env-output.mjs  create-dev-admin.mjs
tests/
  setup/{env,fixtures}.ts
  unit/*.test.ts   integration/*.test.ts
types/database.ts   (generated by `npm run db:types`)
reference/  docs/  (already in the repository)
```

---

### Task 1: Project scaffold, test runner, health and version routes

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.env.example`, `app/layout.tsx`, `app/page.tsx`, `app/api/health/route.ts`, `app/api/version/route.ts`, `tests/setup/env.ts`
- Modify: `.gitignore` (replace the Python entries)
- Test: `tests/unit/api-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/health` returns `{status: "ok"}`; `GET /api/version` returns `{build: string}` (from `NEXT_PUBLIC_BUILD_ID`, default `"dev"`); npm scripts `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:unit`, `test:integration`, `db:start`, `db:stop`, `db:reset`, `db:types`, `env:local`.

- [ ] **Step 1: Write the project files**

`package.json`:
```json
{
  "name": "cctv-hub",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "next dev --port 3212",
    "build": "next build",
    "start": "next start --port 3212",
    "lint": "eslint app lib components types proxy.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run tests/unit",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "db:start": "supabase start -x logflare,vector,edge-runtime,realtime,imgproxy,supavisor",
    "db:stop": "supabase stop",
    "db:reset": "supabase db reset",
    "db:types": "supabase gen types typescript --local > types/database.ts",
    "env:local": "node scripts/env-from-supabase.mjs"
  },
  "dependencies": {
    "@base-ui/react": "^1.5.0",
    "@supabase/ssr": "^0.12.0",
    "@supabase/supabase-js": "^2.108.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.18.0",
    "next": "16.3.8",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "sonner": "^2.0.7",
    "tailwind-merge": "^3.6.0",
    "tw-animate-css": "^1.4.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@types/ws": "^8.18.1",
    "eslint": "^9",
    "eslint-config-next": "16.3.8",
    "shadcn": "^4.11.0",
    "supabase": "^2.111.0",
    "tailwindcss": "^4",
    "typescript": "^5.9.3",
    "vitest": "^3.2.7",
    "ws": "^8.21.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.mts"],
  "exclude": ["node_modules", "reference", "docs"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from 'next'

// One stamp per production build (set by the build script); "dev" locally. Open pages compare it with /api/version.
const BUILD_ID = process.env.CK_BUILD_ID || 'dev'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  generateBuildId: async () => BUILD_ID,
  output: 'standalone',
  devIndicators: false,
  turbopack: { root: __dirname },
  experimental: {
    serverActions: { bodySizeLimit: '30mb' },
    proxyClientMaxBodySize: '30mb',
    staleTimes: { dynamic: 30, static: 180 },
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
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
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one local database; run files one after another.
    fileParallelism: false,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
```

`postcss.config.mjs`:
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

`eslint.config.mjs`:
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "reference/**", "docs/**"]),
]);

export default eslintConfig;
```

`.gitignore` (replace the whole file):
```
node_modules/
.next/
out/
build/
coverage/
*.tsbuildinfo
next-env.d.ts
.env
.env.*
!.env.example
supabase/.temp/
supabase/.branches/
backups/
.DS_Store
```

`.env.example`:
```
# Copy the generated values with: npm run env:local   (writes .env.local, never committed)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_APP_URL=http://localhost:3212
NEXT_PUBLIC_STREAM_GATEWAY_URL=http://localhost:3213
TZ=Asia/Kolkata
CRON_SECRET=
WORKER_SECRET=
STREAM_TOKEN_SECRET=
SYSTEM_LOG_INGEST_SECRET=
```

`tests/setup/env.ts`:
```ts
// Vitest does not load .env.local the way Next does, so do it before any test file runs.
import path from 'node:path'
import WebSocket from 'ws'

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.local'))
} catch {
  // Nothing to load: fall back to whatever is already in process.env.
}

// Node 20 has no global WebSocket; supabase-js needs one just to construct a client.
if (!globalThis.WebSocket) {
  // @ts-expect-error -- ws's Node WebSocket is not the DOM WebSocket type
  globalThis.WebSocket = WebSocket
}
```

Temporary `app/layout.tsx` (replaced in Task 2):
```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```

Temporary `app/page.tsx` (replaced in Task 6):
```tsx
export default function Page() {
  return <main>CityKart Network Hub</main>
}
```

- [ ] **Step 2: Install dependencies and read the Next.js guide**

Run: `npm install`
Expected: completes without errors (the `supabase` package downloads its CLI binary).

Run: `ls node_modules/next/dist/docs` and read the pages on `proxy`, route handlers, Server Actions, `cookies`/`headers`, and `redirect`. Note any difference from what this plan assumes before continuing.

- [ ] **Step 3: Write the failing test**

`tests/unit/api-routes.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { GET as health } from '@/app/api/health/route'
import { GET as version } from '@/app/api/version/route'

describe('health and version routes', () => {
  it('health says ok', async () => {
    const res = await health()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('version reports the build id', async () => {
    process.env.NEXT_PUBLIC_BUILD_ID = 'abc123'
    const res = await version()
    expect(await res.json()).toEqual({ build: 'abc123' })
  })

  it('version falls back to dev', async () => {
    delete process.env.NEXT_PUBLIC_BUILD_ID
    const res = await version()
    expect(await res.json()).toEqual({ build: 'dev' })
  })
})
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run tests/unit/api-routes.test.ts`
Expected: FAIL (cannot resolve `@/app/api/health/route`).

- [ ] **Step 5: Implement the routes**

`app/api/health/route.ts`:
```ts
export const dynamic = 'force-dynamic'

// Plan 1 only reports that the web app is up. Plan 2 adds the database and worker heartbeat.
export function GET() {
  return Response.json({ status: 'ok' })
}
```

`app/api/version/route.ts`:
```ts
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ build: process.env.NEXT_PUBLIC_BUILD_ID || 'dev' })
}
```

- [ ] **Step 6: Run the checks**

Run: `npx vitest run tests/unit/api-routes.test.ts`
Expected: `3 passed`.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds (this proves the toolchain; delete the `.next` folder afterwards if you like).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Next.js 16 scaffold with test runner, health and version routes"
```

---

### Task 2: Design system and application shell

**Files:**
- Create (copied from `$DESK`): `app/globals.css`, `lib/utils.ts` (trimmed), `components.json`, `components/ui/{button,input,label,card,badge,separator,tabs,tooltip,sheet,avatar,scroll-area,dropdown-menu}.tsx`, `components/ui/{EmptyState,PageHeader}.tsx`, `public/` logo files are NOT copied (Desk branding)
- Create: `lib/brand.ts`, `lib/nav.ts`, `components/layout/{AppShell,Sidebar,MobileNav,ThemeSwitcher,NewVersionBanner}.tsx`
- Modify: `app/layout.tsx`
- Test: `tests/unit/nav.test.ts`

**Interfaces:**
- Produces: `cn(...)` in `lib/utils.ts`; `Role` type and `navFor(role): NavItem[]` in `lib/nav.ts`; `<AppShell profile={...}>` (props `profile: {full_name: string; role: Role}`).

- [ ] **Step 1: Copy the Desk design files**

Run (Git Bash):
```bash
DESK="/d/ANKUR AI PROJECTS/CitykartDesk-ZOHO Alternate"
mkdir -p components/ui components/layout
cp "$DESK/app/globals.css" app/globals.css
cp "$DESK/components.json" components.json
for f in button input label card badge separator tabs tooltip sheet avatar scroll-area dropdown-menu; do cp "$DESK/components/ui/$f.tsx" components/ui/; done
cp "$DESK/components/ui/EmptyState.tsx" "$DESK/components/ui/PageHeader.tsx" components/ui/
```

Create `lib/utils.ts` (Desk's `cn` only; Desk's request helpers do not apply here):
```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 2: Typecheck the copied files and fix imports**

Run: `npm run typecheck`
Expected: errors only for imports the copied files need that this project lacks (for example `@/types`, `@/lib/constants/...`, or another Desk-only module). For each error, open the copied file and remove the Desk-only import and the code that uses it (these are request/SLA helpers in `EmptyState`/`PageHeader` if any). If a copied component needs a package not in `package.json`, delete that component instead of adding the package. Re-run until clean.

- [ ] **Step 3: Write the failing navigation test**

`tests/unit/nav.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { navFor, type Role } from '@/lib/nav'

const hrefs = (role: Role) => navFor(role).map((i) => i.href)

describe('navigation per role', () => {
  it('a viewer sees monitoring pages only', () => {
    const h = hrefs('user')
    expect(h).toEqual(['/home', '/stores', '/devices'])
  })

  it('an operator and a manager see the same pages as a viewer in Plan 1', () => {
    expect(hrefs('agent')).toEqual(hrefs('user'))
    expect(hrefs('manager')).toEqual(hrefs('user'))
  })

  it('an admin also sees the admin pages', () => {
    const h = hrefs('admin')
    expect(h).toContain('/admin/users')
    expect(h).toContain('/admin/stores')
    expect(h).toContain('/admin/devices')
    expect(h).toContain('/admin/import')
  })

  it('a platform owner sees what an admin sees', () => {
    expect(hrefs('platform_owner')).toEqual(hrefs('admin'))
  })
})
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run tests/unit/nav.test.ts`
Expected: FAIL (cannot resolve `@/lib/nav`).

- [ ] **Step 5: Implement navigation, brand and the shell**

`lib/nav.ts`:
```ts
export type Role = 'user' | 'agent' | 'manager' | 'admin' | 'platform_owner'

export type NavItem = {
  href: string
  label: string
  icon: 'home' | 'store' | 'server' | 'users' | 'upload' | 'building'
  group: 'Monitoring' | 'Admin'
  roles?: Role[]
}

const ADMIN: Role[] = ['admin', 'platform_owner']

// One list for the sidebar and the mobile bar. Hiding a link is not a security control: every page and action checks the role again.
export const NAV: NavItem[] = [
  { href: '/home', label: 'Home', icon: 'home', group: 'Monitoring' },
  { href: '/stores', label: 'Stores', icon: 'store', group: 'Monitoring' },
  { href: '/devices', label: 'Devices', icon: 'server', group: 'Monitoring' },
  { href: '/admin/users', label: 'Users', icon: 'users', group: 'Admin', roles: ADMIN },
  { href: '/admin/stores', label: 'Manage stores', icon: 'building', group: 'Admin', roles: ADMIN },
  { href: '/admin/devices', label: 'Manage devices', icon: 'server', group: 'Admin', roles: ADMIN },
  { href: '/admin/import', label: 'Import', icon: 'upload', group: 'Admin', roles: ADMIN },
]

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => !item.roles || item.roles.includes(role))
}
```

`lib/brand.ts`:
```ts
// Name shown in the app. Plan 4 moves this into an admin settings screen.
export const BRAND = {
  name: 'CityKart Network Hub',
  short: 'Network Hub',
  subtitle: 'Cameras, servers and devices at a glance',
} as const
```

`components/layout/ThemeSwitcher.tsx`:
```tsx
'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

const KEY = 'cctvhub-theme'

export function ThemeSwitcher() {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    // Read after mount so server and browser first render the same thing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains('dark'))
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light')
    } catch {
      // Storage can be blocked; the theme then lasts only for this visit.
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
```

`components/layout/NewVersionBanner.tsx`:
```tsx
'use client'

import { useEffect, useState } from 'react'

// Tells people to refresh after a new version is installed (the build id changes).
export function NewVersionBanner() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID || 'dev'
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        const { build } = (await res.json()) as { build: string }
        setStale(build !== mine)
      } catch {
        // The server may be restarting; try again next time.
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!stale) return null
  return (
    <div className="bg-primary px-4 py-2 text-center text-sm text-primary-foreground">
      A new version is ready.{' '}
      <button className="underline" onClick={() => window.location.reload()}>
        Refresh the page
      </button>
    </div>
  )
}
```

`components/layout/Sidebar.tsx`:
```tsx
'use client'

import { Building2, Home, Server, Store, Upload, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { NavItem } from '@/lib/nav'
import { BRAND } from '@/lib/brand'

const ICONS = { home: Home, store: Store, server: Server, users: Users, upload: Upload, building: Building2 }

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  const groups = ['Monitoring', 'Admin'] as const
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="px-5 py-4">
        <div className="text-base font-semibold">{BRAND.name}</div>
        <div className="text-xs text-muted-foreground">{BRAND.subtitle}</div>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.map((group) => {
          const list = items.filter((i) => i.group === group)
          if (list.length === 0) return null
          return (
            <div key={group}>
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</div>
              <ul className="space-y-0.5">
                {list.map((item) => {
                  const Icon = ICONS[item.icon]
                  const active = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-sidebar-accent',
                          active && 'bg-sidebar-accent font-medium',
                        )}
                      >
                        <Icon className="size-4" />
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
```

`components/layout/MobileNav.tsx`:
```tsx
'use client'

import { Home, Server, Store } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

// Bottom bar for phones: the three pages everybody uses. Admin pages are used on a computer.
const ITEMS = [
  { href: '/home', label: 'Home', Icon: Home },
  { href: '/stores', label: 'Stores', Icon: Store },
  { href: '/devices', label: 'Devices', Icon: Server },
]

export function MobileNav() {
  const pathname = usePathname()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background md:hidden">
      {ITEMS.map(({ href, label, Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            'flex flex-1 flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground',
            pathname.startsWith(href) && 'text-foreground font-medium',
          )}
        >
          <Icon className="size-5" />
          {label}
        </Link>
      ))}
    </nav>
  )
}
```

`components/layout/AppShell.tsx`:
```tsx
import { navFor, type Role } from '@/lib/nav'
import { signOut } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { MobileNav } from './MobileNav'
import { NewVersionBanner } from './NewVersionBanner'
import { Sidebar } from './Sidebar'
import { ThemeSwitcher } from './ThemeSwitcher'

export function AppShell({ profile, children }: { profile: { full_name: string; role: Role }; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-screen">
      <Sidebar items={navFor(profile.role)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <NewVersionBanner />
        <header className="flex items-center justify-end gap-2 border-b px-4 py-2">
          <span className="mr-2 text-sm text-muted-foreground">{profile.full_name}</span>
          <ThemeSwitcher />
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </header>
        <main className="mx-auto w-full max-w-[100rem] flex-1 p-4 pb-20 md:p-6 md:pb-6">{children}</main>
      </div>
      <MobileNav />
    </div>
  )
}
```
(`signOut` is created in Task 6; until then typecheck reports it missing. Create a stub `lib/actions/auth.ts` now: `'use server'\nexport async function signOut() {}` and replace it in Task 6.)

`app/layout.tsx` (replace):
```tsx
import type { Metadata } from 'next'
import { JetBrains_Mono, Manrope } from 'next/font/google'
import { Toaster } from 'sonner'
import { BRAND } from '@/lib/brand'
import './globals.css'

const manrope = Manrope({ variable: '--font-manrope', subsets: ['latin'], display: 'swap' })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-jetbrains', subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: { template: `%s — ${BRAND.short}`, default: BRAND.name },
  description: BRAND.subtitle,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${manrope.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <head>
        {/* Apply the saved theme before the first paint so the page does not flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var v=localStorage.getItem('cctvhub-theme')||'light';var r=document.documentElement;r.setAttribute('data-theme',v);r.classList.toggle('dark',v==='dark');}catch(e){}})()`,
          }}
        />
      </head>
      <body className="h-full">
        {children}
        <Toaster richColors position="bottom-right" />
      </body>
    </html>
  )
}
```

- [ ] **Step 6: Run the checks**

Run: `npx vitest run tests/unit/nav.test.ts`
Expected: `4 passed`.

Run: `npm run typecheck` and `npm run lint`
Expected: clean. (If `react-hooks/set-state-in-effect` is not a known rule in this ESLint version, remove the disable comment.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Desk design system, application shell and role-based navigation"
```

---

### Task 3: Local Supabase stack on ports 553xx and `.env.local` generator

**Files:**
- Create: `supabase/config.toml` (generated, then edited), `supabase/seed.sql`, `scripts/lib/env-output.mjs`, `scripts/env-from-supabase.mjs`
- Test: `tests/unit/env-output.test.ts`

**Interfaces:**
- Produces: a running local Supabase stack (API `http://127.0.0.1:55321`, DB port 55322); `parseEnvOutput(text): Record<string,string>` in `scripts/lib/env-output.mjs`; `npm run env:local` writes `.env.local` (git-ignored) with the Supabase keys and freshly generated per-purpose secrets, and prints only variable names.

- [ ] **Step 1: Write the failing test for the parser**

`tests/unit/env-output.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseEnvOutput } from '@/scripts/lib/env-output.mjs'

describe('parseEnvOutput', () => {
  it('reads KEY="value" and KEY=value lines and ignores everything else', () => {
    const text = ['API_URL="http://127.0.0.1:55321"', 'ANON_KEY=abc.def.ghi', '', '# comment', 'not a pair', 'SERVICE_ROLE_KEY="x=y"'].join('\n')
    expect(parseEnvOutput(text)).toEqual({
      API_URL: 'http://127.0.0.1:55321',
      ANON_KEY: 'abc.def.ghi',
      SERVICE_ROLE_KEY: 'x=y',
    })
  })

  it('handles Windows line endings', () => {
    expect(parseEnvOutput('A="1"\r\nB="2"\r\n')).toEqual({ A: '1', B: '2' })
  })
})
```
Add `"@/scripts/*"` resolution: the `@` alias already maps to the repository root, so `@/scripts/lib/env-output.mjs` resolves.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/unit/env-output.test.ts`
Expected: FAIL (cannot resolve the module).

- [ ] **Step 3: Implement the parser and the env script**

`scripts/lib/env-output.mjs`:
```js
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
```

`scripts/env-from-supabase.mjs`:
```js
// Writes .env.local from the running local Supabase stack. Prints only variable NAMES, never values.
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { parseEnvOutput } from './lib/env-output.mjs'

if (existsSync('.env.local') && !process.argv.includes('--force')) {
  console.log('.env.local already exists. Run with --force to replace it.')
  process.exit(0)
}

const status = parseEnvOutput(execSync('npx supabase status -o env', { encoding: 'utf8' }))
const need = ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']
const missing = need.filter((k) => !status[k])
if (missing.length) {
  console.error(`supabase status did not give: ${missing.join(', ')}. Is the stack running (npm run db:start)?`)
  process.exit(1)
}

const secret = () => randomBytes(32).toString('base64url')
const lines = {
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_APP_URL: 'http://localhost:3212',
  NEXT_PUBLIC_STREAM_GATEWAY_URL: 'http://localhost:3213',
  TZ: 'Asia/Kolkata',
  CRON_SECRET: secret(),
  WORKER_SECRET: secret(),
  STREAM_TOKEN_SECRET: secret(),
  SYSTEM_LOG_INGEST_SECRET: secret(),
  // Local development sign-in for create-dev-admin.mjs (synthetic address, random password, never printed).
  DEV_ADMIN_EMAIL: 'dev-admin@example.test',
  DEV_ADMIN_PASSWORD: randomBytes(15).toString('base64url') + 'aA1',
}
writeFileSync('.env.local', Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
console.log('Wrote .env.local with: ' + Object.keys(lines).join(', '))
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/unit/env-output.test.ts`
Expected: `2 passed`.

- [ ] **Step 5: Create and start the Supabase stack**

Run:
```bash
npx supabase init --force --with-vscode-settings=false --with-intellij-settings=false
sed -i 's/^project_id = .*/project_id = "cctv_hub"/' supabase/config.toml
sed -i -E 's/\b5432([0-9])\b/5532\1/g' supabase/config.toml
sed -i 's#^site_url = .*#site_url = "http://localhost:3212"#' supabase/config.toml
sed -i 's#^additional_redirect_urls = .*#additional_redirect_urls = ["http://localhost:3212"]#' supabase/config.toml
sed -i 's/enable_signup = true/enable_signup = false/' supabase/config.toml
grep -nE '^(project_id|port|shadow_port|site_url|additional_redirect_urls|enable_signup)' supabase/config.toml
```
Expected: `project_id = "cctv_hub"`, every `port` and `shadow_port` is in 55320-55329, `site_url` is `http://localhost:3212`, `enable_signup = false` (twice).

`supabase/seed.sql`:
```sql
-- Dev and test data only: the single organisation this app runs for.
INSERT INTO organizations (name, slug, is_owner)
VALUES ('CityKart', 'citykart', true)
ON CONFLICT (slug) DO NOTHING;
```
(The `organizations` table is created in Task 4; until then `db reset` is not run, so this file is harmless.)

Run: `npm run db:start`
Expected: images are pulled the first time (several minutes), then the command prints the local URLs.

Run: `npm run env:local`
Expected: `Wrote .env.local with: NEXT_PUBLIC_SUPABASE_URL, ...` (names only).

Run: `curl -s http://127.0.0.1:55321/auth/v1/health`
Expected: a JSON body with `"name":"GoTrue"`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: local Supabase stack on ports 553xx and .env.local generator"
```

---

### Task 4: Identity schema (organisations, profiles, role helpers) and the integration test harness

**Files:**
- Create: `supabase/migrations/20261021000001_core_identity.sql`, `supabase/rollback/20261021000001_core_identity_rollback.sql`, `tests/setup/fixtures.ts`, `types/database.ts` (generated)
- Test: `tests/integration/identity-rls.test.ts`

**Interfaces:**
- Produces: enum `user_role`; tables `organizations`, `profiles`; functions `current_org_id()`, `current_user_role()` (both return null while `must_reset_password` or inactive); trigger function `set_updated_at()`. Test fixtures in `tests/setup/fixtures.ts`: `assertLocalStack()`, `adminClient()`, `createOrg(): Promise<string>`, `createUser(orgId, role, opts?: {storeId?: string | null; mustReset?: boolean}): Promise<TestUser>` where `TestUser = {id, email, password, client}` (`client` is signed in as that user), `cleanupOrg(orgId)`, and the exported array `ORG_TABLES_IN_DELETE_ORDER`.

- [ ] **Step 1: Write the fixtures**

`tests/setup/fixtures.ts`:
```ts
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export type Role = Database['public']['Enums']['user_role']
export type TestUser = { id: string; email: string; password: string; client: SupabaseClient<Database> }

// Isolation gate: integration tests may only touch the local Supabase stack, never anything else.
export function assertLocalStack(): void {
  const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://invalid.invalid')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (!local || u.port !== '55321') {
    throw new Error('Isolation gate: integration tests only run against the local Supabase stack on port 55321.')
  }
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } }

export function adminClient(): SupabaseClient<Database> {
  assertLocalStack()
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts)
}

export async function createOrg(): Promise<string> {
  const tag = randomUUID()
  const { data, error } = await adminClient().from('organizations').insert({ name: `test-${tag}`, slug: `test-${tag}` }).select('id').single()
  if (error || !data) throw new Error(`createOrg failed: ${error?.message}`)
  return data.id
}

export async function createUser(orgId: string, role: Role, o: { storeId?: string | null; mustReset?: boolean } = {}): Promise<TestUser> {
  const admin = adminClient()
  const email = `${randomUUID()}@example.test`
  const password = randomBytes(12).toString('base64url') + 'aA1!'
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: pErr } = await admin.from('profiles').insert({
    id: data.user.id,
    org_id: orgId,
    email,
    full_name: 'Test User',
    role,
    must_reset_password: o.mustReset ?? false,
    store_id: o.storeId ?? null,
  })
  if (pErr) throw new Error(`profile insert failed: ${pErr.message}`)
  const client = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts)
  const { error: sErr } = await client.auth.signInWithPassword({ email, password })
  if (sErr) throw new Error(`sign-in failed: ${sErr.message}`)
  return { id: data.user.id, email, password, client }
}

// Child tables first. Later tasks add their tables to this list.
export const ORG_TABLES_IN_DELETE_ORDER: string[] = []

export async function cleanupOrg(orgId: string): Promise<void> {
  const admin = adminClient()
  for (const table of ORG_TABLES_IN_DELETE_ORDER) {
    // @ts-expect-error -- table names here are plain strings on purpose
    await admin.from(table).delete().eq('org_id', orgId)
  }
  const { data: people } = await admin.from('profiles').select('id').eq('org_id', orgId)
  for (const p of people ?? []) await admin.auth.admin.deleteUser(p.id)
  await admin.from('profiles').delete().eq('org_id', orgId)
  await admin.from('organizations').delete().eq('id', orgId)
}
```

- [ ] **Step 2: Write the failing test**

`tests/integration/identity-rls.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

describe('identity row-level security', () => {
  let orgA: string
  let orgB: string
  let adminA: TestUser
  let viewerA: TestUser
  let resetA: TestUser
  let adminB: TestUser

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    adminA = await createUser(orgA, 'admin')
    viewerA = await createUser(orgA, 'user')
    resetA = await createUser(orgA, 'user', { mustReset: true })
    adminB = await createUser(orgB, 'admin')
  })

  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('a user sees only their own organisation', async () => {
    const { data } = await viewerA.client.from('organizations').select('id')
    expect(data).toEqual([{ id: orgA }])
  })

  it('a viewer reads only their own profile', async () => {
    const { data } = await viewerA.client.from('profiles').select('id')
    expect(data).toEqual([{ id: viewerA.id }])
  })

  it('an admin reads every profile of their organisation and none of another', async () => {
    const { data } = await adminA.client.from('profiles').select('id')
    const ids = (data ?? []).map((r) => r.id).sort()
    expect(ids).toEqual([adminA.id, viewerA.id, resetA.id].sort())
    expect(ids).not.toContain(adminB.id)
  })

  it('a person who must reset the password has no organisation or role, but can read their own profile', async () => {
    const orgs = await resetA.client.from('organizations').select('id')
    expect(orgs.data).toEqual([])
    const role = await resetA.client.rpc('current_user_role')
    expect(role.data).toBeNull()
    const me = await resetA.client.from('profiles').select('id, must_reset_password')
    expect(me.data).toEqual([{ id: resetA.id, must_reset_password: true }])
  })

  it('signed-in users cannot change profiles', async () => {
    const upd = await viewerA.client.from('profiles').update({ role: 'admin' }).eq('id', viewerA.id)
    expect(upd.error?.code).toBe('42501')
    const ins = await adminA.client.from('profiles').insert({ id: crypto.randomUUID(), org_id: orgA, email: 'x@example.test' })
    expect(ins.error?.code).toBe('42501')
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/integration/identity-rls.test.ts`
Expected: FAIL (the tables do not exist yet; also `@/types/database` is missing).

- [ ] **Step 4: Write the migration and its rollback**

`supabase/migrations/20261021000001_core_identity.sql`:
```sql
-- Core identity: organisations, profiles, role helpers. Rollback: supabase/rollback/20261021000001_core_identity_rollback.sql
BEGIN;

CREATE TYPE public.user_role AS ENUM ('user', 'agent', 'manager', 'admin', 'platform_owner');

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  is_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'user',
  is_active boolean NOT NULL DEFAULT true,
  -- A new or admin-reset account must choose its own password before anything else works.
  must_reset_password boolean NOT NULL DEFAULT true,
  store_id uuid,  -- foreign key to stores is added in the next migration
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_org_idx ON public.profiles (org_id);
CREATE UNIQUE INDEX profiles_org_email_idx ON public.profiles (org_id, lower(email));

CREATE TRIGGER organizations_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Caller identity. A person who still has to choose a password, or who is deactivated, has no organisation and no role.
CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;

CREATE OR REPLACE FUNCTION public.current_user_role() RETURNS public.user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE id = auth.uid() AND is_active AND NOT coalesce(must_reset_password, false)
$$;

REVOKE EXECUTE ON FUNCTION public.current_org_id(), public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_org_id(), public.current_user_role() TO authenticated, service_role;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON public.organizations FOR SELECT TO authenticated
  USING (id = (SELECT public.current_org_id()));

-- Anyone may read their own profile (the app needs it to send them to the password page); staff read the whole organisation.
CREATE POLICY profiles_select_self ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY profiles_select_org ON public.profiles FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.current_user_role()) IN ('manager', 'admin', 'platform_owner'));

REVOKE ALL ON public.organizations, public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organizations, public.profiles TO authenticated;
GRANT ALL ON public.organizations, public.profiles TO service_role;

COMMIT;
```

`supabase/rollback/20261021000001_core_identity_rollback.sql`:
```sql
BEGIN;
DROP TABLE IF EXISTS public.profiles;
DROP TABLE IF EXISTS public.organizations;
DROP FUNCTION IF EXISTS public.current_user_role();
DROP FUNCTION IF EXISTS public.current_org_id();
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP TYPE IF EXISTS public.user_role;
COMMIT;
```

- [ ] **Step 5: Apply, generate types, run the test**

Run: `npm run db:reset`
Expected: migrations and `seed.sql` apply without errors.

Run: `npm run db:types`
Expected: `types/database.ts` now defines `Database` with `profiles`, `organizations`, `user_role`.

Run: `npx vitest run tests/integration/identity-rls.test.ts`
Expected: `5 passed`.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: identity schema with row-level security and integration test harness"
```

---

### Task 5: Core libraries (secrets, rate limit, logging, error boundary, time, Supabase clients)

**Files:**
- Create: `lib/secrets.ts`, `lib/secure-compare.ts`, `lib/rate-limit.ts`, `lib/time.ts`, `lib/observability/logger.ts`, `lib/observability/sanitize-error.ts`, `lib/supabase/{resilient-fetch,server,client,admin}.ts`, `lib/auth/verified-user.ts`
- Test: `tests/unit/secrets.test.ts`, `tests/unit/secure-compare.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/unit/time.test.ts`, `tests/unit/logger.test.ts`, `tests/unit/sanitize-error.test.ts`, `tests/unit/resilient-fetch.test.ts`, `tests/unit/verified-user.test.ts`

**Interfaces:**
- Produces: `getSecret(purpose: SecretPurpose): string | null`, `auditSecrets(env?): SecretIssue[]`, `secretEnvName(purpose)`; `secureCompare(a, b): boolean`; `rateLimit(key, limit?, windowMs?): Promise<{limited, remaining}>`, `isOverLimit(key, limit): boolean`, `recordEvent(key, windowMs): number`, `getClientIp(): Promise<string | null>`; `formatDateTime(value): string`; `logger.{info,warn,error}(fields)`, `redact(value)`; `sanitizeError(err, opts?): string`; `resilientFetch`; `createClient()` (server, RLS), `createBrowserClient` named export `createClient` in `lib/supabase/client.ts`, `createAdminClient()`; `signVerifiedUser(id)`, `readVerifiedUserId(headers)`, constants `VERIFIED_USER_HEADER`, `VERIFIED_USER_SIG_HEADER`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/secrets.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { auditSecrets, getSecret, MIN_SECRET_LENGTH } from '@/lib/secrets'

const KEYS = ['CRON_SECRET', 'WORKER_SECRET', 'STREAM_TOKEN_SECRET', 'SYSTEM_LOG_INGEST_SECRET']
afterEach(() => KEYS.forEach((k) => delete process.env[k]))

describe('secrets', () => {
  it('returns null when a secret is missing or blank, and never another purpose’s value', () => {
    process.env.CRON_SECRET = 'cron-secret-value-123'
    expect(getSecret('worker')).toBeNull()
    process.env.WORKER_SECRET = '   '
    expect(getSecret('worker')).toBeNull()
    expect(getSecret('cron')).toBe('cron-secret-value-123')
  })

  it('reports missing, short and duplicated secrets without printing values', () => {
    const same = 'abcdefghijklmnopqrst'
    const env = { CRON_SECRET: same, WORKER_SECRET: same, STREAM_TOKEN_SECRET: 'short' }
    const issues = auditSecrets(env)
    const text = JSON.stringify(issues)
    expect(issues.some((i) => i.env === 'WORKER_SECRET' && i.problem.startsWith('the same value as'))).toBe(true)
    expect(issues.some((i) => i.env === 'STREAM_TOKEN_SECRET' && i.problem.includes(String(MIN_SECRET_LENGTH)))).toBe(true)
    expect(issues.some((i) => i.env === 'SYSTEM_LOG_INGEST_SECRET' && i.problem === 'not set')).toBe(true)
    expect(text).not.toContain(same)
  })

  it('has no issues when every secret is set, long and different', () => {
    const env = {
      CRON_SECRET: 'a'.repeat(20), WORKER_SECRET: 'b'.repeat(20),
      STREAM_TOKEN_SECRET: 'c'.repeat(20), SYSTEM_LOG_INGEST_SECRET: 'd'.repeat(20),
    }
    expect(auditSecrets(env)).toEqual([])
  })
})
```

`tests/unit/secure-compare.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { secureCompare } from '@/lib/secure-compare'

describe('secureCompare', () => {
  it('is true only for identical strings', () => {
    expect(secureCompare('abc', 'abc')).toBe(true)
    expect(secureCompare('abc', 'abd')).toBe(false)
  })
  it('does not throw on different lengths', () => {
    expect(secureCompare('abc', 'abcd')).toBe(false)
    expect(secureCompare('', 'x')).toBe(false)
  })
})
```

`tests/unit/rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isOverLimit, rateLimit, recordEvent } from '@/lib/rate-limit'

describe('rate limit', () => {
  it('allows up to the limit and then blocks', async () => {
    const key = `t1-${Math.random()}`
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, 3, 60_000)).limited).toBe(false)
    expect((await rateLimit(key, 3, 60_000)).limited).toBe(true)
  })

  it('counts only recorded events and can be asked without counting', () => {
    const key = `t2-${Math.random()}`
    expect(isOverLimit(key, 2)).toBe(false)
    expect(recordEvent(key, 60_000)).toBe(1)
    expect(isOverLimit(key, 2)).toBe(false)
    recordEvent(key, 60_000)
    expect(isOverLimit(key, 2)).toBe(true)
  })

  it('treats very long keys safely', async () => {
    const key = 'x'.repeat(500)
    expect((await rateLimit(key, 1, 60_000)).limited).toBe(false)
  })
})
```

`tests/unit/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatDateTime } from '@/lib/time'

describe('formatDateTime', () => {
  it('shows IST on a 24-hour clock', () => {
    expect(formatDateTime('2026-10-21T05:50:00Z')).toBe('21 Oct 2026, 11:20')
  })
  it('shows midnight as 00 and rolls the date', () => {
    expect(formatDateTime('2026-10-21T18:35:00Z')).toBe('22 Oct 2026, 00:05')
  })
  it('shows a dash for empty or invalid values', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('not a date')).toBe('—')
  })
})
```

`tests/unit/logger.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { redact } from '@/lib/observability/logger'

describe('redact', () => {
  it('hides secret-looking keys at any depth', () => {
    const out = redact({ user: 'a', password: 'p', nested: { apiKey: 'k', token: 't', ok: 1 }, list: [{ authorization: 'x' }] })
    expect(out).toEqual({ user: 'a', password: '[redacted]', nested: { apiKey: '[redacted]', token: '[redacted]', ok: 1 }, list: [{ authorization: '[redacted]' }] })
  })
  it('keeps only name and message of an Error', () => {
    const out = redact(new Error('boom')) as Record<string, unknown>
    expect(out).toEqual({ name: 'Error', message: 'boom' })
  })
})
```

`tests/unit/sanitize-error.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/observability/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, redact: (v: unknown) => v }))

import { sanitizeError } from '@/lib/observability/sanitize-error'

describe('sanitizeError', () => {
  it('maps known database codes to plain messages without echoing driver text', () => {
    const msg = sanitizeError({ code: '23505', message: 'duplicate key value violates unique constraint "stores_org_code_key"' })
    expect(msg).toBe('That already exists. Please check for a duplicate and try again.')
    expect(msg).not.toContain('stores_org_code_key')
  })
  it('maps a permission error', () => {
    expect(sanitizeError({ code: '42501' })).toBe('You do not have permission to perform this action.')
  })
  it('uses the fallback for anything unknown', () => {
    expect(sanitizeError(new Error('secret internals'), { fallback: 'Could not save.' })).toBe('Could not save.')
  })
})
```

`tests/unit/resilient-fetch.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

afterEach(() => vi.unstubAllGlobals())

describe('resilientFetch', () => {
  it('retries a GET once after a network error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response('ok'))
    vi.stubGlobal('fetch', fn)
    const res = await resilientFetch('http://x.test/a')
    expect(await res.text()).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('does not retry a POST', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('network'))
    vi.stubGlobal('fetch', fn)
    await expect(resilientFetch('http://x.test/a', { method: 'POST' })).rejects.toThrow('network')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
```

`tests/unit/verified-user.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { readVerifiedUserId, signVerifiedUser, VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER } from '@/lib/auth/verified-user'

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null })
afterEach(() => delete process.env.SUPABASE_SERVICE_ROLE_KEY)

describe('verified user header', () => {
  it('accepts a correctly signed id', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    const sig = signVerifiedUser('user-1')!
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: sig }))).toBe('user-1')
  })
  it('treats a forged signature as untrusted', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: 'user-1', [VERIFIED_USER_SIG_HEADER]: 'bad' }))).toBeUndefined()
  })
  it('reads an empty signed id as signed out', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-for-tests'
    const sig = signVerifiedUser('')!
    expect(readVerifiedUserId(headers({ [VERIFIED_USER_HEADER]: '', [VERIFIED_USER_SIG_HEADER]: sig }))).toBeNull()
  })
  it('trusts nothing when no key is configured', () => {
    expect(signVerifiedUser('u')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit`
Expected: the new test files FAIL (modules missing).

- [ ] **Step 3: Implement the libraries**

`lib/secrets.ts`:
```ts
// One secret per purpose. A missing one means "not available" (the feature is off and says so), never "use another secret".
export type SecretPurpose = 'cron' | 'worker' | 'stream_token' | 'system_log_ingest'

const ENV_NAME: Record<SecretPurpose, string> = {
  cron: 'CRON_SECRET',
  worker: 'WORKER_SECRET',
  stream_token: 'STREAM_TOKEN_SECRET',
  system_log_ingest: 'SYSTEM_LOG_INGEST_SECRET',
}

export const MIN_SECRET_LENGTH = 16
const clean = (v: string | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** The secret for this purpose, or null when it is not configured. The caller must then refuse or switch the feature off. */
export function getSecret(purpose: SecretPurpose): string | null {
  return clean(process.env[ENV_NAME[purpose]])
}

export const secretEnvName = (purpose: SecretPurpose) => ENV_NAME[purpose]

export type SecretIssue = { purpose: SecretPurpose; env: string; problem: string }

/** What is wrong with the configured secrets, without ever returning a value. */
export function auditSecrets(env: Record<string, string | undefined> = process.env): SecretIssue[] {
  const issues: SecretIssue[] = []
  const seen = new Map<string, string>()
  for (const purpose of Object.keys(ENV_NAME) as SecretPurpose[]) {
    const name = ENV_NAME[purpose]
    const v = clean(env[name])
    if (!v) {
      issues.push({ purpose, env: name, problem: 'not set' })
      continue
    }
    if (v.length < MIN_SECRET_LENGTH) issues.push({ purpose, env: name, problem: `shorter than ${MIN_SECRET_LENGTH} characters` })
    const other = seen.get(v)
    if (other) issues.push({ purpose, env: name, problem: `the same value as ${other}` })
    else seen.set(v, name)
  }
  return issues
}
```

`lib/secure-compare.ts`:
```ts
import { timingSafeEqual } from 'node:crypto'

// Constant-time comparison for secrets. A plain === stops at the first different byte and can leak it through timing.
export function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
```

`lib/rate-limit.ts`:
```ts
import { headers } from 'next/headers'

type Entry = { count: number; resetAt: number }
const store = new Map<string, Entry>()

const MAX_KEYS = 50_000
let lastCleanup = 0
function cleanup() {
  const now = Date.now()
  // At most once a second, and the table can never grow without limit.
  if (now - lastCleanup < 1000 && store.size <= MAX_KEYS) return
  lastCleanup = now
  for (const [k, v] of store) if (v.resetAt < now) store.delete(k)
  for (const k of store.keys()) {
    if (store.size <= MAX_KEYS) break
    store.delete(k)
  }
}

const clip = (key: string) => (key.length > 200 ? key.slice(0, 200) : key)

/** Simple in-process rate limiter (one counter per key and window). Use a shared store if the app ever runs as several copies. */
export async function rateLimit(key: string, limit = 5, windowMs = 60_000): Promise<{ limited: boolean; remaining: number }> {
  cleanup()
  key = clip(key)
  const now = Date.now()
  const entry = store.get(key)
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { limited: false, remaining: limit - 1 }
  }
  entry.count++
  if (entry.count > limit) return { limited: true, remaining: 0 }
  return { limited: false, remaining: limit - entry.count }
}

/** Is this key already over its limit? Does not count the call (used before a sign-in attempt; only failed attempts are counted). */
export function isOverLimit(key: string, limit: number): boolean {
  const entry = store.get(clip(key))
  return !!entry && entry.resetAt >= Date.now() && entry.count >= limit
}

/** Count one event on a key (a failed sign-in) and return how many there have been in the window. */
export function recordEvent(key: string, windowMs: number): number {
  cleanup()
  key = clip(key)
  const now = Date.now()
  const entry = store.get(key)
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return 1
  }
  entry.count++
  return entry.count
}

/**
 * The caller's address, or null when it cannot be known reliably. A client can send any X-Forwarded-For it likes, so it is only
 * believed when the number of reverse proxies in front of the app is configured (TRUSTED_PROXY_HOPS=1 for one proxy).
 */
export async function getClientIp(): Promise<string | null> {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0)
  if (!Number.isInteger(hops) || hops < 1) return null
  const parts = ((await headers()).get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length >= hops ? parts[parts.length - hops] : null
}
```

`lib/time.ts`:
```ts
// 24-hour clock in IST, no AM/PM: the one format used across the app.
const dtf = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`
}
```

`lib/observability/logger.ts`:
```ts
type Level = 'info' | 'warn' | 'error'

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|service[-_]?role/i

/** Copy of a value that is safe to log: secret-looking keys hidden, errors reduced to name and message. */
export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '[depth]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  )
}

function emit(level: Level, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...(redact(fields) as Record<string, unknown>) })
  if (level === 'error') console.error(line)
  else console.log(line)
}

export const logger = {
  info: (f: Record<string, unknown>) => emit('info', f),
  warn: (f: Record<string, unknown>) => emit('warn', f),
  error: (f: Record<string, unknown>) => emit('error', f),
}
```

`lib/observability/sanitize-error.ts`:
```ts
import { logger } from './logger'

// The one place that turns a raw database, auth or thrown error into a short message that is safe to show.
// The real error is logged first, so nothing is lost for debugging.

export interface PgErrorLike {
  code?: string
  message?: string
}

const PG_CODE_MESSAGES: Record<string, string> = {
  '23505': 'That already exists. Please check for a duplicate and try again.',
  '23503': 'This action refers to something that no longer exists. Please refresh and try again.',
  '23502': 'A required field is missing. Please fill in all required fields and try again.',
  '23514': 'One of the values provided is not valid for this field.',
  '22P02': 'One of the values provided is not in the expected format.',
  '42501': 'You do not have permission to perform this action.',
  '40001': 'This record was changed by someone else at the same time. Please refresh and try again.',
  '55P03': 'This record is being updated elsewhere. Please try again in a moment.',
}

// Messages written for end users by the sign-in service itself.
const SAFE_AUTH_MESSAGES = new Set([
  'Invalid login credentials',
  'Email not confirmed',
  'User already registered',
  'New password should be different from the old password.',
])

const DEFAULT_MESSAGE = 'Something went wrong. Please try again, and contact support if the problem continues.'

export interface SanitizeErrorOptions {
  fallback?: string
  route?: string
  context?: Record<string, unknown>
}

const isPgErrorLike = (err: unknown): err is PgErrorLike => typeof err === 'object' && err !== null && ('code' in err || 'message' in err)

export function sanitizeError(err: unknown, opts: SanitizeErrorOptions = {}): string {
  logger.error({
    event: 'error_sanitized',
    route: opts.route,
    errorCode: isPgErrorLike(err) && typeof err.code === 'string' ? err.code : undefined,
    context: opts.context,
    error: err,
  })
  if (isPgErrorLike(err)) {
    if (err.code && PG_CODE_MESSAGES[err.code]) return PG_CODE_MESSAGES[err.code]
    if (err.message && SAFE_AUTH_MESSAGES.has(err.message)) return err.message
  }
  return opts.fallback ?? DEFAULT_MESSAGE
}
```

`lib/supabase/resilient-fetch.ts`:
```ts
const TIMEOUT_MS = 20_000

/** fetch with a time limit; a GET or HEAD that fails on the network is tried once more. Writes are never repeated. */
export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const attempts = method === 'GET' || method === 'HEAD' ? 2 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      return await fetch(input, { ...init, signal })
    } catch (err) {
      lastError = err
      if (init?.signal?.aborted) break
    }
  }
  throw lastError
}
```

`lib/supabase/server.ts`:
```ts
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

/** Cookie-bound client: acts as the signed-in person and row-level security applies. */
export async function createClient() {
  const cookieStore = await cookies()
  const secure = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { fetch: resilientFetch },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(list) {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, secure ? { ...options, secure: true } : options))
        } catch {
          // Called from a Server Component: proxy.ts refreshes the session instead.
        }
      },
    },
  })
}
```

`lib/supabase/client.ts`:
```ts
import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

export function createClient() {
  return createBrowserClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { fetch: resilientFetch },
  })
}
```

`lib/supabase/admin.ts`:
```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { resilientFetch } from '@/lib/supabase/resilient-fetch'

/**
 * Service-role client: bypasses row-level security. Server only, never sent to the browser.
 * Used for writes that browsers must never make (users, grants, inventory, audit, Vault).
 */
export function createAdminClient() {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: resilientFetch },
  })
}
```

`lib/auth/verified-user.ts`:
```ts
// proxy.ts verifies the session once per request and forwards who the user is. That forwarded value must never be forgeable:
//   - the proxy deletes any client-supplied copy of these headers, and
//   - the value it sets is signed with a server-only key, so a copy that did not come from the proxy fails verification.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const VERIFIED_USER_HEADER = 'x-verified-user-id'
export const VERIFIED_USER_SIG_HEADER = 'x-verified-user-sig'

// The signing key is the server's own service key (never the cron secret). Without it nothing is signed.
const key = (): string | null => process.env.SUPABASE_SERVICE_ROLE_KEY || null
const mac = (k: string, userId: string) => createHmac('sha256', k).update(`verified-user:${userId}`).digest('hex')

/** Signature for a verified user id ('' = verified as signed out). Null when no server key is configured. */
export function signVerifiedUser(userId: string): string | null {
  const k = key()
  return k ? mac(k, userId) : null
}

/**
 * What the proxy vouched for on this request:
 *   string    - the verified user id
 *   null      - verified as signed out
 *   undefined - nothing trustworthy: the caller must check the session itself
 */
export function readVerifiedUserId(h: { get(name: string): string | null }): string | null | undefined {
  const id = h.get(VERIFIED_USER_HEADER)
  const sig = h.get(VERIFIED_USER_SIG_HEADER)
  const k = key()
  if (id === null || sig === null || !k) return undefined
  const expected = Buffer.from(mac(k, id))
  const given = Buffer.from(sig)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  return id === '' ? null : id
}
```

- [ ] **Step 4: Run the checks**

Run: `npx vitest run tests/unit`
Expected: all unit tests pass.

Run: `npm run typecheck` and `npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: core libraries for secrets, rate limit, logging, error boundary, time and Supabase clients"
```

---

### Task 6: Sign-in, session proxy, forced password change

**Files:**
- Create: `proxy.ts`, `lib/auth/safe-next.ts`, `lib/auth/roles.ts`, `lib/auth/profile.ts`, `lib/validation/password.ts`, `app/auth/callback/route.ts`, `app/(auth)/login/page.tsx`, `app/(auth)/login/LoginForm.tsx`, `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx`, `app/(auth)/change-password/page.tsx`, `app/(app)/layout.tsx`, `app/(app)/home/page.tsx` (placeholder, completed in Task 10)
- Modify: `lib/actions/auth.ts` (replace the stub), `app/page.tsx`
- Test: `tests/unit/safe-next.test.ts`, `tests/unit/password.test.ts`

**Interfaces:**
- Produces: `safeNext(next, fallback?)`; `passwordSchema` (zod) and `PASSWORD_HELP`; `getCurrentProfile(): Promise<CurrentProfile | null>`; `requireProfile(): Promise<CurrentProfile>` (redirects to `/login`, or to `/change-password` when `must_reset_password`); `requireAdmin(): Promise<CurrentProfile>` (redirects to `/home` unless role is `admin` or `platform_owner`); Server Actions `signIn(prev, formData)`, `signOut()`, `forgotPassword(prev, formData)`, `changePassword(prev, formData)` where `prev`/return is `FormState = {error?: string; message?: string}`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/safe-next.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { safeNext } from '@/lib/auth/safe-next'

describe('safeNext', () => {
  it('keeps a same-site path', () => {
    expect(safeNext('/stores/abc?x=1')).toBe('/stores/abc?x=1')
  })
  it('refuses anything that could leave the site', () => {
    expect(safeNext('https://evil.test')).toBe('/home')
    expect(safeNext('//evil.test')).toBe('/home')
    expect(safeNext('/\\evil.test')).toBe('/home')
    expect(safeNext('javascript:alert(1)')).toBe('/home')
  })
  it('never loops back to the login page', () => {
    expect(safeNext('/login?next=/x')).toBe('/home')
  })
  it('uses the fallback for empty input', () => {
    expect(safeNext(null)).toBe('/home')
    expect(safeNext('', '/stores')).toBe('/stores')
  })
})
```

`tests/unit/password.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { passwordSchema } from '@/lib/validation/password'

describe('passwordSchema', () => {
  it('accepts a long password with a letter and a number', () => {
    expect(passwordSchema.safeParse('Orange42Tiger').success).toBe(true)
  })
  it('rejects short passwords', () => {
    const r = passwordSchema.safeParse('Ab1')
    expect(r.success).toBe(false)
  })
  it('rejects passwords without a number or without a letter', () => {
    expect(passwordSchema.safeParse('onlyletterslong').success).toBe(false)
    expect(passwordSchema.safeParse('1234567890123').success).toBe(false)
  })
  it('rejects very long passwords', () => {
    expect(passwordSchema.safeParse('a1'.repeat(40)).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/safe-next.test.ts tests/unit/password.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the pure helpers**

`lib/auth/safe-next.ts`:
```ts
// A "next" address after sign-in must be a path on this site. Anything else (another site, a protocol-relative address) is refused.
export function safeNext(next: string | null | undefined, fallback = '/home'): string {
  if (!next) return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) return fallback
  return next
}
```

`lib/validation/password.ts`:
```ts
import { z } from 'zod'

export const PASSWORD_HELP = 'Use at least 10 characters, with at least one letter and one number.'

export const passwordSchema = z
  .string()
  .min(10, PASSWORD_HELP)
  .max(72, 'Use 72 characters or fewer.')
  .regex(/[A-Za-z]/, PASSWORD_HELP)
  .regex(/[0-9]/, PASSWORD_HELP)
```

- [ ] **Step 4: Run the helper tests**

Run: `npx vitest run tests/unit/safe-next.test.ts tests/unit/password.test.ts`
Expected: all pass.

- [ ] **Step 5: Implement the proxy, profile helpers, actions and pages**

`proxy.ts`:
```ts
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { VERIFIED_USER_HEADER, VERIFIED_USER_SIG_HEADER, signVerifiedUser } from '@/lib/auth/verified-user'

// Public pages and routes are an exact-match list. Every other path needs a signed-in person.
const PUBLIC_PAGES = new Set(['/login', '/forgot-password'])
const PUBLIC_API = new Set(['/api/health', '/api/version'])

function stamp(headers: Headers, request: NextRequest) {
  headers.set('x-request-id', crypto.randomUUID())
  headers.set('x-request-path', request.nextUrl.pathname)
  headers.set('x-request-method', request.method)
}

// A client may send any copy of the verified-user headers; it is always removed here and only set again below, signed.
function cleanHeaders(request: NextRequest): Headers {
  const h = new Headers(request.headers)
  h.delete(VERIFIED_USER_HEADER)
  h.delete(VERIFIED_USER_SIG_HEADER)
  stamp(h, request)
  return h
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isAsset = pathname.startsWith('/_next') || pathname.startsWith('/favicon') || /^\/[A-Za-z0-9._-]+\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(pathname)
  if (isAsset || PUBLIC_API.has(pathname) || pathname.startsWith('/auth/callback')) {
    return NextResponse.next({ request: { headers: cleanHeaders(request) } })
  }

  const forwarded = cleanHeaders(request)
  const secure = (process.env.NEXT_PUBLIC_APP_URL ?? '').startsWith('https')
  let refreshed: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        refreshed = list
        list.forEach(({ name, value }) => request.cookies.set(name, value))
      },
    },
  })
  const { data: { user } } = await supabase.auth.getUser()

  if (!user && !PUBLIC_PAGES.has(pathname) && pathname !== '/reset-password') {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  const sig = signVerifiedUser(user?.id ?? '')
  if (sig) {
    forwarded.set(VERIFIED_USER_HEADER, user?.id ?? '')
    forwarded.set(VERIFIED_USER_SIG_HEADER, sig)
  }
  forwarded.set('cookie', request.cookies.toString())

  const response = NextResponse.next({ request: { headers: forwarded } })
  refreshed.forEach(({ name, value, options }) => response.cookies.set(name, value, secure ? { ...options, secure: true } : options))
  return response
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
```

`lib/auth/roles.ts`:
```ts
import type { Role } from '@/lib/nav'

// Pure, so services that run without Next.js can use it too.
export const isAdminRole = (role: Role) => role === 'admin' || role === 'platform_owner'
```

`lib/auth/profile.ts`:
```ts
import { cache } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readVerifiedUserId } from '@/lib/auth/verified-user'
import type { Role } from '@/lib/nav'
import { isAdminRole } from '@/lib/auth/roles'

export type CurrentProfile = {
  id: string
  org_id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  must_reset_password: boolean
  store_id: string | null
}

const COLUMNS = 'id, org_id, email, full_name, role, is_active, must_reset_password, store_id'

/** The signed-in person's profile, or null. Uses the id the proxy verified, and checks the session itself when there is none. */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const verified = readVerifiedUserId(await headers())
  const supabase = await createClient()
  let userId: string | null
  if (typeof verified === 'string') userId = verified
  else if (verified === null) return null
  else userId = (await supabase.auth.getUser()).data.user?.id ?? null
  if (!userId) return null
  const { data } = await supabase.from('profiles').select(COLUMNS).eq('id', userId).maybeSingle()
  return data && data.is_active ? (data as CurrentProfile) : null
})

/** For pages and actions that need a signed-in person who has already chosen their own password. */
export async function requireProfile(): Promise<CurrentProfile> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  if (profile.must_reset_password) redirect('/change-password')
  return profile
}

export async function requireAdmin(): Promise<CurrentProfile> {
  const profile = await requireProfile()
  if (!isAdminRole(profile.role)) redirect('/home')
  return profile
}
```

`lib/actions/auth.ts` (replace the stub):
```ts
'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getClientIp, isOverLimit, rateLimit, recordEvent } from '@/lib/rate-limit'
import { safeNext } from '@/lib/auth/safe-next'
import { passwordSchema } from '@/lib/validation/password'
import { sanitizeError } from '@/lib/observability/sanitize-error'

export type FormState = { error?: string; message?: string }

const FAIL_WINDOW_MS = 15 * 60_000

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter your e-mail address.')),
  password: z.string().min(1, 'Enter your password.'),
})

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const { email, password } = parsed.data

  const ip = (await getClientIp()) ?? 'noip'
  const key = `signin:${ip}:${email}`
  if (isOverLimit(key, 5)) return { error: 'Too many tries. Please wait 15 minutes and try again.' }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    recordEvent(key, FAIL_WINDOW_MS)
    return { error: 'Wrong e-mail or password.' }
  }
  redirect(safeNext(String(formData.get('next') ?? '')))
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

export async function forgotPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z.string().trim().toLowerCase().pipe(z.email()).safeParse(formData.get('email'))
  if (!parsed.success) return { error: 'Enter your e-mail address.' }
  const ip = (await getClientIp()) ?? 'noip'
  const { limited } = await rateLimit(`forgot:${ip}:${parsed.data}`, 3, 15 * 60_000)
  if (!limited) {
    const supabase = await createClient()
    const base = process.env.NEXT_PUBLIC_APP_URL ?? ''
    await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${base}/auth/callback?next=/reset-password` })
  }
  // The same answer whether or not the address exists, so nobody can find out who has an account.
  return { message: 'If that e-mail has an account, we have sent a link to choose a new password.' }
}

// Used by the forced change after first sign-in and by the reset link.
export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const parsed = passwordSchema.safeParse(formData.get('password'))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message }
  if (formData.get('password') !== formData.get('confirm')) return { error: 'The two passwords are not the same.' }

  const { error } = await supabase.auth.updateUser({ password: parsed.data })
  if (error) return { error: sanitizeError(error, { route: 'changePassword', fallback: 'Could not change the password. Please try again.' }) }

  // Only the server may clear the flag; it does so after the change succeeded.
  const admin = createAdminClient()
  const { error: flagError } = await admin.from('profiles').update({ must_reset_password: false }).eq('id', user.id)
  if (flagError) return { error: sanitizeError(flagError, { route: 'changePassword.flag' }) }
  redirect('/home')
}
```

`app/auth/callback/route.ts`:
```ts
import { NextResponse, type NextRequest } from 'next/server'
import { safeNext } from '@/lib/auth/safe-next'
import { createClient } from '@/lib/supabase/server'

// The link in the password-reset e-mail lands here with a one-time code, which is exchanged for a signed-in session.
export async function GET(request: NextRequest) {
  const base = process.env.NEXT_PUBLIC_APP_URL || request.url
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNext(request.nextUrl.searchParams.get('next'), '/home')
  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, base))
  }
  return NextResponse.redirect(new URL('/login?error=link', base))
}
```

`app/page.tsx` (replace):
```tsx
import { redirect } from 'next/navigation'

export default function Page() {
  redirect('/home')
}
```

`app/(auth)/login/LoginForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import { signIn, type FormState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {})
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
```

`app/(auth)/login/page.tsx`:
```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { safeNext } from '@/lib/auth/safe-next'
import { BRAND } from '@/lib/brand'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoginForm } from './LoginForm'

export const metadata = { title: 'Sign in' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams
  const next = safeNext(sp.next)
  // A person who is already signed in goes straight on. (The proxy does not do this, so a signed-in but deactivated person can still see the form.)
  if (await getCurrentProfile()) redirect(next)
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{BRAND.name}</CardTitle>
          <p className="text-sm text-muted-foreground">Sign in to continue.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {sp.error === 'link' && <p className="text-sm text-destructive">That link has expired. Ask for a new one.</p>}
          <LoginForm next={next} />
          <Link href="/forgot-password" className="block text-center text-sm text-muted-foreground underline">
            Forgot your password?
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
```

`app/(auth)/forgot-password/page.tsx`:
```tsx
'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { forgotPassword, type FormState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPassword, {})
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <p className="text-sm text-muted-foreground">Enter your e-mail and we will send you a link.</p>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
            {state.message && <p className="text-sm">{state.message}</p>}
            <Button type="submit" className="w-full" disabled={pending}>Send the link</Button>
            <Link href="/login" className="block text-center text-sm text-muted-foreground underline">Back to sign in</Link>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
```

`app/(auth)/change-password/ChangePasswordForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import { changePassword, type FormState } from '@/lib/actions/auth'
import { PASSWORD_HELP } from '@/lib/validation/password'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, {})
  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
        <p className="text-xs text-muted-foreground">{PASSWORD_HELP}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Type it again</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>Save password</Button>
    </form>
  )
}
```

`app/(auth)/change-password/page.tsx`:
```tsx
import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth/profile'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangePasswordForm } from './ChangePasswordForm'

export const metadata = { title: 'Choose a password' }

export default async function ChangePasswordPage() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose your own password</CardTitle>
          <p className="text-sm text-muted-foreground">
            {profile.must_reset_password ? 'You need to do this once before you can use the app.' : 'Choose a new password.'}
          </p>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </main>
  )
}
```

`app/(auth)/reset-password/page.tsx`:
```tsx
import { redirect } from 'next/navigation'

// The e-mailed link signs the person in through /auth/callback and sends them here; the password form is the same one.
export default function ResetPasswordPage() {
  redirect('/change-password')
}
```

`app/(app)/layout.tsx`:
```tsx
import { AppShell } from '@/components/layout/AppShell'
import { requireProfile } from '@/lib/auth/profile'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireProfile()
  return <AppShell profile={{ full_name: profile.full_name || profile.email, role: profile.role }}>{children}</AppShell>
}
```

`app/(app)/home/page.tsx` (placeholder):
```tsx
import { requireProfile } from '@/lib/auth/profile'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  return <h1 className="text-xl font-semibold">Welcome, {profile.full_name || profile.email}</h1>
}
```

- [ ] **Step 6: Run the checks**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`
Expected: all clean.

- [ ] **Step 7: Add the local dev admin script and check the sign-in flow by hand**

`scripts/create-dev-admin.mjs`:
```js
// Creates the local development administrator from DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD in .env.local. Local stack only.
import { createClient } from '@supabase/supabase-js'

process.loadEnvFile('.env.local')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const u = new URL(url ?? 'http://invalid.invalid')
if (!(['localhost', '127.0.0.1'].includes(u.hostname) && u.port === '55321')) {
  console.error('Refusing to run: this script only works against the local Supabase stack on port 55321.')
  process.exit(1)
}
const email = process.env.DEV_ADMIN_EMAIL
const password = process.env.DEV_ADMIN_PASSWORD
if (!email || !password) {
  console.error('Run npm run env:local first (it writes DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD).')
  process.exit(1)
}
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const { data: org } = await admin.from('organizations').select('id').eq('slug', 'citykart').single()
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (error || !data.user) {
  console.error('Could not create the user: ' + (error?.message ?? 'unknown error'))
  process.exit(1)
}
const { error: pErr } = await admin.from('profiles').insert({
  id: data.user.id, org_id: org.id, email, full_name: 'Dev Admin', role: 'platform_owner', must_reset_password: false,
})
if (pErr) {
  await admin.auth.admin.deleteUser(data.user.id)
  console.error('Could not create the profile: ' + pErr.message)
  process.exit(1)
}
console.log('Dev admin created. Its e-mail and password are in .env.local (DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD).')
```

Run: `node scripts/create-dev-admin.mjs`
Expected: `Dev admin created...` (run it once; a second run fails because the user exists).

Run: `npm run dev`, open http://localhost:3212 in the Browser pane. Confirm `/home` redirects to `/login`; sign in with the values from `.env.local` (read them from the file; do not print them in the chat); you land on `/home` and see the welcome text; sign out returns to `/login`. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: sign-in, session proxy and forced password change"
```

---

### Task 7: Inventory and access schema, visibility functions, Vault

**Files:**
- Create: `supabase/migrations/20261021000002_inventory_access.sql`, `supabase/rollback/20261021000002_inventory_access_rollback.sql`
- Modify: `tests/setup/fixtures.ts` (delete order and Vault cleanup), `types/database.ts` (regenerated)
- Test: `tests/integration/inventory-rls.test.ts`

**Interfaces:**
- Produces: enum `device_type`; tables `stores`, `cameras`, `devices`, `user_store_access`, `user_zone_access`, `user_camera_access`, `admin_audit_log`; functions `is_staff_all()`, `granted_store_ids()`, `visible_store_ids()`, `visible_camera_ids()`, `visible_device_ids()` (callable by `authenticated`); service-role-only RPCs `nvr_store_credential(p_store uuid, p_secret text) returns uuid`, `nvr_read_credential(p_store uuid) returns text`, `nvr_delete_credential(p_store uuid) returns void`, `replace_user_access(p_user uuid, p_stores uuid[], p_zones text[], p_cameras uuid[]) returns void` (raises a message containing `outside organisation` for a store or camera of another organisation).

- [ ] **Step 1: Update the fixtures**

In `tests/setup/fixtures.ts` replace the `ORG_TABLES_IN_DELETE_ORDER` constant and `cleanupOrg` with:
```ts
// Child tables first. Add new organisation-scoped tables here.
export const ORG_TABLES_IN_DELETE_ORDER: string[] = [
  'admin_audit_log',
  'user_camera_access',
  'user_zone_access',
  'user_store_access',
  'devices',
  'cameras',
  'stores',
]

export async function cleanupOrg(orgId: string): Promise<void> {
  const admin = adminClient()
  // Remove the NVR passwords from the vault before their stores disappear.
  const { data: stores } = await admin.from('stores').select('id').eq('org_id', orgId)
  for (const s of stores ?? []) await admin.rpc('nvr_delete_credential', { p_store: s.id })
  for (const table of ORG_TABLES_IN_DELETE_ORDER) {
    // @ts-expect-error -- table names here are plain strings on purpose
    await admin.from(table).delete().eq('org_id', orgId)
  }
  const { data: people } = await admin.from('profiles').select('id').eq('org_id', orgId)
  for (const p of people ?? []) await admin.auth.admin.deleteUser(p.id)
  await admin.from('profiles').delete().eq('org_id', orgId)
  await admin.from('organizations').delete().eq('id', orgId)
}
```

- [ ] **Step 2: Write the failing test**

`tests/integration/inventory-rls.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

type Table = 'stores' | 'cameras' | 'devices'

async function addStore(orgId: string, code: string, zone: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('stores')
    .insert({ org_id: orgId, code, name: `Store ${code}`, zone, nvr_ip: '127.0.0.1', nvr_username: 'viewer' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addStore: ${error?.message}`)
  return data.id
}

async function addCamera(orgId: string, storeId: string, channel: number): Promise<string> {
  const { data, error } = await adminClient()
    .from('cameras')
    .insert({ org_id: orgId, store_id: storeId, channel, name: `Camera ${channel}` })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addCamera: ${error?.message}`)
  return data.id
}

async function addDevice(orgId: string, storeId: string | null, type: 'server' | 'attendance', name: string): Promise<string> {
  const { data, error } = await adminClient()
    .from('devices')
    .insert({ org_id: orgId, store_id: storeId, type, name, ip: '127.0.0.1', tcp_port: 9 })
    .select('id')
    .single()
  if (error || !data) throw new Error(`addDevice: ${error?.message}`)
  return data.id
}

async function grant(userId: string, g: { stores?: string[]; zones?: string[]; cameras?: string[] }) {
  const { error } = await adminClient().rpc('replace_user_access', {
    p_user: userId,
    p_stores: g.stores ?? [],
    p_zones: g.zones ?? [],
    p_cameras: g.cameras ?? [],
  })
  if (error) throw new Error(`grant: ${error.message}`)
}

async function idsOf(user: TestUser, table: Table): Promise<string[]> {
  const { data, error } = await user.client.from(table).select('id')
  expect(error).toBeNull()
  return (data ?? []).map((r) => r.id).sort()
}

const sorted = (...a: string[]) => [...a].sort()

describe('inventory visibility (row-level security)', () => {
  let orgA: string
  let orgB: string
  let s1: string, s2: string, s3: string, sB: string
  let c11: string, c12: string, c21: string, c31: string, c32: string
  let d1: string, d3: string, d0: string
  let manager: TestUser, zoneUser: TestUser, storeUser: TestUser, camUser: TestUser, mixedUser: TestUser
  let zoneCamUser: TestUser, ownStoreUser: TestUser, nobody: TestUser, resetUser: TestUser, managerB: TestUser, admin: TestUser

  beforeAll(async () => {
    orgA = await createOrg()
    orgB = await createOrg()
    s1 = await addStore(orgA, 'S1', 'BR')
    s2 = await addStore(orgA, 'S2', 'BR')
    s3 = await addStore(orgA, 'S3', 'UP')
    sB = await addStore(orgB, 'SB', 'BR')
    c11 = await addCamera(orgA, s1, 1)
    c12 = await addCamera(orgA, s1, 2)
    c21 = await addCamera(orgA, s2, 1)
    c31 = await addCamera(orgA, s3, 1)
    c32 = await addCamera(orgA, s3, 2)
    await addCamera(orgB, sB, 1)
    d1 = await addDevice(orgA, s1, 'server', 'ERP')
    d3 = await addDevice(orgA, s3, 'attendance', 'Door')
    d0 = await addDevice(orgA, null, 'server', 'Head office')
    await addDevice(orgB, sB, 'server', 'Other org')

    manager = await createUser(orgA, 'manager')
    admin = await createUser(orgA, 'admin')
    zoneUser = await createUser(orgA, 'user')
    storeUser = await createUser(orgA, 'agent')
    camUser = await createUser(orgA, 'user')
    mixedUser = await createUser(orgA, 'user')
    zoneCamUser = await createUser(orgA, 'user')
    ownStoreUser = await createUser(orgA, 'user', { storeId: s1 })
    nobody = await createUser(orgA, 'user')
    resetUser = await createUser(orgA, 'user', { mustReset: true })
    managerB = await createUser(orgB, 'manager')

    await grant(zoneUser.id, { zones: ['BR'] })
    await grant(storeUser.id, { stores: [s3] })
    await grant(camUser.id, { cameras: [c11] })
    await grant(mixedUser.id, { stores: [s3], cameras: [c32] })
    await grant(zoneCamUser.id, { zones: ['BR'], cameras: [c12] })
    await grant(resetUser.id, { stores: [s1] })
  })

  afterAll(async () => {
    await cleanupOrg(orgA)
    await cleanupOrg(orgB)
  })

  it('a manager sees everything in their organisation and nothing of another', async () => {
    expect(await idsOf(manager, 'stores')).toEqual(sorted(s1, s2, s3))
    expect(await idsOf(manager, 'cameras')).toEqual(sorted(c11, c12, c21, c31, c32))
    expect(await idsOf(manager, 'devices')).toEqual(sorted(d1, d3, d0))
  })

  it('a zone grant gives every store and camera of that zone, and the devices of those stores', async () => {
    expect(await idsOf(zoneUser, 'stores')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneUser, 'cameras')).toEqual(sorted(c11, c12, c21))
    expect(await idsOf(zoneUser, 'devices')).toEqual(sorted(d1))
  })

  it('a store grant gives all cameras and devices of that store (also for an operator)', async () => {
    expect(await idsOf(storeUser, 'stores')).toEqual(sorted(s3))
    expect(await idsOf(storeUser, 'cameras')).toEqual(sorted(c31, c32))
    expect(await idsOf(storeUser, 'devices')).toEqual(sorted(d3))
  })

  it('a camera-only grant shows that camera and its store, but no devices', async () => {
    expect(await idsOf(camUser, 'stores')).toEqual(sorted(s1))
    expect(await idsOf(camUser, 'cameras')).toEqual(sorted(c11))
    expect(await idsOf(camUser, 'devices')).toEqual([])
  })

  it('camera grants inside a granted store limit the user to those cameras', async () => {
    expect(await idsOf(mixedUser, 'stores')).toEqual(sorted(s3))
    expect(await idsOf(mixedUser, 'cameras')).toEqual(sorted(c32))
    expect(await idsOf(mixedUser, 'devices')).toEqual(sorted(d3))
  })

  it('the limit applies per store: other stores of a zone grant stay fully visible', async () => {
    expect(await idsOf(zoneCamUser, 'stores')).toEqual(sorted(s1, s2))
    expect(await idsOf(zoneCamUser, 'cameras')).toEqual(sorted(c12, c21))
    expect(await idsOf(zoneCamUser, 'devices')).toEqual(sorted(d1))
  })

  it('a store login sees its own store without any grant', async () => {
    expect(await idsOf(ownStoreUser, 'stores')).toEqual(sorted(s1))
    expect(await idsOf(ownStoreUser, 'cameras')).toEqual(sorted(c11, c12))
    expect(await idsOf(ownStoreUser, 'devices')).toEqual(sorted(d1))
  })

  it('a user without grants sees nothing, and neither does one who must still choose a password', async () => {
    for (const u of [nobody, resetUser]) {
      expect(await idsOf(u, 'stores')).toEqual([])
      expect(await idsOf(u, 'cameras')).toEqual([])
      expect(await idsOf(u, 'devices')).toEqual([])
    }
  })

  it('another organisation sees only its own rows', async () => {
    expect(await idsOf(managerB, 'stores')).toEqual(sorted(sB))
    expect((await idsOf(managerB, 'cameras')).length).toBe(1)
  })

  it('nobody writes inventory through the data API', async () => {
    const insert = await manager.client.from('stores').insert({ org_id: orgA, code: 'X', name: 'X', nvr_ip: '127.0.0.1', nvr_username: 'u' })
    expect(insert.error?.code).toBe('42501')
    const update = await zoneUser.client.from('cameras').update({ name: 'changed' }).eq('id', c11)
    expect(update.error?.code).toBe('42501')
    const del = await manager.client.from('devices').delete().eq('id', d1)
    expect(del.error?.code).toBe('42501')
  })

  it('users read their own grants, admins read everyone’s, and the audit log is for admins only', async () => {
    const own = await zoneUser.client.from('user_zone_access').select('zone')
    expect(own.data).toEqual([{ zone: 'BR' }])
    const others = await admin.client.from('user_store_access').select('user_id')
    expect((others.data ?? []).length).toBe(3)
    await adminClient().from('admin_audit_log').insert({ org_id: orgA, actor_id: admin.id, action: 'test' })
    expect(((await admin.client.from('admin_audit_log').select('id')).data ?? []).length).toBe(1)
    expect((await zoneUser.client.from('admin_audit_log').select('id')).data).toEqual([])
  })

  it('refuses to grant a store or camera of another organisation', async () => {
    const { error } = await adminClient().rpc('replace_user_access', { p_user: nobody.id, p_stores: [sB], p_zones: [], p_cameras: [] })
    expect(error?.message).toContain('outside organisation')
  })

  it('NVR passwords live in the vault and only the server can read them', async () => {
    const admin = adminClient()
    const secret = `Nvr-${randomUUID()}`
    expect((await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: secret })).error).toBeNull()
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(secret)
    const row = await admin.from('stores').select('nvr_secret_id').eq('id', s1).single()
    expect(row.data?.nvr_secret_id).toBeTruthy()

    const denied = await manager.client.rpc('nvr_read_credential', { p_store: s1 })
    expect(denied.error?.code).toBe('42501')
    expect(denied.data).toBeNull()

    const changed = `Nvr-${randomUUID()}`
    await admin.rpc('nvr_store_credential', { p_store: s1, p_secret: changed })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBe(changed)

    await admin.rpc('nvr_delete_credential', { p_store: s1 })
    expect((await admin.rpc('nvr_read_credential', { p_store: s1 })).data).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run tests/integration/inventory-rls.test.ts`
Expected: FAIL (the tables and functions do not exist yet).

- [ ] **Step 4: Write the migration and its rollback**

`supabase/migrations/20261021000002_inventory_access.sql`:
```sql
-- Inventory (stores, cameras, devices), access grants, visibility functions, NVR credentials in Vault, admin audit log.
-- Rollback: supabase/rollback/20261021000002_inventory_access_rollback.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

CREATE TYPE public.device_type AS ENUM ('nvr', 'server', 'attendance', 'footfall', 'other');

CREATE TABLE public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  code text NOT NULL,
  name text NOT NULL,
  city text,
  zone text,
  state text,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  nvr_ip text NOT NULL,
  rtsp_port integer NOT NULL DEFAULT 554 CHECK (rtsp_port BETWEEN 1 AND 65535),
  http_port integer NOT NULL DEFAULT 80 CHECK (http_port BETWEEN 1 AND 65535),
  nvr_username text NOT NULL,
  nvr_secret_id uuid,  -- the NVR password lives in Vault, never in this table
  expected_channels integer NOT NULL DEFAULT 0 CHECK (expected_channels >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_org_code_key UNIQUE (org_id, code),
  CONSTRAINT stores_code_upper CHECK (code = upper(code))
);
CREATE INDEX stores_org_zone_idx ON public.stores (org_id, zone);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_store_fk FOREIGN KEY (store_id) REFERENCES public.stores (id) ON DELETE SET NULL;

CREATE TABLE public.cameras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  store_id uuid NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  channel integer NOT NULL CHECK (channel > 0),
  name text NOT NULL,
  camera_ip text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cameras_store_channel_key UNIQUE (store_id, channel)
);
CREATE INDEX cameras_org_idx ON public.cameras (org_id);

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  type public.device_type NOT NULL,
  name text NOT NULL,
  ip text NOT NULL,
  tcp_port integer CHECK (tcp_port BETWEEN 1 AND 65535),
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_org_idx ON public.devices (org_id);
CREATE INDEX devices_store_idx ON public.devices (store_id);

CREATE TABLE public.user_store_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);
CREATE TABLE public.user_zone_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  zone text NOT NULL,
  PRIMARY KEY (user_id, zone)
);
CREATE TABLE public.user_camera_access (
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES public.cameras (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, camera_id)
);

CREATE TABLE public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id),
  actor_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_org_idx ON public.admin_audit_log (org_id, created_at DESC);

CREATE TRIGGER stores_updated BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER cameras_updated BEFORE UPDATE ON public.cameras FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER devices_updated BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Visibility rules ─────────────────────────────────────────────────────────
-- Staff who see everything (read-only for managers; admins and owners also write, but only through the server).
CREATE OR REPLACE FUNCTION public.is_staff_all() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.current_user_role() IN ('manager', 'admin', 'platform_owner'), false)
$$;

-- Stores the caller may see because of a store grant, a zone grant or their own store login.
CREATE OR REPLACE FUNCTION public.granted_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id FROM stores s
  WHERE s.org_id = public.current_org_id()
    AND (
      s.id IN (SELECT store_id FROM user_store_access WHERE user_id = auth.uid())
      OR s.zone IN (SELECT zone FROM user_zone_access WHERE user_id = auth.uid())
      OR s.id = (SELECT store_id FROM profiles WHERE id = auth.uid())
    )
$$;

CREATE OR REPLACE FUNCTION public.visible_store_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id FROM stores s WHERE s.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT public.granted_store_ids()
  UNION
  SELECT c.store_id FROM cameras c
  JOIN user_camera_access a ON a.camera_id = c.id
  WHERE a.user_id = auth.uid() AND c.org_id = public.current_org_id()
$$;

CREATE OR REPLACE FUNCTION public.visible_camera_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id FROM cameras c WHERE c.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT a.camera_id FROM user_camera_access a JOIN cameras c ON c.id = a.camera_id
  WHERE a.user_id = auth.uid() AND c.org_id = public.current_org_id()
  UNION
  -- Cameras of granted stores, except in a store where the caller has individual camera grants (then only those).
  SELECT c.id FROM cameras c
  WHERE c.org_id = public.current_org_id()
    AND c.store_id IN (SELECT public.granted_store_ids())
    AND c.store_id NOT IN (
      SELECT c2.store_id FROM cameras c2 JOIN user_camera_access a ON a.camera_id = c2.id WHERE a.user_id = auth.uid()
    )
$$;

CREATE OR REPLACE FUNCTION public.visible_device_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id FROM devices d WHERE d.org_id = public.current_org_id() AND public.is_staff_all()
  UNION
  SELECT d.id FROM devices d WHERE d.org_id = public.current_org_id() AND d.store_id IN (SELECT public.granted_store_ids())
$$;

REVOKE EXECUTE ON FUNCTION public.is_staff_all(), public.granted_store_ids(), public.visible_store_ids(),
  public.visible_camera_ids(), public.visible_device_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff_all(), public.granted_store_ids(), public.visible_store_ids(),
  public.visible_camera_ids(), public.visible_device_ids() TO authenticated, service_role;

-- ── Row-level security ───────────────────────────────────────────────────────
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_store_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_zone_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_camera_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- The visible_* functions are called through (SELECT ...) so they run once per query, not once per row.
CREATE POLICY stores_select ON public.stores FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_store_ids()));
CREATE POLICY cameras_select ON public.cameras FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_camera_ids()));
CREATE POLICY devices_select ON public.devices FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND id IN (SELECT public.visible_device_ids()));

CREATE POLICY user_store_access_select ON public.user_store_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY user_zone_access_select ON public.user_zone_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY user_camera_access_select ON public.user_camera_access FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (user_id = auth.uid() OR (SELECT public.current_user_role()) IN ('admin', 'platform_owner')));
CREATE POLICY admin_audit_log_select ON public.admin_audit_log FOR SELECT TO authenticated
  USING (org_id = (SELECT public.current_org_id()) AND (SELECT public.current_user_role()) IN ('admin', 'platform_owner'));

-- Signed-in users can only read. Every write goes through the server with the service role.
REVOKE ALL ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log TO authenticated;
GRANT ALL ON public.stores, public.cameras, public.devices, public.user_store_access, public.user_zone_access,
  public.user_camera_access, public.admin_audit_log TO service_role;

-- ── Server-only helpers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.nvr_store_credential(p_store uuid, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_existing uuid;
  v_id uuid;
BEGIN
  SELECT nvr_secret_id INTO v_existing FROM stores WHERE id = p_store;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown store'; END IF;
  IF v_existing IS NULL THEN
    v_id := vault.create_secret(p_secret, 'nvr:' || p_store::text, 'NVR login for a store');
    UPDATE stores SET nvr_secret_id = v_id WHERE id = p_store;
  ELSE
    PERFORM vault.update_secret(v_existing, p_secret);
    v_id := v_existing;
  END IF;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.nvr_read_credential(p_store uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds
  WHERE ds.id = (SELECT nvr_secret_id FROM public.stores WHERE id = p_store)
$$;

CREATE OR REPLACE FUNCTION public.nvr_delete_credential(p_store uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_secret uuid;
BEGIN
  SELECT nvr_secret_id INTO v_secret FROM stores WHERE id = p_store;
  IF v_secret IS NOT NULL THEN
    UPDATE stores SET nvr_secret_id = NULL WHERE id = p_store;
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
END
$$;

-- Replaces all of one person's grants in one step. Refuses stores and cameras of another organisation.
CREATE OR REPLACE FUNCTION public.replace_user_access(p_user uuid, p_stores uuid[], p_zones text[], p_cameras uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM profiles WHERE id = p_user;
  IF v_org IS NULL THEN RAISE EXCEPTION 'unknown user'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_stores) AS s(id) WHERE NOT EXISTS (SELECT 1 FROM stores WHERE stores.id = s.id AND org_id = v_org)) THEN
    RAISE EXCEPTION 'store outside organisation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_cameras) AS c(id) WHERE NOT EXISTS (SELECT 1 FROM cameras WHERE cameras.id = c.id AND org_id = v_org)) THEN
    RAISE EXCEPTION 'camera outside organisation';
  END IF;
  DELETE FROM user_store_access WHERE user_id = p_user;
  DELETE FROM user_zone_access WHERE user_id = p_user;
  DELETE FROM user_camera_access WHERE user_id = p_user;
  INSERT INTO user_store_access (org_id, user_id, store_id) SELECT DISTINCT v_org, p_user, s.id FROM unnest(p_stores) AS s(id);
  INSERT INTO user_zone_access (org_id, user_id, zone) SELECT DISTINCT v_org, p_user, z.zone FROM unnest(p_zones) AS z(zone);
  INSERT INTO user_camera_access (org_id, user_id, camera_id) SELECT DISTINCT v_org, p_user, c.id FROM unnest(p_cameras) AS c(id);
END
$$;

REVOKE EXECUTE ON FUNCTION public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.replace_user_access(uuid, uuid[], text[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nvr_store_credential(uuid, text), public.nvr_read_credential(uuid),
  public.nvr_delete_credential(uuid), public.replace_user_access(uuid, uuid[], text[], uuid[]) TO service_role;

COMMIT;
```

`supabase/rollback/20261021000002_inventory_access_rollback.sql`:
```sql
BEGIN;
DROP FUNCTION IF EXISTS public.replace_user_access(uuid, uuid[], text[], uuid[]);
DROP FUNCTION IF EXISTS public.nvr_delete_credential(uuid);
DROP FUNCTION IF EXISTS public.nvr_read_credential(uuid);
DROP FUNCTION IF EXISTS public.nvr_store_credential(uuid, text);
DROP TABLE IF EXISTS public.admin_audit_log, public.user_camera_access, public.user_zone_access, public.user_store_access,
  public.devices, public.cameras;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_store_fk;
DROP TABLE IF EXISTS public.stores;
DROP FUNCTION IF EXISTS public.visible_device_ids();
DROP FUNCTION IF EXISTS public.visible_camera_ids();
DROP FUNCTION IF EXISTS public.visible_store_ids();
DROP FUNCTION IF EXISTS public.granted_store_ids();
DROP FUNCTION IF EXISTS public.is_staff_all();
DROP TYPE IF EXISTS public.device_type;
COMMIT;
```

- [ ] **Step 5: Apply, regenerate types, run the tests**

Run: `npm run db:reset`
Expected: both migrations and the seed apply without errors.

Run: `npm run db:types`
Expected: `types/database.ts` now includes `stores`, `cameras`, `devices`, the access tables, `device_type` and the RPCs.

Run: `npx vitest run tests/integration`
Expected: identity and inventory suites pass (`5` and `12` tests).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: inventory and access schema with database-enforced visibility and Vault credentials"
```

---

### Task 8: User administration (create, change, reset, deactivate, grant access)

**Files:**
- Create: `lib/admin/roles.ts`, `lib/admin/audit.ts`, `lib/admin/users.ts`, `lib/security/org-scope.ts`, `lib/supabase/fetch-all.ts`, `lib/actions/admin/users.ts`, `components/admin/{CreateUserForm,UserRow,AccessEditor}.tsx`, `app/(app)/admin/users/page.tsx`, `app/(app)/admin/users/[id]/access/page.tsx`
- Test: `tests/unit/roles.test.ts`, `tests/unit/one-time-password.test.ts`, `tests/unit/fetch-all.test.ts`, `tests/integration/users-admin.test.ts`

**Interfaces:**
- Consumes: `createAdminClient()`, `requireAdmin()`, `sanitizeError`, RPC `replace_user_access`.
- Produces: `canManageRole(actorRole, targetRole): boolean`, `ROLES`; `addAudit(admin, entry)`; `assertRefsInOrg(admin, orgId, refs)`; `fetchAll(build)`; and in `lib/admin/users.ts`: `type Actor = {id; orgId; role}`, `type Result<T> = ({ok: true} & T) | {ok: false; error: string}`, `generateOneTimePassword(): string`, `createUser(admin, actor, input)` → `Result<{userId; oneTimePassword}>`, `updateUser(admin, actor, userId, patch)` → `Result<{}>`, `resetUserPassword(admin, actor, userId)` → `Result<{oneTimePassword}>`, `setUserAccess(admin, actor, userId, input)` → `Result<{}>`, `listUsers(admin, orgId)`, `getUserAccess(admin, orgId, userId)`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/roles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canManageRole } from '@/lib/admin/roles'

describe('canManageRole', () => {
  it('a platform owner may manage every role', () => {
    for (const r of ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const) expect(canManageRole('platform_owner', r)).toBe(true)
  })
  it('an admin may manage viewers, operators and managers only', () => {
    expect(canManageRole('admin', 'user')).toBe(true)
    expect(canManageRole('admin', 'agent')).toBe(true)
    expect(canManageRole('admin', 'manager')).toBe(true)
    expect(canManageRole('admin', 'admin')).toBe(false)
    expect(canManageRole('admin', 'platform_owner')).toBe(false)
  })
  it('nobody else may manage anyone', () => {
    for (const a of ['user', 'agent', 'manager'] as const) expect(canManageRole(a, 'user')).toBe(false)
  })
})
```

`tests/unit/one-time-password.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { generateOneTimePassword } from '@/lib/admin/users'
import { passwordSchema } from '@/lib/validation/password'

describe('generateOneTimePassword', () => {
  it('has the requested length and mixes letters and digits', () => {
    const p = generateOneTimePassword()
    expect(p).toHaveLength(14)
    expect(p).toMatch(/[A-Z]/)
    expect(p).toMatch(/[a-z]/)
    expect(p).toMatch(/[0-9]/)
  })
  it('never uses look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(generateOneTimePassword()).not.toMatch(/[0O1lI]/)
  })
  it('is different every time and satisfies the password rule', () => {
    const a = generateOneTimePassword()
    const b = generateOneTimePassword()
    expect(a).not.toBe(b)
    expect(passwordSchema.safeParse(a).success).toBe(true)
  })
})
```

`tests/unit/fetch-all.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { fetchAll } from '@/lib/supabase/fetch-all'

describe('fetchAll', () => {
  it('reads every page until a short page comes back', async () => {
    const all = Array.from({ length: 2300 }, (_, i) => i)
    const calls: [number, number][] = []
    const out = await fetchAll<number>(async (from, to) => {
      calls.push([from, to])
      return { data: all.slice(from, to + 1), error: null }
    })
    expect(out).toEqual(all)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('throws when a page fails', async () => {
    await expect(fetchAll<number>(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/roles.test.ts tests/unit/one-time-password.test.ts tests/unit/fetch-all.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the pure helpers**

`lib/admin/roles.ts`:
```ts
export const ROLES = ['user', 'agent', 'manager', 'admin', 'platform_owner'] as const
export type Role = (typeof ROLES)[number]

// A platform owner manages everyone; a plain admin manages viewers, operators and managers; nobody else manages anyone.
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'platform_owner') return true
  if (actorRole === 'admin') return targetRole === 'user' || targetRole === 'agent' || targetRole === 'manager'
  return false
}

// Roles that already see every store, camera and device, so an access list means nothing for them.
export const SEES_EVERYTHING: readonly Role[] = ['manager', 'admin', 'platform_owner']
```

`lib/supabase/fetch-all.ts`:
```ts
// PostgREST returns at most 1000 rows per request. This reads page after page until a short page comes back.
export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw new Error('Could not read all rows.')
    const page = data ?? []
    out.push(...page)
    if (page.length < pageSize) return out
  }
}
```

`lib/admin/audit.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { Json } from '@/types/database'
import { logger } from '@/lib/observability/logger'

export type AuditEntry = {
  orgId: string
  actorId: string
  action: string
  entityType?: string
  entityId?: string
  detail?: Json
}

/** Records who did what. A failure to write the record never breaks the action itself; it is logged instead. */
export async function addAudit(admin: SupabaseClient<Database>, e: AuditEntry): Promise<void> {
  const { error } = await admin.from('admin_audit_log').insert({
    org_id: e.orgId,
    actor_id: e.actorId,
    action: e.action,
    entity_type: e.entityType ?? null,
    entity_id: e.entityId ?? null,
    detail: e.detail ?? {},
  })
  if (error) logger.error({ event: 'audit_write_failed', action: e.action, error })
}
```

`lib/security/org-scope.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

type Ref = { table: 'stores' | 'cameras' | 'devices' | 'profiles'; ids: string[] }

/**
 * Before the server (which bypasses row-level security) writes a foreign key, prove every referenced row belongs to the
 * caller's organisation. Throws when one does not.
 */
export async function assertRefsInOrg(admin: SupabaseClient<Database>, orgId: string, refs: Ref[]): Promise<void> {
  for (const { table, ids } of refs) {
    const unique = [...new Set(ids)]
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (admin.from(table) as any).select('id').eq('org_id', orgId).in('id', chunk)
      if (error) throw new Error('Could not check references.')
      if ((data?.length ?? 0) !== chunk.length) throw new Error('A referenced record is outside this organisation.')
    }
  }
}
```

- [ ] **Step 4: Write the user service**

`lib/admin/users.ts`:
```ts
import { randomInt } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import { addAudit } from '@/lib/admin/audit'
import { canManageRole, ROLES, SEES_EVERYTHING, type Role } from '@/lib/admin/roles'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { assertRefsInOrg } from '@/lib/security/org-scope'
import { fetchAll } from '@/lib/supabase/fetch-all'

export type AdminClient = SupabaseClient<Database>
export type Actor = { id: string; orgId: string; role: Role }
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string }

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGIT = '23456789'

/** A random one-time password with no look-alike characters. Shown once to the administrator; the person must replace it at first sign-in. */
export function generateOneTimePassword(length = 14): string {
  const pick = (s: string) => s[randomInt(s.length)]
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)]
  const all = UPPER + LOWER + DIGIT
  while (chars.length < length) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid e-mail address.')),
  full_name: z.string().trim().min(1, 'Enter the person’s name.').max(100, 'Use 100 characters or fewer for the name.'),
  role: z.enum(ROLES),
  store_id: z.uuid().nullable().optional(),
})

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ROLES).optional(),
  is_active: z.boolean().optional(),
  store_id: z.uuid().nullable().optional(),
})

export const accessSchema = z.object({
  storeIds: z.array(z.uuid()).max(2000),
  zones: z.array(z.string().trim().min(1).max(100)).max(200),
  cameraIds: z.array(z.uuid()).max(10000),
})

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the form and try again.'

async function loadTarget(admin: AdminClient, actor: Actor, userId: string) {
  const { data } = await admin.from('profiles').select('id, role, is_active, org_id').eq('id', userId).eq('org_id', actor.orgId).maybeSingle()
  return data
}

export async function createUser(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ userId: string; oneTimePassword: string }>> {
  const parsed = createUserSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const v = parsed.data
  if (!canManageRole(actor.role, v.role)) return { ok: false, error: 'You are not allowed to create a user with that role.' }
  if (v.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [v.store_id] }])
    } catch {
      return { ok: false, error: 'That store was not found.' }
    }
  }
  const oneTimePassword = generateOneTimePassword()
  const created = await admin.auth.admin.createUser({ email: v.email, password: oneTimePassword, email_confirm: true })
  if (created.error || !created.data.user) {
    return { ok: false, error: sanitizeError(created.error, { route: 'createUser', fallback: 'Could not create the user. The e-mail may already be in use.' }) }
  }
  const userId = created.data.user.id
  const { error } = await admin.from('profiles').insert({
    id: userId,
    org_id: actor.orgId,
    email: v.email,
    full_name: v.full_name,
    role: v.role,
    must_reset_password: true,
    store_id: v.store_id ?? null,
  })
  if (error) {
    await admin.auth.admin.deleteUser(userId)
    return { ok: false, error: sanitizeError(error, { route: 'createUser.profile', fallback: 'Could not create the user.' }) }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_created', entityType: 'profile', entityId: userId, detail: { role: v.role } })
  return { ok: true, userId, oneTimePassword }
}

export async function updateUser(admin: AdminClient, actor: Actor, userId: string, input: unknown): Promise<Result<object>> {
  const parsed = updateUserSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const patch = parsed.data
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  // Nobody changes their own role or status: that also means the last administrator can never lock everyone out.
  if (target.id === actor.id && (patch.role !== undefined || patch.is_active !== undefined)) {
    return { ok: false, error: 'You cannot change your own role or status.' }
  }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  if (patch.role && !canManageRole(actor.role, patch.role)) return { ok: false, error: 'You are not allowed to give that role.' }
  if (patch.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [patch.store_id] }])
    } catch {
      return { ok: false, error: 'That store was not found.' }
    }
  }
  const { error } = await admin.from('profiles').update(patch).eq('id', userId).eq('org_id', actor.orgId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateUser', fallback: 'Could not save the changes.' }) }
  if (patch.is_active !== undefined) {
    // Deactivating also stops new sign-ins; reactivating lifts that.
    await admin.auth.admin.updateUserById(userId, { ban_duration: patch.is_active ? 'none' : '876000h' })
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_updated', entityType: 'profile', entityId: userId, detail: patch })
  return { ok: true }
}

export async function resetUserPassword(admin: AdminClient, actor: Actor, userId: string): Promise<Result<{ oneTimePassword: string }>> {
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  if (target.id === actor.id) return { ok: false, error: 'Use “Choose a new password” to change your own password.' }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  const oneTimePassword = generateOneTimePassword()
  const res = await admin.auth.admin.updateUserById(userId, { password: oneTimePassword })
  if (res.error) return { ok: false, error: sanitizeError(res.error, { route: 'resetUserPassword', fallback: 'Could not reset the password.' }) }
  const { error } = await admin.from('profiles').update({ must_reset_password: true }).eq('id', userId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'resetUserPassword.flag' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'user_password_reset', entityType: 'profile', entityId: userId })
  return { ok: true, oneTimePassword }
}

export async function setUserAccess(admin: AdminClient, actor: Actor, userId: string, input: unknown): Promise<Result<object>> {
  const parsed = accessSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  const target = await loadTarget(admin, actor, userId)
  if (!target) return { ok: false, error: 'User not found.' }
  if (!canManageRole(actor.role, target.role)) return { ok: false, error: 'You are not allowed to change this user.' }
  if (SEES_EVERYTHING.includes(target.role)) return { ok: false, error: 'This role already sees everything, so it needs no access list.' }
  const a = parsed.data
  const { error } = await admin.rpc('replace_user_access', { p_user: userId, p_stores: a.storeIds, p_zones: a.zones, p_cameras: a.cameraIds })
  if (error) {
    const msg = error.message.includes('outside organisation') ? 'One of the stores or cameras was not found.' : sanitizeError(error, { route: 'setUserAccess', fallback: 'Could not save the access list.' })
    return { ok: false, error: msg }
  }
  await addAudit(admin, {
    orgId: actor.orgId, actorId: actor.id, action: 'user_access_set', entityType: 'profile', entityId: userId,
    detail: { stores: a.storeIds.length, zones: a.zones.length, cameras: a.cameraIds.length },
  })
  return { ok: true }
}

export async function listUsers(admin: AdminClient, orgId: string) {
  return fetchAll((from, to) =>
    admin.from('profiles').select('id, email, full_name, role, is_active, must_reset_password, store_id, created_at').eq('org_id', orgId).order('full_name').range(from, to),
  )
}

export async function getUserAccess(admin: AdminClient, orgId: string, userId: string) {
  const [stores, zones, cameras] = await Promise.all([
    admin.from('user_store_access').select('store_id').eq('org_id', orgId).eq('user_id', userId),
    admin.from('user_zone_access').select('zone').eq('org_id', orgId).eq('user_id', userId),
    fetchAll((from, to) => admin.from('user_camera_access').select('camera_id').eq('org_id', orgId).eq('user_id', userId).range(from, to)),
  ])
  return {
    storeIds: (stores.data ?? []).map((r) => r.store_id),
    zones: (zones.data ?? []).map((r) => r.zone),
    cameraIds: cameras.map((r) => r.camera_id),
  }
}
```

- [ ] **Step 5: Write the failing integration test**

`tests/integration/users-admin.test.ts`:
```ts
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUser, getUserAccess, resetUserPassword, setUserAccess, updateUser, type Actor } from '@/lib/admin/users'
import { adminClient, cleanupOrg, createOrg, createUser as makeUser } from '../setup/fixtures'

const admin = () => adminClient()

async function signIn(email: string, password: string) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } })
  const { error } = await c.auth.signInWithPassword({ email, password })
  return { client: c, error }
}

describe('user administration', () => {
  let orgId: string
  let owner: Actor
  let plainAdmin: Actor
  let storeId: string
  let cameraIds: string[]

  beforeAll(async () => {
    orgId = await createOrg()
    const o = await makeUser(orgId, 'platform_owner')
    const a = await makeUser(orgId, 'admin')
    owner = { id: o.id, orgId, role: 'platform_owner' }
    plainAdmin = { id: a.id, orgId, role: 'admin' }
    const { data: s } = await admin().from('stores').insert({ org_id: orgId, code: 'U1', name: 'Store U1', zone: 'BR', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    storeId = s!.id
    const { data: cams } = await admin().from('cameras').insert([1, 2, 3].map((n) => ({ org_id: orgId, store_id: storeId, channel: n, name: `C${n}` }))).select('id')
    cameraIds = cams!.map((c) => c.id)
  })

  afterAll(() => cleanupOrg(orgId))

  it('creates a user who can sign in with the one-time password but must choose their own first', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const res = await createUser(admin(), plainAdmin, { email, full_name: 'New Viewer', role: 'user' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { client, error } = await signIn(email, res.oneTimePassword)
    expect(error).toBeNull()
    const org = await client.from('organizations').select('id')
    expect(org.data).toEqual([])
    const profile = await admin().from('profiles').select('must_reset_password, role').eq('id', res.userId).single()
    expect(profile.data).toEqual({ must_reset_password: true, role: 'user' })
  })

  it('refuses a duplicate e-mail and bad input', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })).ok).toBe(true)
    const dup = await createUser(admin(), plainAdmin, { email, full_name: 'A', role: 'user' })
    expect(dup.ok).toBe(false)
    const bad = await createUser(admin(), plainAdmin, { email: 'nope', full_name: '', role: 'user' })
    expect(bad.ok).toBe(false)
  })

  it('a plain admin cannot create administrators, a platform owner can', async () => {
    const email = () => `${crypto.randomUUID()}@example.test`
    expect((await createUser(admin(), plainAdmin, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(false)
    expect((await createUser(admin(), owner, { email: email(), full_name: 'X', role: 'admin' })).ok).toBe(true)
  })

  it('a viewer cannot administer anyone', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createUser(admin(), viewer, { email: `${crypto.randomUUID()}@example.test`, full_name: 'X', role: 'user' })).ok).toBe(false)
  })

  it('changes a role, forbids changing oneself, and deactivation blocks sign-in until reactivated', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Change Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    expect((await updateUser(admin(), plainAdmin, made.userId, { role: 'agent' })).ok).toBe(true)
    expect((await updateUser(admin(), plainAdmin, plainAdmin.id, { role: 'user' })).ok).toBe(false)
    expect((await updateUser(admin(), plainAdmin, owner.id, { is_active: false })).ok).toBe(false)

    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: false })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await updateUser(admin(), plainAdmin, made.userId, { is_active: true })).ok).toBe(true)
    expect((await signIn(email, made.oneTimePassword)).error).toBeNull()
  })

  it('resets a password: the new one works, the old one does not, and the person must choose again', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Reset Me', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)
    const reset = await resetUserPassword(admin(), plainAdmin, made.userId)
    if (!reset.ok) throw new Error('reset failed')
    expect((await signIn(email, made.oneTimePassword)).error).not.toBeNull()
    expect((await signIn(email, reset.oneTimePassword)).error).toBeNull()
    const p = await admin().from('profiles').select('must_reset_password').eq('id', made.userId).single()
    expect(p.data?.must_reset_password).toBe(true)
  })

  it('saves an access list that the person then sees through row-level security', async () => {
    const email = `${crypto.randomUUID()}@example.test`
    const made = await createUser(admin(), plainAdmin, { email, full_name: 'Gets Access', role: 'user' })
    if (!made.ok) throw new Error('setup failed')
    await admin().from('profiles').update({ must_reset_password: false }).eq('id', made.userId)

    expect((await setUserAccess(admin(), plainAdmin, made.userId, { storeIds: [], zones: [], cameraIds: [cameraIds[0], cameraIds[1]] })).ok).toBe(true)
    const { client } = await signIn(email, made.oneTimePassword)
    const seen = await client.from('cameras').select('id')
    expect((seen.data ?? []).map((r) => r.id).sort()).toEqual([cameraIds[0], cameraIds[1]].sort())
    expect(await getUserAccess(admin(), orgId, made.userId)).toEqual({ storeIds: [], zones: [], cameraIds: expect.arrayContaining([cameraIds[0], cameraIds[1]]) })

    expect((await setUserAccess(admin(), plainAdmin, made.userId, { storeIds: [storeId], zones: [], cameraIds: [] })).ok).toBe(true)
    const all = await client.from('cameras').select('id')
    expect((all.data ?? []).length).toBe(3)
  })

  it('refuses an access list for a role that sees everything, and for stores of another organisation', async () => {
    const manager = await makeUser(orgId, 'manager')
    expect((await setUserAccess(admin(), plainAdmin, manager.id, { storeIds: [storeId], zones: [], cameraIds: [] })).ok).toBe(false)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('stores').insert({ org_id: otherOrg, code: 'O1', name: 'Other', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    const viewer = await makeUser(orgId, 'user')
    const res = await setUserAccess(admin(), plainAdmin, viewer.id, { storeIds: [other!.id], zones: [], cameraIds: [] })
    expect(res.ok).toBe(false)
    await cleanupOrg(otherOrg)
  })

  it('writes an audit record for each change', async () => {
    const { data } = await admin().from('admin_audit_log').select('action').eq('org_id', orgId)
    const actions = new Set((data ?? []).map((r) => r.action))
    expect(actions).toContain('user_created')
    expect(actions).toContain('user_updated')
    expect(actions).toContain('user_password_reset')
    expect(actions).toContain('user_access_set')
  })
})
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit tests/integration/users-admin.test.ts`
Expected: all pass. If `signIn` after deactivation unexpectedly succeeds, check that `ban_duration` was applied in `updateUser` (`'876000h'`).

- [ ] **Step 7: Server Actions and pages**

`lib/actions/admin/users.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createUser, resetUserPassword, setUserAccess, updateUser } from '@/lib/admin/users'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'

export type CreateUserState = { error?: string; created?: { email: string; oneTimePassword: string } }
export type PasswordState = { error?: string; oneTimePassword?: string }
export type SimpleState = { error?: string; ok?: boolean }

async function ctx() {
  const p = await requireAdmin()
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}

export async function createUserAction(_prev: CreateUserState, formData: FormData): Promise<CreateUserState> {
  const { admin, actor } = await ctx()
  const email = String(formData.get('email') ?? '')
  const res = await createUser(admin, actor, {
    email,
    full_name: String(formData.get('full_name') ?? ''),
    role: String(formData.get('role') ?? 'user'),
    store_id: String(formData.get('store_id') ?? '') || null,
  })
  revalidatePath('/admin/users')
  return res.ok ? { created: { email, oneTimePassword: res.oneTimePassword } } : { error: res.error }
}

export async function setActiveAction(userId: string, isActive: boolean): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  const res = await updateUser(admin, actor, userId, { is_active: isActive })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function setRoleAction(userId: string, role: string): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  const res = await updateUser(admin, actor, userId, { role })
  revalidatePath('/admin/users')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function resetPasswordAction(userId: string): Promise<PasswordState> {
  const { admin, actor } = await ctx()
  const res = await resetUserPassword(admin, actor, userId)
  revalidatePath('/admin/users')
  return res.ok ? { oneTimePassword: res.oneTimePassword } : { error: res.error }
}

export async function saveAccessAction(userId: string, input: { storeIds: string[]; zones: string[]; cameraIds: string[] }): Promise<SimpleState> {
  const { admin, actor } = await ctx()
  const res = await setUserAccess(admin, actor, userId, input)
  revalidatePath(`/admin/users/${userId}/access`)
  return res.ok ? { ok: true } : { error: res.error }
}
```

`components/admin/CreateUserForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import { createUserAction, type CreateUserState } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ROLE_LABELS: Record<string, string> = {
  user: 'Viewer (sees only what is granted)',
  agent: 'Operator (viewer who can also start checks)',
  manager: 'Manager (sees everything, read-only)',
  admin: 'Administrator',
  platform_owner: 'Platform owner',
}

export function CreateUserForm({ allowedRoles, stores }: { allowedRoles: string[]; stores: { id: string; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUserAction, {})
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a person</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action={action} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="full_name">Name</Label>
            <Input id="full_name" name="full_name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role">Role</Label>
            <select id="role" name="role" defaultValue="user" className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
              {allowedRoles.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="store_id">Store login (optional)</Label>
            <select id="store_id" name="store_id" defaultValue="" className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
              <option value="">Not a store login</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add person'}</Button>
          </div>
        </form>
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state.created && (
          <div className="rounded-lg border bg-muted p-3 text-sm">
            <p className="font-medium">{state.created.email} was added.</p>
            <p>One-time password: <code className="font-mono">{state.created.oneTimePassword}</code></p>
            <p className="text-muted-foreground">This is shown only once. Give it to the person. They must choose their own password the first time they sign in.</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

`components/admin/UserRow.tsx`:
```tsx
'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { resetPasswordAction, setActiveAction } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'

export type UserRowData = {
  id: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  must_reset_password: boolean
  manageable: boolean
  sees_everything: boolean
  is_self: boolean
}

const ROLE_NAMES: Record<string, string> = { user: 'Viewer', agent: 'Operator', manager: 'Manager', admin: 'Administrator', platform_owner: 'Platform owner' }

export function UserRow({ u }: { u: UserRowData }) {
  const [pending, start] = useTransition()
  const [otp, setOtp] = useState<string | null>(null)

  const toggle = () =>
    start(async () => {
      const res = await setActiveAction(u.id, !u.is_active)
      if (res.error) toast.error(res.error)
      else toast.success(u.is_active ? 'Deactivated.' : 'Activated.')
    })

  const reset = () =>
    start(async () => {
      const res = await resetPasswordAction(u.id)
      if (res.error) toast.error(res.error)
      else setOtp(res.oneTimePassword ?? null)
    })

  return (
    <>
      <tr className="border-t">
        <td className="px-3 py-2">
          <div className="font-medium">{u.full_name || '—'}</div>
          <div className="text-xs text-muted-foreground">{u.email}</div>
        </td>
        <td className="px-3 py-2">{ROLE_NAMES[u.role] ?? u.role}</td>
        <td className="px-3 py-2">{!u.is_active ? 'Deactivated' : u.must_reset_password ? 'Waiting for first sign-in' : 'Active'}</td>
        <td className="space-x-2 px-3 py-2 text-right">
          {!u.sees_everything && u.manageable && (
            <Link href={`/admin/users/${u.id}/access`} className="text-sm underline">Access</Link>
          )}
          {u.manageable && !u.is_self && (
            <>
              <Button size="sm" variant="outline" disabled={pending} onClick={reset}>Reset password</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={toggle}>{u.is_active ? 'Deactivate' : 'Activate'}</Button>
            </>
          )}
        </td>
      </tr>
      {otp && (
        <tr className="bg-muted">
          <td colSpan={4} className="px-3 py-2 text-sm">
            New one-time password for {u.email}: <code className="font-mono">{otp}</code>. Shown only once.
          </td>
        </tr>
      )}
    </>
  )
}
```

`app/(app)/admin/users/page.tsx`:
```tsx
import { CreateUserForm } from '@/components/admin/CreateUserForm'
import { UserRow } from '@/components/admin/UserRow'
import { PageHeader } from '@/components/ui/PageHeader'
import { canManageRole, ROLES, SEES_EVERYTHING } from '@/lib/admin/roles'
import { listUsers } from '@/lib/admin/users'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Users' }

export default async function UsersPage() {
  const me = await requireAdmin()
  const admin = createAdminClient()
  const [users, stores] = await Promise.all([
    listUsers(admin, me.org_id),
    fetchAll((from, to) => admin.from('stores').select('id, code, name').eq('org_id', me.org_id).order('code').range(from, to)),
  ])
  const allowedRoles = ROLES.filter((r) => canManageRole(me.role, r))
  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Add people and choose what they can see." />
      <CreateUserForm allowedRoles={[...allowedRoles]} stores={stores} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Person</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.id}
                u={{ ...u, manageable: canManageRole(me.role, u.role), sees_everything: SEES_EVERYTHING.includes(u.role), is_self: u.id === me.id }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```
(If the copied `PageHeader` has a different prop shape, adapt the call to match it.)

`components/admin/AccessEditor.tsx`:
```tsx
'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { saveAccessAction } from '@/lib/actions/admin/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type StoreRef = { id: string; code: string; name: string; zone: string | null }
type CameraRef = { id: string; store_id: string; channel: number; name: string }

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function AccessEditor(props: {
  userId: string
  stores: StoreRef[]
  cameras: CameraRef[]
  initial: { storeIds: string[]; zones: string[]; cameraIds: string[] }
}) {
  const [storeIds, setStoreIds] = useState(new Set(props.initial.storeIds))
  const [zones, setZones] = useState(new Set(props.initial.zones))
  const [cameraIds, setCameraIds] = useState(new Set(props.initial.cameraIds))
  const [filter, setFilter] = useState('')
  const [cameraStore, setCameraStore] = useState('')
  const [pending, start] = useTransition()

  const allZones = useMemo(() => [...new Set(props.stores.map((s) => s.zone).filter((z): z is string => !!z))].sort(), [props.stores])
  const shownStores = props.stores.filter((s) => `${s.code} ${s.name}`.toLowerCase().includes(filter.toLowerCase()))
  const storeCameras = props.cameras.filter((c) => c.store_id === cameraStore)

  const save = () =>
    start(async () => {
      const res = await saveAccessAction(props.userId, { storeIds: [...storeIds], zones: [...zones], cameraIds: [...cameraIds] })
      if (res.error) toast.error(res.error)
      else toast.success('Access saved.')
    })

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        A person sees all cameras of the stores and zones you tick. If you also tick individual cameras inside a store, they see only those cameras in that store.
        Cameras ticked on their own are visible even when the store is not ticked.
      </p>

      <section className="space-y-2">
        <h2 className="font-medium">Zones</h2>
        <div className="flex flex-wrap gap-3">
          {allZones.map((z) => (
            <label key={z} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={zones.has(z)} onChange={() => setZones(toggled(zones, z))} /> {z}
            </label>
          ))}
          {allZones.length === 0 && <span className="text-sm text-muted-foreground">No zones yet.</span>}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Stores</h2>
        <Input placeholder="Search stores" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2 lg:grid-cols-3">
          {shownStores.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={storeIds.has(s.id)} onChange={() => setStoreIds(toggled(storeIds, s.id))} />
              {s.code} · {s.name}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Individual cameras</h2>
        <select value={cameraStore} onChange={(e) => setCameraStore(e.target.value)} className="h-8 rounded-lg border bg-background px-2 text-sm">
          <option value="">Choose a store…</option>
          {props.stores.map((s) => (
            <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
          ))}
        </select>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {storeCameras.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={cameraIds.has(c.id)} onChange={() => setCameraIds(toggled(cameraIds, c.id))} />
              {c.channel} · {c.name}
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{cameraIds.size} individual camera(s) chosen in total.</p>
      </section>

      <Button onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save access'}</Button>
    </div>
  )
}
```

`app/(app)/admin/users/[id]/access/page.tsx`:
```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AccessEditor } from '@/components/admin/AccessEditor'
import { PageHeader } from '@/components/ui/PageHeader'
import { SEES_EVERYTHING } from '@/lib/admin/roles'
import { getUserAccess } from '@/lib/admin/users'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Access' }

export default async function AccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireAdmin()
  const admin = createAdminClient()
  const { data: person } = await admin.from('profiles').select('id, full_name, email, role').eq('id', id).eq('org_id', me.org_id).maybeSingle()
  if (!person) notFound()
  if (SEES_EVERYTHING.includes(person.role)) {
    return (
      <div className="space-y-4">
        <PageHeader title={person.full_name || person.email} description="This role already sees everything, so it needs no access list." />
        <Link href="/admin/users" className="underline">Back to users</Link>
      </div>
    )
  }
  const [stores, cameras, initial] = await Promise.all([
    fetchAll((from, to) => admin.from('stores').select('id, code, name, zone').eq('org_id', me.org_id).order('code').range(from, to)),
    fetchAll((from, to) => admin.from('cameras').select('id, store_id, channel, name').eq('org_id', me.org_id).order('channel').range(from, to)),
    getUserAccess(admin, me.org_id, id),
  ])
  return (
    <div className="space-y-4">
      <PageHeader title={`Access for ${person.full_name || person.email}`} description="Choose which stores, zones and cameras this person can see." />
      <AccessEditor userId={id} stores={stores} cameras={cameras} initial={initial} />
    </div>
  )
}
```

- [ ] **Step 8: Run the checks and look at the pages**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npx vitest run tests/integration`
Expected: all clean.

Start `npm run dev`, sign in as the dev admin, open `/admin/users`: add a viewer (note the one-time password appears once), open its Access page and save a zone; confirm the toast. Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: user administration with one-time passwords and access grants"
```

---

### Task 9: Stores, cameras and devices: CSV import and manual management

**Files:**
- Create: `lib/inventory/device-types.ts`, `lib/inventory/schemas.ts`, `lib/inventory/stores.ts`, `lib/inventory/devices.ts`, `lib/import/{csv,regions,validators,stores-csv,devices-csv,apply}.ts`, `lib/actions/admin/inventory.ts`, `components/admin/{StoreForm,DeviceForm,ImportForm}.tsx`, `app/(app)/admin/stores/page.tsx`, `app/(app)/admin/devices/page.tsx`, `app/(app)/admin/import/page.tsx`, `docs/samples/stores-sample.csv`, `docs/samples/devices-sample.csv`
- Test: `tests/unit/csv.test.ts`, `tests/unit/regions.test.ts`, `tests/unit/stores-csv.test.ts`, `tests/unit/devices-csv.test.ts`, `tests/integration/inventory-admin.test.ts`

**Interfaces:**
- Consumes: `Actor`, `Result`, `AdminClient` from `lib/admin/users.ts`; `addAudit`; `assertRefsInOrg`; RPCs `nvr_store_credential`, `nvr_delete_credential`.
- Produces: `DEVICE_TYPES`; `parseCsv(text): {line: number; cells: string[]}[]`; `normalizeRegion(value): string | null`; `parseStoresCsv(text): {rows: StoreRow[]; errors: RowError[]}`; `parseDevicesCsv(text): {rows: DeviceRow[]; errors: RowError[]}`; `importStores(admin, actor, rows): ImportResult`; `importDevices(admin, actor, rows): ImportResult`; `ensurePlaceholderCameras(admin, orgId, storeId, count)`; `createStore/updateStore/deleteStore` and `createDevice/updateDevice/deleteDevice`, each `(admin, actor, ...)` returning `Result`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/csv.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/import/csv'

describe('parseCsv', () => {
  it('reads plain rows and numbers them by line', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([{ line: 1, cells: ['a', 'b'] }, { line: 2, cells: ['1', '2'] }])
  })
  it('handles quotes, commas inside quotes, doubled quotes and Windows line endings', () => {
    const rows = parseCsv('name,note\r\n"Store, North","say ""hi"""\r\n')
    expect(rows[1].cells).toEqual(['Store, North', 'say "hi"'])
  })
  it('ignores a leading byte-order mark and skips blank lines but keeps line numbers', () => {
    const rows = parseCsv('﻿a,b\n\n3,4')
    expect(rows).toEqual([{ line: 1, cells: ['a', 'b'] }, { line: 3, cells: ['3', '4'] }])
  })
  it('keeps empty cells', () => {
    expect(parseCsv('a,,c')[0].cells).toEqual(['a', '', 'c'])
  })
})
```

`tests/unit/regions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { normalizeRegion } from '@/lib/import/regions'

describe('normalizeRegion', () => {
  it('makes the same place always look the same', () => {
    expect(normalizeRegion('JH')).toBe('Jharkhand')
    expect(normalizeRegion('Jharkhand')).toBe('Jharkhand')
    expect(normalizeRegion('ASSAM')).toBe('Assam')
    expect(normalizeRegion(' assam ')).toBe('Assam')
  })
  it('keeps short zone codes in capitals', () => {
    expect(normalizeRegion('br')).toBe('BR')
    expect(normalizeRegion('UP')).toBe('UP')
    expect(normalizeRegion('Mp')).toBe('MP')
  })
  it('title-cases longer names', () => {
    expect(normalizeRegion('uttar  pradesh')).toBe('Uttar Pradesh')
  })
  it('returns null for empty values', () => {
    expect(normalizeRegion('')).toBeNull()
    expect(normalizeRegion(undefined)).toBeNull()
  })
})
```

`tests/unit/stores-csv.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseStoresCsv } from '@/lib/import/stores-csv'

const HEADER = 'name,city,zone,ip,port,http_port,user,password,channels'

describe('parseStoresCsv', () => {
  it('reads the legacy columns and fills defaults', () => {
    const { rows, errors } = parseStoresCsv(`${HEADER}\nStore 001 - Patna,Patna,br,192.0.2.10,,,viewer,pw1,16\n`)
    expect(errors).toEqual([])
    expect(rows).toEqual([{
      line: 2, code: 'STORE 001 - PATNA', name: 'Store 001 - Patna', city: 'Patna', zone: 'BR', state: null, address: null,
      nvr_ip: '192.0.2.10', rtsp_port: 554, http_port: 80, nvr_username: 'viewer', nvr_password: 'pw1', channels: 16,
    }])
  })

  it('uses an explicit code in capitals', () => {
    const { rows } = parseStoresCsv('code,name,ip,user\nmdb,Madhubani,192.0.2.11,viewer\n')
    expect(rows[0].code).toBe('MDB')
  })

  it('reports each bad row with its line number and keeps the good ones', () => {
    const csv = [`${HEADER}`, 'A,c,z,not-an-ip,,,u,p,4', 'B,c,z,192.0.2.1,70000,,u,p,4', 'C,c,z,192.0.2.2,,,,p,4', 'D,c,z,192.0.2.3,,,u,p,4'].join('\n')
    const { rows, errors } = parseStoresCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['D'])
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4])
  })

  it('reports a repeated code on the later line', () => {
    const { rows, errors } = parseStoresCsv('code,name,ip,user\nA1,One,192.0.2.1,u\nA1,Two,192.0.2.2,u\n')
    expect(rows).toHaveLength(1)
    expect(errors).toEqual([{ line: 3, message: 'The store code A1 appears more than once in this file.' }])
  })

  it('refuses a file without the required columns', () => {
    const { rows, errors } = parseStoresCsv('name,city\nA,B\n')
    expect(rows).toEqual([])
    expect(errors[0].message).toContain('name, ip and user')
  })
})
```

`tests/unit/devices-csv.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseDevicesCsv } from '@/lib/import/devices-csv'

describe('parseDevicesCsv', () => {
  it('reads devices with and without a store and a port', () => {
    const { rows, errors } = parseDevicesCsv('name,type,store_code,ip,port,notes\nERP server,Server,mdb,192.0.2.20,443,main\nDoor reader,attendance,,192.0.2.21,,\n')
    expect(errors).toEqual([])
    expect(rows).toEqual([
      { line: 2, name: 'ERP server', type: 'server', store_code: 'MDB', ip: '192.0.2.20', tcp_port: 443, notes: 'main' },
      { line: 3, name: 'Door reader', type: 'attendance', store_code: null, ip: '192.0.2.21', tcp_port: null, notes: null },
    ])
  })
  it('reports unknown types, bad addresses and bad ports with their line numbers', () => {
    const csv = ['name,type,ip,port', 'A,toaster,192.0.2.1,', 'B,server,999.1.1.1,', 'C,server,192.0.2.3,0', 'D,server,192.0.2.4,80'].join('\n')
    const { rows, errors } = parseDevicesCsv(csv)
    expect(rows.map((r) => r.name)).toEqual(['D'])
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4])
  })
  it('refuses a file without the required columns', () => {
    expect(parseDevicesCsv('name,ip\nA,192.0.2.1\n').errors[0].message).toContain('name, type and ip')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/csv.test.ts tests/unit/regions.test.ts tests/unit/stores-csv.test.ts tests/unit/devices-csv.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the pure import modules**

`lib/inventory/device-types.ts`:
```ts
export const DEVICE_TYPES = ['nvr', 'server', 'attendance', 'footfall', 'other'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  nvr: 'NVR',
  server: 'Server',
  attendance: 'Attendance machine',
  footfall: 'Footfall counter',
  other: 'Other device',
}
```

`lib/import/csv.ts`:
```ts
export type CsvRow = { line: number; cells: string[] }

/** Small CSV reader: quoted cells, doubled quotes, commas and line breaks inside quotes, Windows line endings, a leading BOM. */
export function parseCsv(input: string): CsvRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: CsvRow[] = []
  let cells: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  let startLine = 1
  const endRow = () => {
    cells.push(field)
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: startLine, cells })
    cells = []
    field = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else {
        if (c === '\n') line++
        field += c
      }
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      cells.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      line++
      startLine = line
    } else field += c
  }
  if (field !== '' || cells.length > 0) endRow()
  return rows
}
```

`lib/import/regions.ts`:
```ts
// Zone and state labels come from many hands ("JH" and "Jharkhand", "ASSAM" and "Assam"). One spelling per place keeps filters and grants working.
const ALIASES: Record<string, string> = {
  jh: 'Jharkhand',
  jharkhand: 'Jharkhand',
  assam: 'Assam',
}

export function normalizeRegion(value: string | null | undefined): string | null {
  const t = (value ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return null
  const hit = ALIASES[t.toLowerCase()]
  if (hit) return hit
  if (/^[A-Za-z]{1,3}$/.test(t)) return t.toUpperCase()
  return t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}
```

`lib/import/validators.ts`:
```ts
import { isIP } from 'node:net'

export const isValidIp = (v: string) => isIP(v.trim()) !== 0

/** An empty value gives the fallback; a whole number from 1 to 65535 gives that number; anything else gives null. */
export function parsePort(value: string, fallback: number | null): number | null {
  const t = value.trim()
  if (t === '') return fallback
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 65535 ? n : null
}
```

`lib/import/stores-csv.ts`:
```ts
import { parseCsv } from '@/lib/import/csv'
import { normalizeRegion } from '@/lib/import/regions'
import { isValidIp, parsePort } from '@/lib/import/validators'

export type RowError = { line: number; message: string }
export type StoreRow = {
  line: number
  code: string
  name: string
  city: string | null
  zone: string | null
  state: string | null
  address: string | null
  nvr_ip: string
  rtsp_port: number
  http_port: number
  nvr_username: string
  nvr_password: string
  channels: number
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

// Columns follow the legacy stores file: name, city, zone, ip, port, http_port, user, password, channels; plus optional code, state, address.
export function parseStoresCsv(text: string): { rows: StoreRow[]; errors: RowError[] } {
  const raw = parseCsv(text)
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }] }
  const headers = raw[0].cells.map((h) => h.trim().toLowerCase())
  if (!['name', 'ip', 'user'].every((h) => headers.includes(h))) {
    return { rows: [], errors: [{ line: 1, message: 'The first line must have the columns name, ip and user (see the sample file).' }] }
  }
  const rows: StoreRow[] = []
  const errors: RowError[] = []
  const seen = new Set<string>()
  for (const { line, cells } of raw.slice(1)) {
    const v: Record<string, string> = {}
    headers.forEach((h, i) => (v[h] = cells[i] ?? ''))
    const fail = (message: string) => errors.push({ line, message })
    const name = v.name.trim()
    if (!name) { fail('The store name is empty.'); continue }
    if (!isValidIp(v.ip)) { fail(`“${v.ip.trim()}” is not a valid IP address.`); continue }
    const rtsp = parsePort(v.port ?? '', 554)
    const http = parsePort(v.http_port ?? '', 80)
    if (rtsp === null || http === null) { fail('A port must be a number from 1 to 65535.'); continue }
    if (!v.user.trim()) { fail('The NVR user name is empty.'); continue }
    const channelsText = (v.channels ?? '').trim()
    if (channelsText !== '' && !/^\d{1,3}$/.test(channelsText)) { fail('The number of channels must be a whole number up to 999.'); continue }
    const code = (v.code?.trim() || name).toUpperCase().slice(0, 50)
    if (seen.has(code)) { fail(`The store code ${code} appears more than once in this file.`); continue }
    seen.add(code)
    rows.push({
      line, code, name,
      city: orNull(v.city), zone: normalizeRegion(v.zone), state: normalizeRegion(v.state), address: orNull(v.address),
      nvr_ip: v.ip.trim(), rtsp_port: rtsp, http_port: http,
      nvr_username: v.user.trim(), nvr_password: v.password ?? '',
      channels: channelsText === '' ? 0 : Number(channelsText),
    })
  }
  return { rows, errors }
}
```

`lib/import/devices-csv.ts`:
```ts
import { parseCsv } from '@/lib/import/csv'
import type { RowError } from '@/lib/import/stores-csv'
import { isValidIp, parsePort } from '@/lib/import/validators'
import { DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'

export type DeviceRow = {
  line: number
  name: string
  type: DeviceType
  store_code: string | null
  ip: string
  tcp_port: number | null
  notes: string | null
}

const orNull = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)

export function parseDevicesCsv(text: string): { rows: DeviceRow[]; errors: RowError[] } {
  const raw = parseCsv(text)
  if (raw.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty.' }] }
  const headers = raw[0].cells.map((h) => h.trim().toLowerCase())
  if (!['name', 'type', 'ip'].every((h) => headers.includes(h))) {
    return { rows: [], errors: [{ line: 1, message: 'The first line must have the columns name, type and ip (see the sample file).' }] }
  }
  const rows: DeviceRow[] = []
  const errors: RowError[] = []
  for (const { line, cells } of raw.slice(1)) {
    const v: Record<string, string> = {}
    headers.forEach((h, i) => (v[h] = cells[i] ?? ''))
    const fail = (message: string) => errors.push({ line, message })
    const name = v.name.trim()
    if (!name) { fail('The device name is empty.'); continue }
    const type = v.type.trim().toLowerCase()
    if (!(DEVICE_TYPES as readonly string[]).includes(type)) { fail(`“${v.type.trim()}” is not a device type. Use ${DEVICE_TYPES.join(', ')}.`); continue }
    if (!isValidIp(v.ip)) { fail(`“${v.ip.trim()}” is not a valid IP address.`); continue }
    const port = parsePort(v.port ?? '', null)
    if (v.port && v.port.trim() !== '' && port === null) { fail('The port must be a number from 1 to 65535.'); continue }
    rows.push({
      line, name, type: type as DeviceType,
      store_code: orNull(v.store_code)?.toUpperCase() ?? null,
      ip: v.ip.trim(), tcp_port: port, notes: orNull(v.notes),
    })
  }
  return { rows, errors }
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit`
Expected: all pass.

- [ ] **Step 5: Write the failing integration test**

`tests/integration/inventory-admin.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from '@/lib/admin/users'
import { importDevices, importStores } from '@/lib/import/apply'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import { parseStoresCsv } from '@/lib/import/stores-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore, updateStore } from '@/lib/inventory/stores'
import { adminClient, cleanupOrg, createOrg, createUser } from '../setup/fixtures'

const admin = () => adminClient()
const password = (store: string) => admin().rpc('nvr_read_credential', { p_store: store })

describe('inventory administration', () => {
  let orgId: string
  let actor: Actor

  beforeAll(async () => {
    orgId = await createOrg()
    const u = await createUser(orgId, 'admin')
    actor = { id: u.id, orgId, role: 'admin' }
  })
  afterAll(() => cleanupOrg(orgId))

  it('imports stores: saves the NVR password in the vault, normalises the zone and makes placeholder cameras', async () => {
    const csv = 'name,city,zone,ip,port,http_port,user,password,channels\nAlpha,Patna,br,192.0.2.10,,,viewer,Secret-A1,4\nBeta,Ranchi,JH,192.0.2.11,,,viewer,Secret-B1,2\n'
    const parsed = parseStoresCsv(csv)
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res).toEqual({ created: 2, updated: 0, errors: [] })

    const { data: stores } = await admin().from('stores').select('id, code, zone').eq('org_id', orgId).order('code')
    expect(stores?.map((s) => [s.code, s.zone])).toEqual([['ALPHA', 'BR'], ['BETA', 'Jharkhand']])
    expect((await password(stores![0].id)).data).toBe('Secret-A1')
    const { data: cams } = await admin().from('cameras').select('name').eq('store_id', stores![0].id).order('channel')
    expect(cams?.map((c) => c.name)).toEqual(['Camera 1', 'Camera 2', 'Camera 3', 'Camera 4'])
  })

  it('a second import updates stores, keeps the password when the cell is empty and keeps camera names', async () => {
    const { data: alpha } = await admin().from('stores').select('id').eq('org_id', orgId).eq('code', 'ALPHA').single()
    await admin().from('cameras').update({ name: 'Front door' }).eq('store_id', alpha!.id).eq('channel', 1)
    const parsed = parseStoresCsv('name,city,zone,ip,user,password,channels\nAlpha,Patna City,BR,192.0.2.99,viewer,,4\n')
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res).toEqual({ created: 0, updated: 1, errors: [] })
    const { data: row } = await admin().from('stores').select('city, nvr_ip').eq('id', alpha!.id).single()
    expect(row).toEqual({ city: 'Patna City', nvr_ip: '192.0.2.99' })
    expect((await password(alpha!.id)).data).toBe('Secret-A1')
    const { data: cam } = await admin().from('cameras').select('name').eq('store_id', alpha!.id).eq('channel', 1).single()
    expect(cam?.name).toBe('Front door')
  })

  it('a new store without a password is reported, not created', async () => {
    const parsed = parseStoresCsv('name,ip,user,password\nGamma,192.0.2.12,viewer,\n')
    const res = await importStores(admin(), actor, parsed.rows)
    expect(res.created).toBe(0)
    expect(res.errors).toEqual([{ line: 2, message: 'A new store needs a password for its NVR.' }])
    const { data } = await admin().from('stores').select('id').eq('org_id', orgId).eq('code', 'GAMMA')
    expect(data).toEqual([])
  })

  it('imports devices, links them to stores by code and reports unknown stores', async () => {
    const parsed = parseDevicesCsv('name,type,store_code,ip,port\nERP,server,alpha,192.0.2.20,443\nHead office switch,other,,192.0.2.21,\nLost,server,nowhere,192.0.2.22,\n')
    const res = await importDevices(admin(), actor, parsed.rows)
    expect(res.created).toBe(2)
    expect(res.errors).toEqual([{ line: 4, message: 'There is no store with the code NOWHERE.' }])
    const again = await importDevices(admin(), actor, parsed.rows.slice(0, 2))
    expect(again).toEqual({ created: 0, updated: 2, errors: [] })
    const { data } = await admin().from('devices').select('id').eq('org_id', orgId)
    expect(data).toHaveLength(2)
  })

  it('creates, changes and deletes one store; deleting removes its cameras and detaches its devices', async () => {
    const made = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.30', nvr_username: 'viewer', nvr_password: 'Secret-D1', zone: 'up', channels: 3 })
    if (!made.ok) throw new Error(made.error)
    expect((await password(made.storeId)).data).toBe('Secret-D1')
    const dup = await createStore(admin(), actor, { name: 'Delta', ip: '192.0.2.31', nvr_username: 'viewer', nvr_password: 'x', channels: 0 })
    expect(dup.ok).toBe(false)

    expect((await updateStore(admin(), actor, made.storeId, { name: 'Delta', ip: '192.0.2.32', nvr_username: 'viewer', nvr_password: 'Secret-D2', zone: 'UP', channels: 3 })).ok).toBe(true)
    expect((await password(made.storeId)).data).toBe('Secret-D2')

    const dev = await createDevice(admin(), actor, { name: 'Counter', type: 'footfall', store_id: made.storeId, ip: '192.0.2.33' })
    if (!dev.ok) throw new Error(dev.error)
    expect((await deleteStore(admin(), actor, made.storeId)).ok).toBe(true)
    expect((await password(made.storeId)).data).toBeNull()
    const { data: cams } = await admin().from('cameras').select('id').eq('store_id', made.storeId)
    expect(cams).toEqual([])
    const { data: d } = await admin().from('devices').select('store_id').eq('id', dev.deviceId).single()
    expect(d?.store_id).toBeNull()
  })

  it('changes and deletes a device, and refuses a store of another organisation', async () => {
    const dev = await createDevice(admin(), actor, { name: 'Scanner', type: 'attendance', ip: '192.0.2.40', tcp_port: 4370 })
    if (!dev.ok) throw new Error(dev.error)
    expect((await updateDevice(admin(), actor, dev.deviceId, { name: 'Scanner 2', type: 'attendance', ip: '192.0.2.41', tcp_port: 4370 })).ok).toBe(true)
    const otherOrg = await createOrg()
    const { data: other } = await admin().from('stores').insert({ org_id: otherOrg, code: 'ZZ', name: 'ZZ', nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()
    expect((await createDevice(admin(), actor, { name: 'Bad', type: 'server', ip: '192.0.2.42', store_id: other!.id })).ok).toBe(false)
    await cleanupOrg(otherOrg)
    expect((await deleteDevice(admin(), actor, dev.deviceId)).ok).toBe(true)
  })

  it('only administrators may change inventory', async () => {
    const viewer: Actor = { id: crypto.randomUUID(), orgId, role: 'user' }
    expect((await createDevice(admin(), viewer, { name: 'X', type: 'server', ip: '192.0.2.50' })).ok).toBe(false)
    expect((await createStore(admin(), viewer, { name: 'X', ip: '192.0.2.51', nvr_username: 'u', nvr_password: 'p', channels: 0 })).ok).toBe(false)
  })
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run tests/integration/inventory-admin.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 7: Implement the inventory services and the import applier**

`lib/inventory/schemas.ts`:
```ts
import { z } from 'zod'
import { DEVICE_TYPES } from '@/lib/inventory/device-types'
import { isValidIp } from '@/lib/import/validators'

const port = z.number().int().min(1, 'A port must be from 1 to 65535.').max(65535, 'A port must be from 1 to 65535.')
const ip = z.string().trim().refine(isValidIp, 'Enter a valid IP address.')
const optionalText = z.string().trim().max(200).nullish().transform((v) => (v ? v : null))

export const storeSchema = z.object({
  code: z.string().trim().max(50).nullish(),
  name: z.string().trim().min(1, 'Enter the store name.').max(200),
  city: optionalText,
  zone: optionalText,
  state: optionalText,
  address: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
  ip,
  rtsp_port: port.default(554),
  http_port: port.default(80),
  nvr_username: z.string().trim().min(1, 'Enter the NVR user name.').max(100),
  nvr_password: z.string().max(200).nullish(),
  channels: z.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
})
export type StoreInput = z.input<typeof storeSchema>

export const deviceSchema = z.object({
  name: z.string().trim().min(1, 'Enter the device name.').max(200),
  type: z.enum(DEVICE_TYPES),
  store_id: z.uuid().nullish(),
  ip,
  tcp_port: port.nullish(),
  notes: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
  enabled: z.boolean().default(true),
})
export type DeviceInput = z.input<typeof deviceSchema>
```

`lib/inventory/stores.ts`:
```ts
import type { Actor, AdminClient, Result } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
import { normalizeRegion } from '@/lib/import/regions'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { storeSchema } from '@/lib/inventory/schemas'

const DENIED = 'Only administrators can change stores.'

/** Adds "Camera 1…N" for channels that do not exist yet. Real names come from discovery later; existing cameras are never touched. */
export async function ensurePlaceholderCameras(admin: AdminClient, orgId: string, storeId: string, count: number): Promise<void> {
  if (count <= 0) return
  const rows = Array.from({ length: Math.min(count, 999) }, (_, i) => ({ org_id: orgId, store_id: storeId, channel: i + 1, name: `Camera ${i + 1}` }))
  const { error } = await admin.from('cameras').upsert(rows, { onConflict: 'store_id,channel', ignoreDuplicates: true })
  if (error) throw error
}

export async function createStore(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ storeId: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  if (!v.nvr_password) return { ok: false, error: 'Enter the NVR password.' }
  const code = (v.code?.trim() || v.name).toUpperCase().slice(0, 50)
  const { data, error } = await admin.from('stores').insert({
    org_id: actor.orgId, code, name: v.name, city: v.city, zone: normalizeRegion(v.zone), state: normalizeRegion(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createStore', fallback: 'Could not save the store.' }) }
  const cred = await admin.rpc('nvr_store_credential', { p_store: data.id, p_secret: v.nvr_password })
  if (cred.error) {
    await admin.from('stores').delete().eq('id', data.id)
    return { ok: false, error: sanitizeError(cred.error, { route: 'createStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  await ensurePlaceholderCameras(admin, actor.orgId, data.id, v.channels)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_created', entityType: 'store', entityId: data.id, detail: { code } })
  return { ok: true, storeId: data.id }
}

export async function updateStore(admin: AdminClient, actor: Actor, storeId: string, input: unknown): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const parsed = storeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  const v = parsed.data
  const { data: existing } = await admin.from('stores').select('id').eq('id', storeId).eq('org_id', actor.orgId).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  const { error } = await admin.from('stores').update({
    name: v.name, city: v.city, zone: normalizeRegion(v.zone), state: normalizeRegion(v.state), address: v.address,
    nvr_ip: v.ip, rtsp_port: v.rtsp_port, http_port: v.http_port, nvr_username: v.nvr_username, expected_channels: v.channels, is_active: v.is_active,
  }).eq('id', storeId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateStore', fallback: 'Could not save the store.' }) }
  if (v.nvr_password) {
    const cred = await admin.rpc('nvr_store_credential', { p_store: storeId, p_secret: v.nvr_password })
    if (cred.error) return { ok: false, error: sanitizeError(cred.error, { route: 'updateStore.credential', fallback: 'Could not save the NVR password.' }) }
  }
  await ensurePlaceholderCameras(admin, actor.orgId, storeId, v.channels)
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_updated', entityType: 'store', entityId: storeId })
  return { ok: true }
}

export async function deleteStore(admin: AdminClient, actor: Actor, storeId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data: existing } = await admin.from('stores').select('id, code').eq('id', storeId).eq('org_id', actor.orgId).maybeSingle()
  if (!existing) return { ok: false, error: 'Store not found.' }
  await admin.rpc('nvr_delete_credential', { p_store: storeId })
  const { error } = await admin.from('stores').delete().eq('id', storeId)
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteStore', fallback: 'Could not delete the store.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'store_deleted', entityType: 'store', entityId: storeId, detail: { code: existing.code } })
  return { ok: true }
}
```
`lib/inventory/devices.ts`:
```ts
import type { Actor, AdminClient, Result } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
import { deviceSchema } from '@/lib/inventory/schemas'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { assertRefsInOrg } from '@/lib/security/org-scope'

const DENIED = 'Only administrators can change devices.'

async function checked(admin: AdminClient, actor: Actor, input: unknown) {
  const parsed = deviceSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' } as const
  const v = parsed.data
  if (v.store_id) {
    try {
      await assertRefsInOrg(admin, actor.orgId, [{ table: 'stores', ids: [v.store_id] }])
    } catch {
      return { error: 'That store was not found.' } as const
    }
  }
  return { value: v } as const
}

export async function createDevice(admin: AdminClient, actor: Actor, input: unknown): Promise<Result<{ deviceId: string }>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const c = await checked(admin, actor, input)
  if ('error' in c) return { ok: false, error: c.error }
  const v = c.value
  const { data, error } = await admin.from('devices').insert({
    org_id: actor.orgId, store_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
  }).select('id').single()
  if (error || !data) return { ok: false, error: sanitizeError(error, { route: 'createDevice', fallback: 'Could not save the device.' }) }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_created', entityType: 'device', entityId: data.id })
  return { ok: true, deviceId: data.id }
}

export async function updateDevice(admin: AdminClient, actor: Actor, deviceId: string, input: unknown): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const c = await checked(admin, actor, input)
  if ('error' in c) return { ok: false, error: c.error }
  const v = c.value
  const { data, error } = await admin.from('devices').update({
    store_id: v.store_id ?? null, type: v.type, name: v.name, ip: v.ip, tcp_port: v.tcp_port ?? null, notes: v.notes, enabled: v.enabled,
  }).eq('id', deviceId).eq('org_id', actor.orgId).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'updateDevice', fallback: 'Could not save the device.' }) }
  if (!data?.length) return { ok: false, error: 'Device not found.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_updated', entityType: 'device', entityId: deviceId })
  return { ok: true }
}

export async function deleteDevice(admin: AdminClient, actor: Actor, deviceId: string): Promise<Result<object>> {
  if (!isAdminRole(actor.role)) return { ok: false, error: DENIED }
  const { data, error } = await admin.from('devices').delete().eq('id', deviceId).eq('org_id', actor.orgId).select('id')
  if (error) return { ok: false, error: sanitizeError(error, { route: 'deleteDevice', fallback: 'Could not delete the device.' }) }
  if (!data?.length) return { ok: false, error: 'Device not found.' }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'device_deleted', entityType: 'device', entityId: deviceId })
  return { ok: true }
}
```

`lib/import/apply.ts`:
```ts
import type { Actor, AdminClient } from '@/lib/admin/users'
import { addAudit } from '@/lib/admin/audit'
import { isAdminRole } from '@/lib/auth/roles'
import type { DeviceRow } from '@/lib/import/devices-csv'
import type { RowError, StoreRow } from '@/lib/import/stores-csv'
import { ensurePlaceholderCameras } from '@/lib/inventory/stores'
import { sanitizeError } from '@/lib/observability/sanitize-error'
import { fetchAll } from '@/lib/supabase/fetch-all'

export type ImportResult = { created: number; updated: number; errors: RowError[] }

/** Saves parsed store rows one by one: a bad row is reported with its line number and never stops the others. */
export async function importStores(admin: AdminClient, actor: Actor, rows: StoreRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  for (const r of rows) {
    try {
      const { data: existing } = await admin.from('stores').select('id').eq('org_id', actor.orgId).eq('code', r.code).maybeSingle()
      const fields = {
        name: r.name, city: r.city, zone: r.zone, state: r.state, address: r.address, nvr_ip: r.nvr_ip,
        rtsp_port: r.rtsp_port, http_port: r.http_port, nvr_username: r.nvr_username, expected_channels: r.channels,
      }
      let storeId: string
      if (existing) {
        const { error } = await admin.from('stores').update(fields).eq('id', existing.id)
        if (error) throw error
        storeId = existing.id
      } else {
        if (!r.nvr_password) {
          result.errors.push({ line: r.line, message: 'A new store needs a password for its NVR.' })
          continue
        }
        const { data, error } = await admin.from('stores').insert({ ...fields, org_id: actor.orgId, code: r.code }).select('id').single()
        if (error || !data) throw error
        storeId = data.id
      }
      if (r.nvr_password) {
        const { error } = await admin.rpc('nvr_store_credential', { p_store: storeId, p_secret: r.nvr_password })
        if (error) {
          if (!existing) await admin.from('stores').delete().eq('id', storeId)
          throw error
        }
      }
      await ensurePlaceholderCameras(admin, actor.orgId, storeId, r.channels)
      if (existing) result.updated++
      else result.created++
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importStores', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_stores', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  return result
}

/** Devices are matched by IP address and port, so importing the same file again updates instead of duplicating. */
export async function importDevices(admin: AdminClient, actor: Actor, rows: DeviceRow[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, errors: [] }
  if (!isAdminRole(actor.role)) return { ...result, errors: [{ line: 1, message: 'Only administrators can import.' }] }
  const stores = await fetchAll((from, to) => admin.from('stores').select('id, code').eq('org_id', actor.orgId).range(from, to))
  const byCode = new Map(stores.map((s) => [s.code, s.id]))
  for (const r of rows) {
    try {
      let storeId: string | null = null
      if (r.store_code) {
        storeId = byCode.get(r.store_code) ?? null
        if (!storeId) {
          result.errors.push({ line: r.line, message: `There is no store with the code ${r.store_code}.` })
          continue
        }
      }
      const { data: same } = await admin.from('devices').select('id, tcp_port').eq('org_id', actor.orgId).eq('ip', r.ip)
      const existing = (same ?? []).find((d) => d.tcp_port === r.tcp_port)
      const fields = { store_id: storeId, type: r.type, name: r.name, ip: r.ip, tcp_port: r.tcp_port, notes: r.notes }
      if (existing) {
        const { error } = await admin.from('devices').update(fields).eq('id', existing.id)
        if (error) throw error
        result.updated++
      } else {
        const { error } = await admin.from('devices').insert({ ...fields, org_id: actor.orgId })
        if (error) throw error
        result.created++
      }
    } catch (err) {
      result.errors.push({ line: r.line, message: sanitizeError(err, { route: 'importDevices', fallback: 'This row could not be saved.' }) })
    }
  }
  await addAudit(admin, { orgId: actor.orgId, actorId: actor.id, action: 'import_devices', detail: { created: result.created, updated: result.updated, errors: result.errors.length } })
  return result
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/unit tests/integration`
Expected: all pass.

- [ ] **Step 9: Server Actions, forms and pages**

`lib/actions/admin/inventory.ts`:
```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth/profile'
import { importDevices, importStores, type ImportResult } from '@/lib/import/apply'
import { parseDevicesCsv } from '@/lib/import/devices-csv'
import { parseStoresCsv, type RowError } from '@/lib/import/stores-csv'
import { createDevice, deleteDevice, updateDevice } from '@/lib/inventory/devices'
import { createStore, deleteStore, updateStore } from '@/lib/inventory/stores'
import { createAdminClient } from '@/lib/supabase/admin'

export type FormResult = { error?: string; ok?: boolean }
export type ImportState = { result?: ImportResult; parseErrors?: RowError[]; error?: string }

async function ctx() {
  const p = await requireAdmin()
  return { admin: createAdminClient(), actor: { id: p.id, orgId: p.org_id, role: p.role } }
}

const text = (f: FormData, k: string) => String(f.get(k) ?? '')
const num = (f: FormData, k: string) => (text(f, k).trim() === '' ? undefined : Number(text(f, k)))

function storeInput(f: FormData) {
  return {
    code: text(f, 'code') || null, name: text(f, 'name'), city: text(f, 'city'), zone: text(f, 'zone'), state: text(f, 'state'), address: text(f, 'address'),
    ip: text(f, 'ip'), rtsp_port: num(f, 'rtsp_port'), http_port: num(f, 'http_port'),
    nvr_username: text(f, 'nvr_username'), nvr_password: text(f, 'nvr_password') || null,
    channels: num(f, 'channels'), is_active: f.get('is_active') === 'on',
  }
}

export async function saveStoreAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const id = text(formData, 'id')
  const res = id ? await updateStore(admin, actor, id, storeInput(formData)) : await createStore(admin, actor, storeInput(formData))
  revalidatePath('/admin/stores')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function deleteStoreAction(storeId: string): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const res = await deleteStore(admin, actor, storeId)
  revalidatePath('/admin/stores')
  return res.ok ? { ok: true } : { error: res.error }
}

function deviceInput(f: FormData) {
  return {
    name: text(f, 'name'), type: text(f, 'type'), store_id: text(f, 'store_id') || null, ip: text(f, 'ip'),
    tcp_port: num(f, 'tcp_port'), notes: text(f, 'notes'), enabled: f.get('enabled') === 'on',
  }
}

export async function saveDeviceAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const id = text(formData, 'id')
  const res = id ? await updateDevice(admin, actor, id, deviceInput(formData)) : await createDevice(admin, actor, deviceInput(formData))
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error }
}

export async function deleteDeviceAction(deviceId: string): Promise<FormResult> {
  const { admin, actor } = await ctx()
  const res = await deleteDevice(admin, actor, deviceId)
  revalidatePath('/admin/devices')
  return res.ok ? { ok: true } : { error: res.error }
}

const MAX_FILE_BYTES = 5 * 1024 * 1024

async function readFile(formData: FormData): Promise<string | null> {
  const f = formData.get('file')
  if (!(f instanceof File) || f.size === 0 || f.size > MAX_FILE_BYTES) return null
  return f.text()
}

export async function importStoresAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const { admin, actor } = await ctx()
  const body = await readFile(formData)
  if (body === null) return { error: 'Choose a CSV file smaller than 5 MB.' }
  const parsed = parseStoresCsv(body)
  const result = await importStores(admin, actor, parsed.rows)
  revalidatePath('/admin/stores')
  return { result, parseErrors: parsed.errors }
}

export async function importDevicesAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const { admin, actor } = await ctx()
  const body = await readFile(formData)
  if (body === null) return { error: 'Choose a CSV file smaller than 5 MB.' }
  const parsed = parseDevicesCsv(body)
  const result = await importDevices(admin, actor, parsed.rows)
  revalidatePath('/admin/devices')
  return { result, parseErrors: parsed.errors }
}
```

`components/admin/ImportForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import type { ImportState } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ImportForm({ title, help, sampleHref, action }: {
  title: string
  help: string
  sampleHref: string
  action: (prev: ImportState, formData: FormData) => Promise<ImportState>
}) {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(action, {})
  const errors = [...(state.parseErrors ?? []), ...(state.result?.errors ?? [])].sort((a, b) => a.line - b.line)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{help}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={formAction} className="flex flex-wrap items-center gap-3">
          <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
          <Button type="submit" disabled={pending}>{pending ? 'Importing…' : 'Import'}</Button>
          <a href={sampleHref} download className="text-sm underline">Download a sample file</a>
        </form>
        {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state.result && (
          <p className="text-sm">
            Added {state.result.created}, updated {state.result.updated}, skipped {errors.length}.
          </p>
        )}
        {errors.length > 0 && (
          <div className="max-h-60 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-1.5">Line</th><th className="px-3 py-1.5">Problem</th></tr>
              </thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={i} className="border-t"><td className="px-3 py-1.5">{e.line}</td><td className="px-3 py-1.5">{e.message}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

`components/admin/StoreForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import { saveStoreAction, type FormResult } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type StoreFormValues = {
  id?: string; code?: string; name?: string; city?: string | null; zone?: string | null; state?: string | null; address?: string | null
  nvr_ip?: string; rtsp_port?: number; http_port?: number; nvr_username?: string; expected_channels?: number; is_active?: boolean
}

function Field({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
    </div>
  )
}

export function StoreForm({ store }: { store?: StoreFormValues }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(saveStoreAction, {})
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={store?.id ?? ''} />
      <Field id="name" label="Store name" defaultValue={store?.name ?? ''} required />
      <Field id="code" label="Store code" defaultValue={store?.code ?? ''} placeholder="Short code, e.g. MDB" disabled={!!store?.id} />
      <Field id="city" label="City" defaultValue={store?.city ?? ''} />
      <Field id="zone" label="Zone" defaultValue={store?.zone ?? ''} />
      <Field id="state" label="State" defaultValue={store?.state ?? ''} />
      <Field id="address" label="Address" defaultValue={store?.address ?? ''} />
      <Field id="ip" label="NVR IP address" defaultValue={store?.nvr_ip ?? ''} required />
      <Field id="rtsp_port" label="Video port" type="number" defaultValue={store?.rtsp_port ?? 554} />
      <Field id="http_port" label="Web port" type="number" defaultValue={store?.http_port ?? 80} />
      <Field id="nvr_username" label="NVR user name" defaultValue={store?.nvr_username ?? ''} required />
      <Field id="nvr_password" label={store?.id ? 'NVR password (leave empty to keep it)' : 'NVR password'} type="password" autoComplete="new-password" required={!store?.id} />
      <Field id="channels" label="Number of cameras" type="number" defaultValue={store?.expected_channels ?? 0} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_active" defaultChecked={store?.is_active ?? true} /> Active
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{store?.id ? 'Save changes' : 'Add store'}</Button>
        {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="mt-2 text-sm">Saved.</p>}
      </div>
    </form>
  )
}
```

`components/admin/DeviceForm.tsx`:
```tsx
'use client'

import { useActionState } from 'react'
import { saveDeviceAction, type FormResult } from '@/lib/actions/admin/inventory'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from '@/lib/inventory/device-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type DeviceFormValues = { id?: string; name?: string; type?: string; store_id?: string | null; ip?: string; tcp_port?: number | null; notes?: string | null; enabled?: boolean }

export function DeviceForm({ device, stores }: { device?: DeviceFormValues; stores: { id: string; code: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FormResult, FormData>(saveDeviceAction, {})
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <input type="hidden" name="id" value={device?.id ?? ''} />
      <div className="space-y-1.5">
        <Label htmlFor="name">Device name</Label>
        <Input id="name" name="name" defaultValue={device?.name ?? ''} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="type">Type</Label>
        <select id="type" name="type" defaultValue={device?.type ?? 'server'} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
          {DEVICE_TYPES.map((t) => (<option key={t} value={t}>{DEVICE_TYPE_LABELS[t]}</option>))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="store_id">Store</Label>
        <select id="store_id" name="store_id" defaultValue={device?.store_id ?? ''} className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
          <option value="">Not at a store</option>
          {stores.map((s) => (<option key={s.id} value={s.id}>{s.code} · {s.name}</option>))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ip">IP address</Label>
        <Input id="ip" name="ip" defaultValue={device?.ip ?? ''} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tcp_port">Port to check (optional)</Label>
        <Input id="tcp_port" name="tcp_port" type="number" defaultValue={device?.tcp_port ?? ''} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Input id="notes" name="notes" defaultValue={device?.notes ?? ''} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={device?.enabled ?? true} /> Check this device
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={pending}>{device?.id ? 'Save changes' : 'Add device'}</Button>
        {state.error && <p role="alert" className="mt-2 text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="mt-2 text-sm">Saved.</p>}
      </div>
    </form>
  )
}
```

`components/admin/DeleteButton.tsx`:
```tsx
'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import type { FormResult } from '@/lib/actions/admin/inventory'
import { Button } from '@/components/ui/button'

// Two clicks to delete, with the confirmation inside the page (no browser dialog).
export function DeleteButton({ onDelete, label = 'Delete' }: { onDelete: () => Promise<FormResult>; label?: string }) {
  const [armed, setArmed] = useState(false)
  const [pending, start] = useTransition()
  if (!armed) return <Button size="sm" variant="outline" onClick={() => setArmed(true)}>{label}</Button>
  return (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="destructive" disabled={pending} onClick={() => start(async () => {
        const res = await onDelete()
        if (res.error) toast.error(res.error)
        else toast.success('Deleted.')
        setArmed(false)
      })}>Yes, delete</Button>
      <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>Cancel</Button>
    </span>
  )
}
```

`app/(app)/admin/stores/page.tsx`:
```tsx
import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { StoreForm } from '@/components/admin/StoreForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteStoreAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage stores' }

export default async function ManageStoresPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdmin()
  const admin = createAdminClient()
  const stores = await fetchAll((from, to) =>
    admin.from('stores').select('id, code, name, city, zone, state, address, nvr_ip, rtsp_port, http_port, nvr_username, expected_channels, is_active').eq('org_id', me.org_id).order('code').range(from, to),
  )
  const editing = stores.find((s) => s.id === edit)
  return (
    <div className="space-y-6">
      <PageHeader title="Manage stores" description="Add a store by hand, or import many from the Import page." />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a store'}</h2>
        <StoreForm key={editing?.id ?? 'new'} store={editing} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Zone</th><th className="px-3 py-2">NVR</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="px-3 py-2 font-mono">{s.code}</td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2">{s.zone ?? '—'}</td>
                <td className="px-3 py-2 font-mono">{s.nvr_ip}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <Link href={`/admin/stores?edit=${s.id}`} className="underline">Edit</Link>
                  <DeleteButton onDelete={deleteStoreAction.bind(null, s.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

`app/(app)/admin/devices/page.tsx`:
```tsx
import Link from 'next/link'
import { DeleteButton } from '@/components/admin/DeleteButton'
import { DeviceForm } from '@/components/admin/DeviceForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { deleteDeviceAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/fetch-all'

export const metadata = { title: 'Manage devices' }

export default async function ManageDevicesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams
  const me = await requireAdmin()
  const admin = createAdminClient()
  const [devices, stores] = await Promise.all([
    fetchAll((from, to) => admin.from('devices').select('id, store_id, type, name, ip, tcp_port, notes, enabled').eq('org_id', me.org_id).order('name').range(from, to)),
    fetchAll((from, to) => admin.from('stores').select('id, code, name').eq('org_id', me.org_id).order('code').range(from, to)),
  ])
  const editing = devices.find((d) => d.id === edit)
  const storeName = new Map(stores.map((s) => [s.id, s.code]))
  return (
    <div className="space-y-6">
      <PageHeader title="Manage devices" description="Servers, attendance machines, footfall counters and any other device with an IP address." />
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-medium">{editing ? `Change ${editing.name}` : 'Add a device'}</h2>
        <DeviceForm key={editing?.id ?? 'new'} device={editing} stores={stores} />
      </section>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">Address</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                <td className="px-3 py-2">{d.store_id ? storeName.get(d.store_id) ?? '—' : '—'}</td>
                <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
                <td className="space-x-2 px-3 py-2 text-right">
                  <Link href={`/admin/devices?edit=${d.id}`} className="underline">Edit</Link>
                  <DeleteButton onDelete={deleteDeviceAction.bind(null, d.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

`app/(app)/admin/import/page.tsx`:
```tsx
import { ImportForm } from '@/components/admin/ImportForm'
import { PageHeader } from '@/components/ui/PageHeader'
import { importDevicesAction, importStoresAction } from '@/lib/actions/admin/inventory'
import { requireAdmin } from '@/lib/auth/profile'

export const metadata = { title: 'Import' }

export default async function ImportPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <PageHeader title="Import" description="Add or update many stores or devices from a CSV file." />
      <ImportForm
        title="Stores"
        help="Columns: name, city, zone, ip, port, http_port, user, password, channels (optional: code, state, address). Importing the same store again updates it; leave the password empty to keep the saved one."
        sampleHref="/samples/stores-sample.csv"
        action={importStoresAction}
      />
      <ImportForm
        title="Devices"
        help="Columns: name, type (nvr, server, attendance, footfall, other), store_code (optional), ip, port (optional), notes (optional)."
        sampleHref="/samples/devices-sample.csv"
        action={importDevicesAction}
      />
    </div>
  )
}
```

`public/samples/stores-sample.csv` (synthetic addresses from the documentation range; do not use real store data or passwords):
```
name,city,zone,ip,port,http_port,user,password,channels
Sample Store A,Patna,BR,192.0.2.10,554,80,viewer,change-me-A,4
Sample Store B,Ranchi,JH,192.0.2.11,554,80,viewer,change-me-B,2
```

`public/samples/devices-sample.csv`:
```
name,type,store_code,ip,port,notes
Sample ERP server,server,,192.0.2.20,443,Head office
Sample attendance machine,attendance,SAMPLE STORE A,192.0.2.21,4370,Entrance
Sample footfall counter,footfall,SAMPLE STORE A,192.0.2.22,,Door counter
```
(`proxy.ts` lets `/samples/...` through only for signed-in people, which is what we want; the asset fast path only covers root-level files.)

- [ ] **Step 10: Run the checks and try the screens**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npx vitest run tests/integration`
Expected: all clean.

Start `npm run dev`, sign in as the dev admin. On `/admin/import` download the two sample files, import the stores then the devices, and confirm the counts. On `/admin/stores` edit one store (leave the password empty) and delete one with the two-click button. Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: store and device management with CSV import"
```

---

### Task 10: Viewer pages (Home, Stores, Devices), final checks and documentation

**Files:**
- Create: `lib/queries/inventory.ts`, `app/(app)/stores/page.tsx`, `app/(app)/stores/[id]/page.tsx`, `app/(app)/devices/page.tsx`
- Modify: `app/(app)/home/page.tsx`, `README.md`, `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md` (testing section)
- Test: `tests/integration/viewer-queries.test.ts`

**Interfaces:**
- Consumes: `createClient()` (RLS client), `CurrentProfile`.
- Produces: `listVisibleStores(supabase, q?)`, `getVisibleStore(supabase, id)`, `listVisibleDevices(supabase, type?)`, `homeCounts(supabase)`; pages `/home`, `/stores`, `/stores/[id]`, `/devices` that read only through the RLS client.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/viewer-queries.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getVisibleStore, homeCounts, listVisibleDevices, listVisibleStores } from '@/lib/queries/inventory'
import { adminClient, cleanupOrg, createOrg, createUser, type TestUser } from '../setup/fixtures'

describe('viewer queries respect access', () => {
  let orgId: string
  let storeA: string
  let storeB: string
  let viewer: TestUser
  let manager: TestUser

  beforeAll(async () => {
    const admin = adminClient()
    orgId = await createOrg()
    const mk = async (code: string, zone: string) =>
      (await admin.from('stores').insert({ org_id: orgId, code, name: `Store ${code}`, city: 'Patna', zone, nvr_ip: '127.0.0.1', nvr_username: 'u' }).select('id').single()).data!.id
    storeA = await mk('AA', 'BR')
    storeB = await mk('BB', 'UP')
    await admin.from('cameras').insert([1, 2].map((n) => ({ org_id: orgId, store_id: storeA, channel: n, name: `C${n}` })))
    await admin.from('cameras').insert({ org_id: orgId, store_id: storeB, channel: 1, name: 'C1' })
    await admin.from('devices').insert([
      { org_id: orgId, store_id: storeA, type: 'server', name: 'A server', ip: '127.0.0.1' },
      { org_id: orgId, store_id: storeB, type: 'footfall', name: 'B counter', ip: '127.0.0.1' },
    ])
    viewer = await createUser(orgId, 'user')
    manager = await createUser(orgId, 'manager')
    await admin.rpc('replace_user_access', { p_user: viewer.id, p_stores: [storeA], p_zones: [], p_cameras: [] })
  })
  afterAll(() => cleanupOrg(orgId))

  it('lists only visible stores, with their camera counts, and can search', async () => {
    const mine = await listVisibleStores(viewer.client)
    expect(mine.map((s) => [s.code, s.camera_count])).toEqual([['AA', 2]])
    const all = await listVisibleStores(manager.client)
    expect(all.map((s) => s.code)).toEqual(['AA', 'BB'])
    expect((await listVisibleStores(manager.client, 'store b')).map((s) => s.code)).toEqual(['BB'])
    // A search made only of special characters becomes empty, which means no filter at all.
    expect((await listVisibleStores(manager.client, '%,()')).length).toBe(2)
  })

  it('shows a store with its cameras and devices only when it is visible', async () => {
    const ok = await getVisibleStore(viewer.client, storeA)
    expect(ok?.cameras.map((c) => c.channel)).toEqual([1, 2])
    expect(ok?.devices.map((d) => d.name)).toEqual(['A server'])
    expect(await getVisibleStore(viewer.client, storeB)).toBeNull()
  })

  it('lists visible devices and can filter by type', async () => {
    expect((await listVisibleDevices(viewer.client)).map((d) => d.name)).toEqual(['A server'])
    expect((await listVisibleDevices(manager.client, 'footfall')).map((d) => d.name)).toEqual(['B counter'])
  })

  it('counts what the person may see', async () => {
    expect(await homeCounts(viewer.client)).toEqual({ stores: 1, cameras: 2, devices: { server: 1 } })
    expect(await homeCounts(manager.client)).toEqual({ stores: 2, cameras: 3, devices: { server: 1, footfall: 1 } })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/viewer-queries.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the queries**

`lib/queries/inventory.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Client = SupabaseClient<Database>

// Every function here uses the signed-in person's own client, so row-level security decides what comes back.

/** Keeps a search word from changing the meaning of the filter. */
const cleanSearch = (q: string) => q.replace(/[%,()*\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

export type StoreListItem = { id: string; code: string; name: string; city: string | null; zone: string | null; camera_count: number }

export async function listVisibleStores(supabase: Client, q?: string): Promise<StoreListItem[]> {
  const term = cleanSearch(q ?? '')
  const rows = await fetchAll((from, to) => {
    let query = supabase.from('stores').select('id, code, name, city, zone, cameras(count)').order('code')
    if (term) query = query.or(`name.ilike.%${term}%,code.ilike.%${term}%,city.ilike.%${term}%`)
    return query.range(from, to)
  })
  return rows.map((s) => ({
    id: s.id, code: s.code, name: s.name, city: s.city, zone: s.zone,
    camera_count: (s.cameras as unknown as { count: number }[])[0]?.count ?? 0,
  }))
}

export async function getVisibleStore(supabase: Client, id: string) {
  const { data: store } = await supabase.from('stores').select('id, code, name, city, zone, state, address, is_active').eq('id', id).maybeSingle()
  if (!store) return null
  const [cameras, devices] = await Promise.all([
    supabase.from('cameras').select('id, channel, name, camera_ip').eq('store_id', id).order('channel'),
    supabase.from('devices').select('id, type, name, ip, tcp_port').eq('store_id', id).order('name'),
  ])
  return { ...store, cameras: cameras.data ?? [], devices: devices.data ?? [] }
}

export async function listVisibleDevices(supabase: Client, type?: string) {
  return fetchAll((from, to) => {
    let query = supabase.from('devices').select('id, store_id, type, name, ip, tcp_port, enabled, stores(code, name)').order('name')
    if (type) query = query.eq('type', type as Database['public']['Enums']['device_type'])
    return query.range(from, to)
  })
}

export async function homeCounts(supabase: Client): Promise<{ stores: number; cameras: number; devices: Record<string, number> }> {
  const [stores, cameras, devices] = await Promise.all([
    supabase.from('stores').select('id', { count: 'exact', head: true }),
    supabase.from('cameras').select('id', { count: 'exact', head: true }),
    fetchAll((from, to) => supabase.from('devices').select('id, type').range(from, to)),
  ])
  const byType: Record<string, number> = {}
  for (const d of devices) byType[d.type] = (byType[d.type] ?? 0) + 1
  return { stores: stores.count ?? 0, cameras: cameras.count ?? 0, devices: byType }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/integration/viewer-queries.test.ts`
Expected: `4 passed`.

- [ ] **Step 5: Pages**

`app/(app)/home/page.tsx` (replace):
```tsx
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES } from '@/lib/inventory/device-types'
import { homeCounts } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Home' }

export default async function HomePage() {
  const profile = await requireProfile()
  const counts = await homeCounts(await createClient())
  const tile = (label: string, value: number, href: string) => (
    <Link href={href} className="rounded-xl border bg-card p-4 hover:bg-muted">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </Link>
  )
  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${profile.full_name || profile.email}`} description="What you can see right now." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile('Stores', counts.stores, '/stores')}
        {tile('Cameras', counts.cameras, '/stores')}
        {DEVICE_TYPES.filter((t) => counts.devices[t]).map((t) => tile(DEVICE_TYPE_LABELS[t] + 's', counts.devices[t], `/devices?type=${t}`))}
      </div>
      {counts.stores === 0 && counts.cameras === 0 && (
        <p className="text-sm text-muted-foreground">You have not been given access to anything yet. Ask an administrator.</p>
      )}
    </div>
  )
}
```

`app/(app)/stores/page.tsx`:
```tsx
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { listVisibleStores } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Stores' }

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  await requireProfile()
  const stores = await listVisibleStores(await createClient(), q)
  return (
    <div className="space-y-4">
      <PageHeader title="Stores" description="The stores you can see." />
      <form className="flex gap-2">
        <input name="q" defaultValue={q ?? ''} placeholder="Search by name, code or city" className="h-8 w-full max-w-sm rounded-lg border bg-background px-2 text-sm" />
        <button className="rounded-lg border px-3 text-sm">Search</button>
      </form>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">City</th><th className="px-3 py-2">Zone</th><th className="px-3 py-2 text-right">Cameras</th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t hover:bg-muted/50">
                <td className="px-3 py-2 font-mono"><Link href={`/stores/${s.id}`} className="underline">{s.code}</Link></td>
                <td className="px-3 py-2">{s.name}</td>
                <td className="px-3 py-2">{s.city ?? '—'}</td>
                <td className="px-3 py-2">{s.zone ?? '—'}</td>
                <td className="px-3 py-2 text-right">{s.camera_count}</td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No stores to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

`app/(app)/stores/[id]/page.tsx`:
```tsx
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, type DeviceType } from '@/lib/inventory/device-types'
import { getVisibleStore } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Store' }

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireProfile()
  const store = await getVisibleStore(await createClient(), id)
  if (!store) notFound()
  return (
    <div className="space-y-6">
      <PageHeader title={`${store.code} · ${store.name}`} description={[store.city, store.zone].filter(Boolean).join(' · ')} />
      <section>
        <h2 className="mb-2 font-medium">Cameras ({store.cameras.length})</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {store.cameras.map((c) => (
            <div key={c.id} className="rounded-lg border bg-card p-3 text-sm">
              <div className="font-medium">{c.channel} · {c.name}</div>
              <div className="text-muted-foreground">{c.camera_ip ?? 'Address not known yet'}</div>
            </div>
          ))}
          {store.cameras.length === 0 && <p className="text-sm text-muted-foreground">No cameras to show.</p>}
        </div>
      </section>
      {store.devices.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">Devices</h2>
          <ul className="space-y-1 text-sm">
            {store.devices.map((d) => (
              <li key={d.id}>{d.name} · {DEVICE_TYPE_LABELS[d.type as DeviceType]} · <span className="font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
```

`app/(app)/devices/page.tsx`:
```tsx
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { requireProfile } from '@/lib/auth/profile'
import { DEVICE_TYPE_LABELS, DEVICE_TYPES, type DeviceType } from '@/lib/inventory/device-types'
import { listVisibleDevices } from '@/lib/queries/inventory'
import { createClient } from '@/lib/supabase/server'

export const metadata = { title: 'Devices' }

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams
  await requireProfile()
  const active = (DEVICE_TYPES as readonly string[]).includes(type ?? '') ? type : undefined
  const devices = await listVisibleDevices(await createClient(), active)
  return (
    <div className="space-y-4">
      <PageHeader title="Devices" description="Servers, attendance machines, footfall counters and other devices you can see." />
      <div className="flex flex-wrap gap-2 text-sm">
        <Link href="/devices" className={!active ? 'font-medium underline' : 'underline'}>All</Link>
        {DEVICE_TYPES.map((t) => (
          <Link key={t} href={`/devices?type=${t}`} className={active === t ? 'font-medium underline' : 'underline'}>{DEVICE_TYPE_LABELS[t]}</Link>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Store</th><th className="px-3 py-2">Address</th></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2">{DEVICE_TYPE_LABELS[d.type as DeviceType]}</td>
                <td className="px-3 py-2">{(d.stores as unknown as { code: string } | null)?.code ?? '—'}</td>
                <td className="px-3 py-2 font-mono">{d.ip}{d.tcp_port ? `:${d.tcp_port}` : ''}</td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No devices to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Update the README and the spec's testing section**

Replace `README.md` with:
```markdown
# CityKart Network Monitoring Hub

Monitors CCTV cameras, NVRs, servers, attendance machines, footfall counters and any other IP device,
with live camera feeds and per-user access to stores and cameras. Built on the Citykart Desk stack
(Next.js 16, Supabase/PostgreSQL, shadcn/ui). The app listens on **port 3212**.

- Design: `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`
- Plans: `docs/superpowers/plans/`
- Legacy app kept for reference only: `reference/cctv-hub-legacy/`

## First run (needs Node 20+ and Docker)

    npm install
    npm run db:start        # local Supabase on ports 55321-55324 (first run downloads images)
    npm run db:reset        # applies the migrations and the seed organisation
    npm run env:local       # writes .env.local (git-ignored) with generated keys and secrets
    node scripts/create-dev-admin.mjs
    npm run dev             # http://localhost:3212

The dev admin's e-mail and password are in `.env.local` (`DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`).

## Checks

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run test:integration   # needs the local Supabase stack; uses disposable organisations

Integration tests only run against the local stack (port 55321) and never touch a real store.

## Safety rules

No passwords, keys or tokens in the repository, logs or chat. NVR passwords live only in Supabase Vault.
Do not connect to production systems from a development machine.
```

In `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`, replace the bullet that starts `- **Integration on an isolated Supabase stack:**` and the bullet that starts `- **Isolation gate**` with:
```markdown
- **Integration on the local Supabase stack:** row-level security tests using disposable organisations (a viewer sees only granted stores, cameras and devices; the grant cases; `must_reset_password` blocks everything; cross-organisation isolation), Vault RPC privileges, server-only table privileges. A fully separate test stack arrives in the hardening plan.
- **Isolation gate** (`assertLocalStack()` in the test setup): integration tests run only against the local stack on port 55321. From the monitoring plan on, an egress guard preloaded in the test process also refuses outbound connections to any address except loopback, so a test can never probe a real store.
```

- [ ] **Step 7: Full verification**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`
Expected: all clean and passing.

Run: `npm run build`
Expected: production build succeeds.

Start `npm run dev` and, in the Browser pane at http://localhost:3212, check (reading the dev admin credentials from `.env.local`, never printing them):
1. Signed out, `/stores` redirects to `/login`.
2. Sign in as the dev admin; import the two sample files; `/stores`, `/stores/<id>` and `/devices` show the data; Home shows the counts.
3. On `/admin/users` add a viewer (copy the one-time password), then on its Access page grant one store and save.
4. Sign out. Sign in as that viewer with the one-time password: the app sends you to choose a new password; after saving you land on Home showing only the granted store's cameras; `/admin/users` sends you back to `/home`; `/stores/<id of a store not granted>` shows "not found".
5. Check the page at phone width (375 px) with the Browser pane's resize tool, then reset it to desktop.
Stop the dev server. Write down anything that looked wrong and fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: viewer pages for stores, devices and home, with README"
```

---

## Plan self-review

**Spec coverage (Plan 1 scope).** Stack, port 3212, repository layout and conventions: Tasks 1, 2, 5. Local Supabase on 553xx: Task 3. Data model for organisations, profiles, stores, cameras, devices, access tables, audit log: Tasks 4 and 7 (`check_state`, `outages`, `worker_state`, `monitor_gaps` belong to Plan 2; `camera_groups`, `backup_jobs`, `system_log` to Plans 3 and 4). Roles and the database-enforced visibility rules including the three grant cases, own store, devices rule and `must_reset_password`: Task 7 tests. Writes only by admins through the server with audit: Tasks 7, 8, 9. Vault for NVR passwords: Tasks 7, 9. Import formats and zone/state normalisation: Task 9. Security items (per-purpose secrets, rate limits, signed header, headers, CSV safety): Tasks 1, 5, 6. Health and version: Task 1. UI shell, plain language, IST time: Tasks 2, 5, 10. Monitoring, live feeds, playback, backup, reports, system log, CSP, production hosting: later plans.

**Placeholders.** None: every step has code or an exact command. Two instructions depend on files copied from Desk (`components/ui/*`, `globals.css`); Task 2 Step 2 says how to repair imports that do not resolve, and that `PageHeader`'s props must be matched when pages call it.

**Type consistency.** `Actor`, `Result`, `AdminClient` are defined in `lib/admin/users.ts` (Task 8) and used by Task 9. `isAdminRole` lives in `lib/auth/roles.ts` (Task 6) and is used by `lib/auth/profile.ts` and the Task 9 services. `Role` comes from `lib/nav.ts` (Task 2) in `lib/auth/profile.ts` and from `lib/admin/roles.ts` elsewhere; both are the same union of five strings. `fetchAll` is defined in Task 8 and used in Tasks 8 to 10. RPC argument names (`p_user`, `p_stores`, `p_zones`, `p_cameras`, `p_store`, `p_secret`) match the SQL in Task 7.

**Known risks to watch while executing.** Copied Desk components may import Desk-only modules (Task 2). The exact output names of `supabase status -o env` can differ between CLI versions (Task 3 checks and fails loudly). The shape of `cameras(count)` embedded counts depends on PostgREST; `lib/queries/inventory.ts` reads `[0].count` and the Task 10 test proves it.
