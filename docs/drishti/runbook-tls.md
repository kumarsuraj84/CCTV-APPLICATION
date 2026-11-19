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
5. Renewal: before the certificate ends, replace the two files and restart the proxy (`Restart-Service DrishtiProxy`, elevated). The Caddyfile has `admin off` (P5.4 fix round 4, re-review 3 m-e): Caddy's admin API on loopback would let any local user or program load another configuration, for example one that serves the certificate folder, so `caddy reload` is not used; a restart takes a second or two.

## 3. Settings of the app and the gateway (production env file, outside the repository)

| Key | Value behind Caddy | Why |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://drishti.citykart.local` | turns on HSTS, `upgrade-insecure-requests` and secure cookies |
| `NEXT_PUBLIC_STREAM_GATEWAY_URL=/` | `/` | the gateway is on the same address (`/g/*`); the pages derive `wss://<name>` themselves. It is built into the pages: rebuild after a change |
| `GATEWAY_HEALTH_URL` | `http://127.0.0.1:3412` (written by gen-secrets) | where the server reads the gateway's `/g/health` for the Health and Monitoring pages: on this computer, never through Caddy (which does not pass `/g/health` on). Needed when the video address is an explicit `wss://`/`https://` address; the production web app warns at start without it (P5.4 fix round 5) |
| `GATEWAY_ALLOWED_ORIGINS` | `https://drishti.citykart.local` | the gateway accepts sockets only from the app's address |
| `GATEWAY_HOST` | `127.0.0.1` | the gateway listens on this computer only (default `0.0.0.0`) |
| `TRUSTED_PROXY_HOPS` | `1` | the app believes the client address Caddy adds (sign-in delays per IP). Set it in the **gateway's** environment too (P5.5): without it every video socket comes from 127.0.0.1 and the gateway's per-address limits (100 open videos, 240 attempts a minute) apply to all users together |
| `CSP_REPORT_ONLY` | empty (enforce); `1` for a first rollout week | `1` = the browser reports what it would block (logged as `csp_violation`) but blocks nothing |
| `CSP_CONNECT_EXTRA` | normally empty | extra origins the pages may connect to, comma separated (origins only, no wildcard) |
| `SESSION_MAX_HOURS` / `SESSION_IDLE_MINUTES_ADMIN` / `SESSION_IDLE_MINUTES` / `FRESH_AUTH_MINUTES` | 12 / 60 / 480 / 10 (defaults) | sign-in lifetime, idle limits (administrators / others), fresh sign-in window |

The web app must listen on loopback: start it with `next start -H 127.0.0.1 --port 3212` (the Windows service of WP-5.4 does this).

**The Supabase API / auth server stays private (review I-5).** The app's sign-in delay (P2-6), its count of codes (6 per person in
5 minutes), "one app per person", the code-once rule and the idle limit all live in the web app. Anybody who can reach the auth server
(GoTrue, `/auth/v1` of the Supabase API) directly could sign in, ask for and try codes, and refresh sessions around them. So:

- `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` point to this computer (`http://127.0.0.1:<port>`); Caddy does not route the Supabase
  API (see the Caddyfile). Close the Supabase API port to every other computer (release 1, re-review R-1b: in Windows Firewall a
  **Block rule always wins over an Allow rule**, so "block Any, then allow the app host" cannot work):
  - **One computer (app and Supabase together, the normal layout):** one Block rule is enough —
    `New-NetFirewallRule -DisplayName "Supabase API local only" -Direction Inbound -LocalPort <port> -Protocol TCP -RemoteAddress Any -Action Block`.
    Windows Firewall does not filter loopback traffic, so the app on this computer still connects over `127.0.0.1`.
  - **The app on another machine:** do NOT add a Block rule for the port. Rely on the default "block inbound" profile and add one Allow
    rule scoped to the app host only — `New-NetFirewallRule -DisplayName "Supabase API from the app host" -Direction Inbound -LocalPort <port> -Protocol TCP -RemoteAddress <app host IP> -Action Allow`
    — and check that no other Allow rule (a Docker or "any port" rule) opens the port. Then set `DRISHTI_AUTH_URL_PRIVATE_OK=firewalled`
    on the app host (below).
  - Docker Desktop publishes the CLI stack's ports on every address; check the result from another PC either way.
- The web app **refuses to start in production** (`DRISHTI_ENV=production`) unless that address is this computer or the app's own
  address (`lib/web/tls.ts` `authUrlProblem`, called by the start-up check). Release 1 (re-review I-5 / R-1): an address on the private
  network (`10.x`, `192.168.x`, `172.16-31.x`, a single-label or `.local` / `.lan` / `.internal` name) is refused too unless the owner
  has closed its port to the other PCs as above and sets `DRISHTI_AUTH_URL_PRIVATE_OK=firewalled` — the company network is exactly
  where the attacker of the finding sits. A hosted project with its network restrictions switched on (only the app host may connect)
  is accepted with `DRISHTI_AUTH_URL_PUBLIC_OK=network-restricted` — set it only after checking the restriction.
- The auth server's own limits as a second line: `[auth.mfa] max_enrolled_factors = 1`, `[auth.sessions] timebox = "12h"` and
  `inactivity_timeout = "8h"` (local: `supabase/config.toml`; self-hosted production: `GOTRUE_MFA_MAX_ENROLLED_FACTORS=1`,
  `GOTRUE_SESSIONS_TIMEBOX=12h`, `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=8h`). GoTrue 2.197 also limits code checks per IP with
  `GOTRUE_MFA_RATE_LIMIT_CHALLENGE_AND_VERIFY` (requests per second, default 15); the Supabase CLI's `config.toml` has no key for it,
  so it can be set only on a self-hosted GoTrue (production): `GOTRUE_MFA_RATE_LIMIT_CHALLENGE_AND_VERIFY=0.1` (one every 10 s per IP).
  Check from another PC that `http://<server>:<supabase port>/auth/v1/health` does NOT answer (record it with the first Caddy run).
- HSTS (review M-12) is decided when the app is built: `NEXT_PUBLIC_APP_URL` must already be the https address at build time. Do not add
  `includeSubDomains` unless every name under the company domain is https.

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

## 5. Two-step sign-in in production (the procedure since the final fixes, migration 20261021000049)

Two-step sign-in (an authenticator-app code, "aal2") is required in production for administrators, super administrators and everybody
holding `admin.*`, `cctv.export` or a high-risk IT/Wi-Fi capability (decision D-10a; DECISIONS.md FY-1). It is enforced by checks,
never by a remembered manual step: in production (`DRISHTI_ENV=production`) the web app **refuses to start**, and the Health page's
"Two-step sign-in" check fails, while any active organisation has it switched off **without an audited reason**. Every change goes
through `public.security_set_mfa` and is written to the audit log with who did it and why. Never write `security_settings` by hand: a
row switched off without a reason is exactly what refuses the start.

1. **The auth server.** TOTP must be on: `[auth.mfa.totp] enroll_enabled = true, verify_enabled = true` (`supabase/config.toml` for
   the local stack, the project's auth settings when hosted). The local stack picks it up after `npm run db:stop` / `npm run db:start`.
2. **The first production start.** The update (`deploy\windows\update.ps1`) marks the database as a production one
   (`test_fixture_switch.production`). From then on an organisation with no settings row, and every new settings row, has two-step
   sign-in ON by default; administrators are sent to set up their app at their first sign-in. So:
   - create the first organisation and its super administrators AFTER the first update has run (the normal order of
     `windows-services.md` section 4): nothing to do, it is on;
   - if the web app refuses to start with "... two-step sign-in switched off with no recorded reason", the start-up line names the
     exact statement. As the database owner (psql on the database host), either switch it on:
     `SELECT public.security_set_mfa('<organisation id>', NULL, true);`
     or record why it stays off for now (a warning at every start and on the Health page until it is on):
     `SELECT public.security_set_mfa('<organisation id>', NULL, false, '<reason, 10 to 500 characters>');`
     A super administrator does the same on the Health page (after a fresh sign-in); the database owner or the service key may do it
     with no person (`NULL`), and it is audited all the same.
3. **Before switching it on for an organisation that had it off:** every administrator sets up an authenticator app first (Security
   page → "Set up two-step sign-in"), so nobody is locked out. Count who still has none: the People page shows "Two-step sign-in: on,
   set up <date> IST from <address>" per person, or as the database owner:
   `SELECT p.email FROM public.profiles p WHERE p.org_id = '<org>' AND p.is_active AND (p.role IN ('admin','platform_owner')
   OR EXISTS (SELECT 1 FROM public.access_grants_eval(p.id, now(), false, true, true) g JOIN public.capabilities c ON c.key = g.capability
   WHERE c.requires_mfa)) AND p.id NOT IN (SELECT user_id FROM public.mfa_factor_people('<org>'));` must return no row.
   Setting up an app needs a fresh sign-in (the password within the last 10 minutes), so a stolen session alone cannot bind a phone.
   **Remaining risk:** whoever knows a privileged person's password before that person has set up an app (a new account's one-time
   password, a promoted person) can sign in and bind their own phone first. Give one-time passwords in person, have the new
   administrator sign in and set up the app at once, and look at the set-up date and address on the People page afterwards (each
   set-up is in `auth_events` as `mfa_enrolled` with the address; there is no e-mail notice).
4. **Wrong codes (DECISIONS.md FY-2).** 10 wrong codes in a row lock that person's code step for 15 minutes; each further 10 double it
   (at most 24 hours); 100 lock it until a super administrator unlocks it on the People page ("Unlock code step…", with a reason;
   `mfa_code_lock_clear`), or resets the person's two-step sign-in. Nobody unlocks their own. Locks and unlocks are audited
   (`auth_events` `mfa_locked`, `mfa_locked_for_good`, `mfa_lock_cleared`; `admin_audit_log` `mfa_code_lock_cleared`).
5. **Lost phone.** A super administrator opens People → "Reset two-step sign-in…" with a reason (audited before anything changes); the
   person is signed out everywhere and sets up a new app at the next sign-in. A super administrator who lost their own phone needs
   another super administrator: keep at least two.
6. **Break-glass (nobody left who can sign in with a code).** Today, as the database owner only:
   `SELECT public.security_set_mfa('<organisation id>', NULL, false, 'break-glass: <who, why, ticket>');` (audited; the web app starts
   with a warning), sign in, set up a new app, then switch it on again with `SELECT public.security_set_mfa('<organisation id>', NULL, true);`
   and check the audit log. A dedicated break-glass function (one person, time-limited, audited) is **planned** for a later clean-up
   round; until it exists, use only the statement above.
7. **Sign-in rate limits.** The app's own limit is the sign-in gate (per e-mail address and client address: from the third failure
   the next try waits 5 s, 10 s, ... 5 minutes; with `TRUSTED_PROXY_HOPS=1` also 100 tries in 15 minutes per client address). The auth
   server sees every sign-in as coming from the web server, so its own per-address limit is one counter for the whole installation:
   set the sign-in limit to at least 1000 per 5 minutes (hosted project: the auth rate limits; local stack: `[auth.rate_limit]
   sign_in_sign_ups`) and the code check likewise (`token_verifications`). A busy auth server is answered "Sign-in is busy, please
   try again in a moment" and is not counted as a wrong password (`runbooks/secret-rotation.md` section 5a).
8. **Switching it off on purpose** is only ever `security_set_mfa(..., false, '<reason>')` (the Health page, or the database owner):
   never an `UPDATE` or `INSERT` on `security_settings`.

## 6. First run through Caddy (to do and record)

1. Download Caddy for Windows (amd64) from the official release page **with the owner's approval**, check its signature/hash, and
   copy `caddy.exe` to `C:\Drishti\caddy\` only after `drishti-services.ps1 -Action Install` has made and locked that folder.
   It runs as the `DrishtiProxy` Windows service under `NT SERVICE\DrishtiProxy` (P5.4 fix round 3, final review C-I12: set `CaddyExe`
   and add `DrishtiProxy` to `Services` in `drishti.config.psd1`). The layout that fits the folder locks: the Caddyfile in
   `C:\Drishti\config\Caddyfile`, the certificate and key in `C:\Drishti\config\certs` (both read by the proxy account only),
   Caddy's storage in `C:\Drishti\data\caddy` and its log in `C:\Drishti\logs\DrishtiProxy` (written by the proxy account only);
   `windows-services.md` section 1.
2. `caddy validate --config C:\Drishti\config\Caddyfile`, then `drishti-services.ps1 -Action Start -Service DrishtiProxy`.
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
- **Fresh sign-in** (`FRESH_AUTH_MINUTES`, default 10; review I-3: one guard, `lib/auth/fresh.ts`): every change on the administration
  pages (people, access, review, locations, regions, clusters, moves, NVRs and their monitoring switch, mappings, merges, findings,
  archive and restore, assets, devices, imports, "find cameras"), setting up or removing one's own authenticator app, changing one's own
  password (not the forced first change) and fast playback (an export) need a sign-in or code within that time.
  `tests/unit/fresh-auth-guard.test.ts` lists every Server Action and route handler and fails for one that is neither guarded nor on its
  reasoned allow-list (reads, the sign-in steps themselves, camera groups, video viewing). The administration pages, the set-up page and
  the password page show "Confirm it's you" (opens in a new tab).
- **Codes count once** (review M-9): GoTrue 2.197 accepts the same code again within its window (measured), so the app claims each code
  per person in the database (`mfa_code_claim`, three minutes) before asking the auth server.
- **Cookies** (review I-1): every sign-in cookie, whoever writes it (sign-in, code step, set-up, "Confirm it's you", password change,
  reset link, the proxy's refresh), is HttpOnly, SameSite=Lax and, on https, Secure (`lib/supabase/cookie-options.ts`).
- **Audit** of sign-ins, failed sign-ins (a hash of the typed address, never the password), sign-outs, expired sessions, two-step
  set-up, codes, resets and confirmations: `public.auth_events` (append-only; readable with `admin.audit.read`).
- An administrator can sign a person out everywhere (Users → "Sign out everywhere…"); everybody can do it for themselves (Security).

## 8. Back out

Remove Caddy (stop the service) and set `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_STREAM_GATEWAY_URL` back (rebuild), `GATEWAY_HOST`
empty; the app works over plain http again. To roll the CSP back without a release, `CSP_REPORT_ONLY=1` (blocks nothing). The database
part of P3-1 is undone by `supabase/rollback/20261021000034_p31_mfa_sessions_rollback.sql` (dry run first).
