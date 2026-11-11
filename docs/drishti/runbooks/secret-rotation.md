# Runbook: secrets, service keys and their rotation (P2-6)

Applies to: CityKart Drishti, local development and the later Windows deployment (WP-5.4). Written 2026-10-22 with P2-6
(`docs/drishti/adr-service-roles.md`, migration `20261021000033_p26_service_roles.sql`).

Rules that hold for every step below:

- No value is ever printed, pasted into a ticket or chat, written into the repository or a log. Every tool here prints names only.
- Every secret is generated: `node scripts/gen-secrets.mjs` (also `npm run secrets:gen`). It writes to one file (default
  `.env.local`; `--file <path>` for another, for example a production file outside the repository), adds what is missing, and never
  replaces a value that is set unless `--rotate` (all generated values) or `--rotate=NAME,NAME` (only those) says so. `--dry-run` shows
  what would change. The service keys need the project JWT secret: on the local stack the script reads it from `supabase status`; in
  production pass `--jwt-secret-env NAME` (the name of an environment variable that holds it).
- Each purpose has its own secret (`lib/secrets.ts`): at least 16 characters for the first five, 32 for the P2-6 ones, all different
  (`auditSecrets()` reports a short or repeated one, never the value).
- After a change, restart exactly the processes in the "read by" column. The development web server (`npm run dev`) reloads
  `.env.local` by itself; the gateway, the worker and go2rtc must be restarted.
- Windows: the generator's file mode (0600) has no effect there, so it sets the ACL itself (P5.4 review I-7). A NEW file (and a new
  `--out-dir` folder) is locked before any secret is written into it: inheritance removed, SYSTEM and Administrators full control (plus
  the person running it, only when the prompt is not elevated). An EXISTING file, including every `--rotate`, is rewritten in place,
  so it keeps the ACL it has: the service account's read right that `drishti-services.ps1 -Action Install` gave it stays. The
  generator fills an empty `KEY=` line in place and keeps the file's Windows line ends. Fix round 2: every temporary copy is made in
  a work folder of its own (`.gen-secrets-<pid>-…` next to the file), created and locked before any file is made in it, so even an
  empty copy never carries the rules of a folder that is not locked (re-review M-new-5); the work folder is removed afterwards.
  "Elevated" is read from the token's integrity level (`whoami /groups` lists `S-1-16-12288`), not from `net session`, which also
  fails when the Server service is stopped (re-review M-new-7).
  To put a production env file's ACL right by hand, use `C:\Drishti\scripts\drishti-services.ps1 -Action RepairAcl` (it applies the
  whole plan of `windows-services.md` section 3 and removes everybody else's entries). For one file by hand, in two steps (well-known
  SIDs, so it works in any Windows language; review 2 m5: `/grant:r` alone keeps other people's explicit entries, so the file is first
  reset to nothing of its own, then given exactly its entries):
  `icacls C:\Drishti\config\web.env /reset` then
  `icacls C:\Drishti\config\web.env /inheritance:r /grant:r *S-1-5-18:F /grant:r *S-1-5-32-544:F /grant:r "NT SERVICE\DrishtiWeb:R"`
  (`worker.env`: `NT SERVICE\DrishtiWorker`; `gateway.env`: `NT SERVICE\DrishtiGateway`; `go2rtc.env`: `NT SERVICE\DrishtiGo2rtc`),
  and check it with `drishti-services.ps1 -Action Audit`.
  Never `/grant:r "%USERNAME%:F"` alone on a production file: it takes the service's read right away and the service no longer starts.
  On a development computer, `.env.local` may stay as it is. Verification status: verified by design and unit-tested; the behaviour on real folders (locks, junctions, hard links) is checked by the Windows lab suite on the production server before the install (`windows-services.md` section 7.0), not yet run there.
- Production mode (review round 1, I-1): `DRISHTI_ENV=production` in every process's environment (`deploy/production.env.example`).
  Each process then checks its own keys and secrets at start-up and refuses with one plain line (exit code 1) when one is missing,
  ended or in the wrong process; development only warns. Give each process its own env file: in production the worker and the gateway
  refuse to start with `SUPABASE_SERVICE_ROLE_KEY` in their environment.

## 1. The secrets

| Key | Purpose | Read by | Rotation (what happens) |
|---|---|---|---|
| `SUPABASE_APP_WEB_KEY` | the web app's own database role `app_web` (no NVR login read) | web app | `gen-secrets --rotate=SUPABASE_APP_WEB_KEY`, restart the web app. Old key stays valid until its `exp` (one year) — see section 3 to cut it off at once |
| `SUPABASE_MEDIA_SERVICE_KEY` | the video path's role `media_service` (routes, media sessions, NVR logins for video, discovery, connection test) | web app | as above |
| `SUPABASE_MONITOR_WORKER_KEY` | the worker's role `monitor_worker` | worker | as above, restart the worker |
| `SUPABASE_VIDEO_GATEWAY_KEY` | the gateway's role `video_gateway` (three registry functions only) | gateway | as above, restart the gateway |
| `SUPABASE_SERVICE_ROLE_KEY` | the full service key: scripts, seeding, tests, and GoTrue's admin API for user administration | web app (user administration only), scripts | made from the project JWT secret: rotate that (section 2) |
| `STREAM_TOKEN_SECRET` | signs the 90-second video tokens | web app AND gateway (same value) | change in both, restart the gateway. Every older token is refused at once (`tests/unit/stream-token.test.ts`); open walls get new tokens on their next renewal (within a minute), sockets already open are not cut |
| `ACCESS_PREVIEW_SECRET` | binds an access save to the preview shown (shared by every app instance) | web app | an open preview must be checked again |
| `MERGE_CONFIRM_SECRET` | binds a camera merge to the pair confirmed (shared by every app instance) | web app | an open merge question must be asked again (they last 10 minutes anyway) |
| `VERIFIED_USER_SECRET` | signs the proxy's verified-user header (was the service key before P2-6) | web app | nothing visible: unsigned or old headers make the page check the session itself |
| `GO2RTC_API_USERNAME` / `GO2RTC_API_PASSWORD` | go2rtc's API login (D-13; go2rtc's stream list holds NVR sources with passwords) | web app, gateway, go2rtc container | section 4 (order matters) |
| `CRON_SECRET`, `WORKER_SECRET`, `SYSTEM_LOG_INGEST_SECRET` | reserved purposes of the first release (no endpoint uses them today) | — | `gen-secrets --rotate=NAME` |
| `SIGNER_SECRET`, `AGENT_INGEST_SECRET`, `AUDIT_CHECKPOINT_SECRET` | reserved for D-9 command signing, agent check-ins and D-15 checkpoints | — (later packages) | the package that uses one adds its own steps here |
| NVR passwords | in the Vault, written by the admin screens and the import (write-only) | `media_service`, `monitor_worker` through `recorder_credential_read` (logged in `vault_reads`) | change the password on the NVR, then save it on the NVR's page (or re-import); the worker uses it from its next round |

Production requires every key above that a running process reads: without its own key no process starts — the worker and the gateway
check at start-up, the web app in `instrumentation.ts` (review round 1, M-16) — and `STREAM_TOKEN_SECRET`, `MERGE_CONFIRM_SECRET`,
`ACCESS_PREVIEW_SECRET`, `VERIFIED_USER_SECRET` and go2rtc's login are checked the same way (`lib/startup-checks.ts`). A service key
that ends within 30 days is announced at every start (rotate it); an ended one stops the process.

## 2. The project JWT secret (everything signed with it)

The anon key, the service key, every signed-in person's session and the four service keys are JWTs signed with the project's JWT
secret. Rotating it invalidates all of them at once: everybody signs in again, and every process needs its new keys.

1. Hosted project: rotate it in the project's settings (JWT keys). Local stack: the CLI's default secret is the same on every
   development machine (that is acceptable only because the local stack listens on this computer); a custom one is set in the CLI's
   auth configuration and needs a stack restart — check the pinned CLI's documentation before relying on it (not verified in P2-6).
2. Put the new anon and service keys into the env file (`npm run env:local -- --force` on the local stack writes a fresh `.env.local`;
   it keeps nothing from the old one, so prefer editing the two lines by hand in production).
3. `node scripts/gen-secrets.mjs --rotate=SUPABASE_APP_WEB_KEY,SUPABASE_MEDIA_SERVICE_KEY,SUPABASE_MONITOR_WORKER_KEY,SUPABASE_VIDEO_GATEWAY_KEY`
   (production: add `--jwt-secret-env NAME --file <path>`).
4. Restart the web app, the gateway and the worker.

## 3. Cutting off one service key at once (a key was exposed)

A JWT cannot be revoked by itself before its `exp`. To stop a role's keys immediately, as the database owner (psql on the database host):

```sql
REVOKE video_gateway FROM authenticator;   -- or app_web, media_service, monitor_worker: every key of that role stops working now
```

Then rotate the project JWT secret (section 2), and give the role back: `GRANT video_gateway TO authenticator;`. Until then the
process of that role cannot reach the database (the gateway refuses new video; the worker waits; for `app_web`/`media_service` the web
app fails), so do this only for a real exposure.

To see which role a key in a file is for and when it ends, without showing the key:

```powershell
node -e "const f=require('fs').readFileSync('.env.local','utf8');for(const l of f.split(/\r?\n/)){const m=/^(SUPABASE_[A-Z_]+_KEY)=(.+)$/.exec(l);if(m){const c=JSON.parse(Buffer.from(m[2].split('.')[1]||'','base64url').toString()||'{}');console.log(m[1],c.role,c.exp?new Date(c.exp*1000).toISOString():'-')}}"
```

Rotate every service key before its `exp` (one year after it was made).

## 4. go2rtc's API login (order matters)

go2rtc 1.9.9 reads `api.username` / `api.password` from `GO2RTC_API_USERNAME` / `GO2RTC_API_PASSWORD` in its container
(`deploy/go2rtc.yaml`; `npm run stack:up` passes them from `.env.local`). Both empty = no login (verified on 1.9.9). The web app and the
gateway send the login when both are set; a go2rtc without a login ignores it. So:

1. `node scripts/gen-secrets.mjs` (first time) or `--rotate=GO2RTC_API_PASSWORD`.
2. Restart the gateway (the web app reloads `.env.local` by itself in development; restart it in production).
3. Recreate go2rtc so it reads the new login: `npm run stack:up` (or `stack:up:demo`). Live video and playback reconnect within a minute.

Between steps 2 and 3 everything works (go2rtc without a login ignores the header). After step 3 a process that still has the old
login gets "The video server did not answer" until it is restarted.

Production (review round 1, I-2): the login is required. `npm run stack:up` runs `scripts/check-go2rtc-env.mjs` first, which refuses to
start go2rtc without both values (password 32+ characters); the web app and the gateway refuse to start without them, and both probe
go2rtc once at start-up (`GET /api/streams` without the login must be refused with 401) — a go2rtc container that was started before
the login was set is caught there ("answers without its login: recreate it"). So in production the order is: generate, recreate
go2rtc (step 3), then restart the gateway and the web app (step 2).

## 5. The lock of the service key on NVR logins (production checklist)

The web app keeps the service key for GoTrue's admin API (user administration). So that this key cannot read NVR passwords, lock it
out per organisation once every process runs with its own key:

```sql
-- as the database owner (psql), never through the API (not even the service key may write this table)
INSERT INTO public.security_settings (org_id, service_role_credential_reads, note)
VALUES ('<organisation id>', false, 'services use their own keys')
ON CONFLICT (org_id) DO UPDATE SET service_role_credential_reads = false, updated_at = now();
```

Check it: `SELECT db_role, purpose, count(*) FROM public.vault_reads WHERE at > now() - interval '1 day' GROUP BY 1, 2;` shows only
`media_service` and `monitor_worker` afterwards. Undo (for example to run a script that reads logins with the service key):
the same statement with `true`.

In production the web app does not start while an organisation in use (trial or active) has no such row with `false` (review round
1, M-3; `SELECT * FROM public.security_unlocked_organizations();` lists them). Do this step before the first production start, and for
every new organisation. A refused read leaves a line in the database server log (`drishti: NVR login read refused (role …, recorder
…, purpose …, reason …)`, never a value), since a refused read cannot write `vault_reads`.

## 5a. Sign-in limits and GoTrue (review round 1, I-3, I-4)

The app's own brute-force limit is the sign-in gate (`sign_in_gate`, migration `20261021000035`): per e-mail address + client IP, the
try is counted before the password is checked, in one atomic step; from the third failure the next try waits 5 s, 10 s, … 5 minutes;
a success clears it; nothing is locked. Behind a reverse proxy (`TRUSTED_PROXY_HOPS=1`) a client IP also has a ceiling of 100 tries in
15 minutes over all addresses. GoTrue sees every sign-in as coming from the web server (verified on the local stack: 10,221 password
sign-ins in six hours, every one from the same address), so its own per-IP limit is one counter for the whole installation: set the
hosted project's sign-in rate limit to at least 1000 per 5 minutes (local stack: `[auth.rate_limit] sign_in_sign_ups`). A 429 or
error from GoTrue is answered "Sign-in is busy, please try again in a moment" and is not counted as a wrong password.

## 6. First switch of a running installation to per-service keys

1. `node scripts/gen-secrets.mjs` (adds the four service keys, go2rtc's login and the P2-6 secrets; keeps everything that is set).
2. Restart the gateway and the worker; the development web server reloads `.env.local` by itself (production: restart it).
   Each process logs `service_key_fallback` while it still uses the service key; after the restart no such line appears.
3. Recreate go2rtc (`npm run stack:up` or `stack:up:demo`) so its API asks for the login (section 4).
4. Production only: lock the service key out of NVR logins (section 5), set `DRISHTI_ENV=production` in every process's own env file
   (`deploy/production.env.example`), restrict the files (`drishti-services.ps1 -Action RepairAcl`, above), then start go2rtc, the gateway, the worker and the web app;
   each refuses with a plain line if something is missing.

Back out: remove the new keys from the env file and restart the same processes (development falls back to the service key with a
warning). The database part is undone newest first, each script in its own transaction (review round 1, M-13):
`supabase/rollback/20261021000035_p26_review_fixes_rollback.sql`, then (after P3-1's `20261021000034` rollback)
`supabase/rollback/20261021000033_p26_service_roles_rollback.sql`. Dry run each first with `psql -v ON_ERROR_STOP=1 -v drishti_dry_run=1
-f <file>` (everything is undone at its end); then without `drishti_dry_run`. Only after every process is back on the service key.
