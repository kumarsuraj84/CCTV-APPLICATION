# Runbook: one HTTPS address for Drishti on Windows (TLS, CSP, multi-factor, sessions) — P3-1

Applies to: the Windows deployment of CityKart Drishti (WP-5.4 packages it as services). Written 2026-10-23 with P3-1. Docker is not
needed in production for any of this; go2rtc's own packaging is WP-4.3/WP-5.4.

**Verification status (honest).** Caddy is **not** installed on the development computer and nothing was downloaded or installed for
P3-1 (downloading needs the owner's permission). The layout below was therefore **not run through Caddy**. What is verified, by tests:
the security headers on pages, API routes and redirects, HSTS only on https, http-only and (on https) secure cookies, the gateway
address derived for `/` (same origin, `wss`), `localhost` and `10.0.0.47`, and that the Content Security Policy allows exactly the
gateway origin (`tests/unit/csp.test.ts`, `tests/unit/proxy-security.test.ts`, `tests/unit/tls-readiness.test.ts`,
`tests/unit/live-wall.test.ts`). The first real run through Caddy must follow section 6 and record the result in the tracker.

## 1. Layout

```
browser ──https/wss──► Caddy (443, the only listener on the network)
                          ├─ /g/*  ──► video gateway 127.0.0.1:3412 (GATEWAY_HOST=127.0.0.1)
                          └─ /     ──► web app       127.0.0.1:3212 (next start -H 127.0.0.1)
                                         └─► Supabase / PostgreSQL, go2rtc on loopback
```

- The app is at `/`; the gateway's socket and player scripts at `/g/*` on the **same origin**, so the browser uses `wss://<name>/g/ws`
  and the Content Security Policy needs no second host.
- The example configuration is `deploy/windows/Caddyfile.example` (copy it, change the name and the certificate paths; never commit
  the real file, a key or a certificate request).

## 2. Certificate

1. Ask the company CA for a server certificate for the chosen name (for example `drishti.citykart.local`), with that name in the
   Subject Alternative Name. Give the CA a request made on the server (`certreq` or the certificate snap-in); the private key never
   leaves the server.
2. Export certificate and key as PEM into `C:\Drishti\certs\` (`drishti.crt`, `drishti.key`). Only the account that runs Caddy and the
   Administrators may read the folder (`icacls`).
3. The company's root certificate must be trusted by the PCs that open Drishti (normally already through Group Policy).
4. Lab only: `tls internal` in the Caddyfile makes Caddy's own local CA sign a certificate (self-signed root). Trust that root on the
   test PCs only. Never use it for production.
5. Renewal: before the certificate ends, replace the two files and reload Caddy (`caddy reload --config C:\Drishti\caddy\Caddyfile`).

## 3. Settings of the app and the gateway (production env file, outside the repository)

| Key | Value behind Caddy | Why |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://drishti.citykart.local` | turns on HSTS, `upgrade-insecure-requests` and secure cookies |
| `NEXT_PUBLIC_STREAM_GATEWAY_URL=/` | `/` | the gateway is on the same address (`/g/*`); the pages derive `wss://<name>` themselves. It is built into the pages: rebuild after a change |
| `GATEWAY_ALLOWED_ORIGINS` | `https://drishti.citykart.local` | the gateway accepts sockets only from the app's address |
| `GATEWAY_HOST` | `127.0.0.1` | the gateway listens on this computer only (default `0.0.0.0`) |
| `TRUSTED_PROXY_HOPS` | `1` | the app believes the client address Caddy adds (sign-in delays per IP) |
| `CSP_REPORT_ONLY` | empty (enforce); `1` for a first rollout week | `1` = the browser reports what it would block (logged as `csp_violation`) but blocks nothing |
| `CSP_CONNECT_EXTRA` | normally empty | extra origins the pages may connect to, comma separated (origins only, no wildcard) |
| `SESSION_MAX_HOURS` / `SESSION_IDLE_MINUTES_ADMIN` / `SESSION_IDLE_MINUTES` / `FRESH_AUTH_MINUTES` | 12 / 60 / 480 / 10 (defaults) | sign-in lifetime, idle limits (administrators / others), fresh sign-in window |

The web app must listen on loopback: start it with `next start -H 127.0.0.1 --port 3212` (the Windows service of WP-5.4 does this).

Without Caddy (today, on the company network over plain http) nothing needs setting: with `NEXT_PUBLIC_STREAM_GATEWAY_URL` unset or
`auto`, a page opened at `http://10.0.0.47:3212` uses the gateway `http://10.0.0.47:3412`, one opened at `http://localhost:3212` uses
`http://localhost:3412` (an explicit `http://localhost:3412` is also turned into the page's host when the page is opened from another
PC). `GATEWAY_ALLOWED_ORIGINS` must still list every address people type (for example `http://10.0.0.47:3212,http://localhost:3212`).

## 4. Security headers (what the app sends; Caddy adds none)

- **Content-Security-Policy** per request with a fresh nonce (`proxy.ts`, `lib/web/csp.ts`): `script-src 'self' 'nonce-…'
  'strict-dynamic'` (no inline handlers, no eval in production), `connect-src 'self'` + the gateway origin (+ `CSP_CONNECT_EXTRA`),
  `img-src 'self' data: blob:`, `media-src 'self' blob:`, `style-src 'self' 'unsafe-inline'` (React style attributes and the toast
  style sheet; styles cannot run code), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`,
  `frame-src 'none'`, `report-uri /api/csp-report`, `upgrade-insecure-requests` on https. Development adds `'unsafe-eval'` and the
  page's own hot-reload socket. Redirect answers carry `default-src 'none'`.
- `Strict-Transport-Security: max-age=31536000` only when `NEXT_PUBLIC_APP_URL` is https; `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
- Cookies: the sign-in cookies and the activity record are `HttpOnly`, `SameSite=Lax`, and `Secure` on https.

## 5. Switch multi-factor on (production checklist)

1. Make sure TOTP is on in the auth server: `[auth.mfa.totp] enroll_enabled = true, verify_enabled = true` (`supabase/config.toml`
   for the local stack, the project's auth settings when hosted). The local stack picks it up after `npm run db:stop` / `npm run db:start`.
2. Every administrator sets up an authenticator app first (Security page → "Set up two-step sign-in"), so nobody is locked out.
3. As the database owner (psql on the database host; never through the API — not even the service key may write this table):

```sql
INSERT INTO public.security_settings (org_id, mfa_enforced, note)
VALUES ('<organisation id>', true, 'multi-factor required for administrators')
ON CONFLICT (org_id) DO UPDATE SET mfa_enforced = true, updated_at = now();
```

   From then on administrators, super administrators and everybody holding `admin.*`, `cctv.export` or a high-risk IT/Wi-Fi capability
   must finish the code (aal2) before any page; without an app they are sent to set one up; viewers may set one up but need not.
   In an aal1 session the database itself leaves those capabilities out (`access_grants_eval`).
4. Lost phone: a super administrator opens Users → "Reset two-step sign-in…" with a reason (audited before anything changes); the
   person is signed out everywhere and sets up a new app at the next sign-in. A super administrator who lost their own phone needs
   another super administrator (keep at least two). Last resort, as the database owner: `UPDATE public.security_settings SET
   mfa_enforced = false WHERE org_id = '…';`, sign in, set up a new app, switch it back on.
5. Undo: the same statement with `false`.

## 6. First run through Caddy (to do and record)

1. Download Caddy for Windows (amd64) from the official release page **with the owner's approval**, put `caddy.exe` in
   `C:\Drishti\caddy\`, check its signature/hash, run it as a service under a dedicated account (WP-5.4).
2. `caddy validate --config C:\Drishti\caddy\Caddyfile`, then start it.
3. From another PC: open `https://drishti.citykart.local` — no certificate warning; sign in; the response headers show the CSP with a
   nonce and HSTS; the Live wall plays (the browser's network panel shows `wss://drishti.citykart.local/g/ws?…` with status 101); the
   console shows no CSP violation; `http://drishti.citykart.local` redirects to https.
4. `curl -sI https://drishti.citykart.local/api/health` shows the CSP header; `/stores` redirects with `default-src 'none'`.
5. Record the result (and the Caddy version) in `docs/drishti/DELIVERY-STATUS.md` (SO-8, LG-34).

## 7. Sessions (what the app does)

- **Lifetime** 12 hours after signing in (`SESSION_MAX_HOURS`), **idle** 60 minutes for administrators and 8 hours for everybody else
  (`SESSION_IDLE_MINUTES_ADMIN`, `SESSION_IDLE_MINUTES`); a signed activity cookie bound to the sign-in records the last request
  (`lib/auth/session-activity.ts`). Requests the open Live wall makes by itself (token renewal every minute) count as activity.
  An ended sign-in is signed out at the auth server and audited (`session_expired_idle` / `session_expired_absolute`). The auth server's
  own backstop is `[auth.sessions] timebox = "12h"` (keep it at or above `SESSION_MAX_HOURS`).
- **Fresh sign-in** (`FRESH_AUTH_MINUTES`, default 10): changes of people and access, keeping review items, NVR passwords and the
  location import need a sign-in or code within that time; the pages show "Confirm it's you" (opens in a new tab).
- **Audit** of sign-ins, failed sign-ins (a hash of the typed address, never the password), sign-outs, expired sessions, two-step
  set-up, codes, resets and confirmations: `public.auth_events` (append-only; readable with `admin.audit.read`).
- An administrator can sign a person out everywhere (Users → "Sign out everywhere…"); everybody can do it for themselves (Security).

## 8. Back out

Remove Caddy (stop the service) and set `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_STREAM_GATEWAY_URL` back (rebuild), `GATEWAY_HOST`
empty; the app works over plain http again. To roll the CSP back without a release, `CSP_REPORT_ONLY=1` (blocks nothing). The database
part of P3-1 is undone by `supabase/rollback/20261021000034_p31_mfa_sessions_rollback.sql` (dry run first).
