# CityKart Drishti (CKDRISHTI) — Release 1 handover

Written 2026-11-19 for the owner, on branch `feat/drishti-p2-access-location` (local only, never pushed). Last code commit `85fd55f`
(final fix X round 3); this document and the tracker updates came after it and change documentation only.

How to read this: section 1 is the one-page summary. Section 3 is the strict pass/fail table against `docs/drishti/RELEASE-1.md`.
Section 6 lists the decisions only the owner can make. Section 7 is the go-live plan, step by step. The evidence for every claim is
in the repository: the tracker `docs/drishti/DELIVERY-STATUS.md` (its Evidence log is authoritative), the tests under `tests/`, and the
review history `docs/drishti/REVIEW-HISTORY.md`.

> **One sentence.** Release 1 is built, tested on this PC against fake NVRs and synthetic data, and reviewed by independent AI
> reviewers until no Critical or Important finding was open; it has **not** yet run on the production server, on real NVRs at scale,
> through HTTPS, or under a human security review. The supervised pilot at one real location is the first real test.

---

## 1. Summary: what Release 1 is and what it can do today

Release 1 is one web application for authorised live CCTV, recorded playback, basic monitoring of cameras and NVRs, and user rights for
the estate of about 216 retail locations (about 4,630 cameras). The owner's go-live rule (`RELEASE-1.md`): camera feeds, their grouping
and user rights must be complete; everything else comes later.

What works today (on the development PC, with the tests named in section 3):

| Area | What it does |
|---|---|
| Hierarchy | Organisation → Region → Cluster → Location → NVR → Camera. Region and cluster are optional for a location (ruling R-1 amendment). A location can have 2, 3 or more NVRs. Archive instead of delete; restore only under a live parent. |
| Feeds | Live walls by Region, Cluster, Location, NVR, saved group and single camera (sub-streams in the grid, main stream on enlarge). |
| Groups | Static camera lists and dynamic rules (region, cluster, location, NVR, name). A group never widens anyone's access. "Add by name" previews first and can be undone. |
| User rights | Three separate rights: live, playback, export, each at organisation, region, cluster, location, NVR or camera scope, with expiry, revoke with reason, a preview of the effect before saving, and an access review of migrated grants. Export is for IT administrators only (ruling E-1). |
| Revocation | Removing a right, moving a location, or deactivating a person closes open video within 60 seconds (measured 13–15 s at the 15 s production check interval), and tokens issued earlier open nothing. |
| Import | The location/NVR CSV import with a preview, row errors without cell values, all-or-nothing or "skip the rows with problems", a "keep current display names" option, one import at a time. The 216-location estate was imported into the local database (216 locations, 216 NVRs, 4,637 cameras). In production, imported NVRs start with monitoring **off**. |
| Monitoring | Honest camera and NVR states: Live, Offline, "Recorder not reachable" (the NVR, not the camera, is down), "Not checked yet", "Not checked lately", "Switched off". Offline-since, roll-ups by region and cluster on Home and Live, "Check now" with progress, a Monitoring rollout screen (switch monitoring on per location, cluster or region), and an "NVR login problems" list. One shared, database-backed NVR login back-off protects real NVR accounts from lock-out. |
| Playback | Calendar by day, day timeline, 1x playback through the stream path; fast playback 2x–16x as a stream only (no download) for people with the playback right (decision D-L1), with a per-person budget. |
| Sign-in | Two-step sign-in (authenticator app) required in production for administrators and sensitive rights; fresh sign-in (within 10 minutes) for access changes and other sensitive actions; a ceiling on code guessing. |
| Services and data safety | Per-service database roles (web, worker, gateway, media), go2rtc on loopback with its own login, a worker lease so a second or restarted worker cannot corrupt state, durable audit of grants, sign-ins and video sessions, a Health page for app, worker, gateway, database, disk, Vault and last backup. |
| Windows operations | Scripts for Windows services (`deploy/windows/drishti-services.ps1`), one-command update with automatic roll back (`update.ps1`), nightly backup and restore with the Vault root key (`backup.ps1`, `restore.ps1`), secret generation (`scripts/gen-secrets.mjs --production`). |
| Look | Drishti logo and name, visible form fields, light theme, usable at 1366, 1920 and phone width (375 px). |

## 2. Implemented, mocked, not built

### 2.1 Implemented and tested on this PC
Everything in section 1. "Tested" means automated tests against the real local database with fakes on loopback, plus browser journeys
and a load test on this PC. Last recorded clean gates: section 9.

### 2.2 Tested only against fakes or stand-ins (mocked)
| Part | Stand-in used | What a real run must still show |
|---|---|---|
| NVR (Hikvision ISAPI, RTSP) | Fake NVR servers on loopback (`tests/helpers/fake-servers.ts`, `scripts/fake-nvr.ts`) | Real firmware answers, error texts, lock-out policy, many cameras per NVR |
| go2rtc video | A fake go2rtc endpoint (load test), go2rtc's generated test picture (journeys) | Real camera video, real remuxing, real error wording (pilot check `unexplained_failsafe`) |
| ffmpeg (fast playback remux, export) | A fake ffmpeg; ffmpeg is not installed on this PC | Real transcoding/remux (runbook `runbooks/ffmpeg.md`) |
| Windows services, folder locks, the service host | Unit tests of the plans (`-WhatIf`, `-DryRun`) with fake providers | The Windows lab suite on the server (`npm run test:windows-lab`), then a real install |
| Caddy / HTTPS | Header and address tests only | The first run through Caddy (`runbook-tls.md` section 6) |
| Backup and restore | A disposable database on this PC (proof at migration 0043) | A restore onto a second, empty server with the copied Vault key file |
| Load | One PC, fakes, synthetic organisations | Real WAN/SD-WAN, real NVR bandwidth, a smaller production server |

### 2.3 Not built (deferred by `RELEASE-1.md`)
Release 1.1: clip export jobs with quotas and expiring links, reports with Excel, tour mode, timeline zoom, 16x and multi-camera
synchronised playback extras, H.265 transcode, the control centre, incidents and alerts (e-mail, Teams, webhook), recording health,
SD-WAN/SNMP checks. Release 2: the endpoint agent. Release 3: fleet changes, Wi-Fi rollouts, Windows deployment. Code that exists for
later releases (the job engine in memory, the read-only collector, the Wi-Fi inventory) is not part of Release 1 and is not switched on.

---

## 3. Pass/fail table against Release 1

Status words: **Met** (evidence in the repository covers it), **Partly** (some named part is missing or rests only on fakes),
**Not met**. Started from final review C's "Exit criteria status" (at commit `7015426`) and updated for everything fixed since.
Strict rule: anything proven only against lab fakes, or never run on real hardware, says so.

### 3.1 Exit criteria (`RELEASE-1.md` lines 22–26)

| # | Criterion | Status | Evidence | What is missing |
|---|---|---|---|---|
| E1 | Permission tests across user, location, cluster, region, camera and action; playback/export denied despite live; camera-only users see no IT data; multi-NVR locations; revocation ≤ 60 s for open and earlier tokens | **Met (on lab fakes)** | `tests/integration/release1-exit.test.ts` EX-1.1 … EX-1.13; `tests/integration/media-revocation.test.ts`; load test revocation under load 13.1 s (`docs/drishti/evidence/p5/load-test.md`); tracker RX-1, AC-14 | Real video revocation through a real go2rtc and NVR (tracker VA-6) is unproven. Review C noted EX-1.5's title mentions "no calendar" without asserting it, and EX-1.4 counts any non-403/404 as an allowed export (no file served, no ffmpeg). |
| E2 | Pilot-style rehearsal on lab fakes, signing in as each user type | **Partly** | EX-2.1 (through the services); browser journeys (a)–(g), 19 of 19 checks, 75 screenshots (`docs/drishti/evidence/p5/journeys/journeys-report.json`); tracker RX-2 | EX-2.1 signs in through the auth client, not the sign-in page; there is no manager user type in it; the journeys cover the screens for some roles only. The journeys ran on 2026-10-23, **before** final fixes X and Y and the clean-up changed several screens; they were not re-run. |
| E3a | Typecheck, lint, unit, integration and production build clean | **Met** | Section 9 (controller run at `0b15bea`; builder run at `85fd55f`); tracker VA-1 | The final rerun at the last commit is recorded by the controller (section 9). |
| E3b | Browser journeys | **Partly** | As E2 | Not re-run after the final fixes. |
| E3c | Load test published with workload and limits | **Met (on one PC, fakes)** | `docs/drishti/evidence/p5/load-test.md` (120 video sockets for 10 minutes, 0 failures, start p95 184 ms; metadata at 216 locations, p95 under 140 ms per screen; worker round 16 s for 216 fake NVRs); tracker VA-10 | Real NVRs, real video, real WAN, a production-size server; see its "Not measured" section. |
| E3d | Backup/restore evidence | **Partly** | `tests/integration/backup-restore.test.ts`; `docs/drishti/evidence/p5/backup-restore.md`, `backup-restore-proof.json` (224 of 224 Vault secrets decrypt); tracker SO-13 | The published proof is at migration 0043 and predates the restore-script fixes and migrations 0044–0052. A restore onto another machine with the copied Vault key file was never run (`runbooks/backup-restore.md`: "Not exercised"). |
| E3e | Independent security review with no open Critical/Important findings | **Partly** | Independent AI reviews of every package and three whole-branch final reviews (A, B, C), then the pre-handover review and the X round 3 review: every Critical and Important finding is fixed, the last reviews approved (`docs/drishti/REVIEW-HISTORY.md`) | All reviewers were AI agents, not human penetration testers. `release1-exit.test.ts` "EX-3.4" is still `it.todo`; tracker RX-3 stays `Partially implemented`. Recommendation: an external security review before wide rollout. |
| E4 | Honest limits stated; the pilot is the first live step, then rollout by cluster | **Met (documents)** | `RELEASE-1.md` line 26; load-test "Not measured"; EX-4.1; this document (sections 4, 5); `runbooks/monitoring-rollout.md`; tracker RX-4 | Nothing beyond keeping these documents current. |

### 3.2 Scope items 1–7 (`RELEASE-1.md` lines 6–12)

| # | Scope item | Status | Evidence | What is missing or rests on fakes |
|---|---|---|---|---|
| 1 | Hierarchy and inventory: tree, multi-NVR locations, admin screens, "find cameras for all locations", CSV import with row errors at estate size, archive not delete, the word "Location" | **Met (fakes for NVR contact)** | `tests/integration/p2-5c-2-import.test.ts` ("a 216-location file … imports in one go"), `multi-nvr-e2e.test.ts`, `final-cleanup-db.test.ts`, `tests/unit/discover-all-paging.test.ts`; screenshots `docs/drishti/evidence/p2-5c/`, `p2-5c-2/`; the estate imported locally (tracker AL-7, LG-27) | "Find cameras" was run against fake NVRs only. The owner's decision on display names (section 6, D1). |
| 2 | Access and users: capabilities × scopes, overlap rules, preview, expiry, revoke with reason, access review, operator role, super administrator, export only for IT administrators, ≤ 60 s revocation, MFA and fresh sign-in | **Met (MFA enforcement checked; production switch is a go-live step)** | `tests/integration/access-model.test.ts`, `release1-exit.test.ts` EX-1, `mfa-gating.test.ts`, `mfa-totp.test.ts`, `final-fix-y-db.test.ts`, `tests/unit/production-checks.test.ts`; tracker AC-*, SO-1 | Two-step sign-in is enforced by start-up and Health checks in production, but the administrators must enrol first (section 6, D8). Real TOTP was verified on the local auth server only. |
| 3 | Camera feeds: walls by region/cluster/location/NVR/group/camera, static and dynamic groups, playback calendar and timeline, stream-only fast playback, IST and per-NVR clock offsets, bounded concurrency, stopping hidden/abandoned streams, viewing audited | **Partly** | `live-rollups.test.ts`, `live-concurrency.test.ts`, `live-wall-cleanup.test.ts`, `groups.test.ts`, `groups-dynamic.test.ts`, `fast-playback.test.ts`, `fast-playback-limits.test.ts`; tracker CC-1 … CC-11, LG-* | Everything video-related is proven with fakes only (CC-1, CC-3 "awaiting hardware validation"). CC-9 (bounded concurrency) and CC-10 (stopping abandoned streams) are `Partially implemented`: no per-NVR caps, the fast-playback pools are per web process, go2rtc producers stay registered until pruned when idle (section 6, D5). |
| 4 | Monitoring basics: honest states, offline-since, roll-ups by cluster/region, check-now, stale handling | **Met (fakes), one owner decision open** | `live-rollups.test.ts`, `check-now.test.ts`, `monitor-db.test.ts` ("reads the check request and tracks the progress of a run"), `nvr-login-state-db.test.ts`, `gateway-login.test.ts`, `tests/unit/monitor-rollout.test.ts`; tracker MC-4, LG-23 | Review C M-4 (Offline never becomes "Not checked lately") is open by design (section 6, D2). All checks ran against fake NVRs. |
| 5 | Security and operations: TLS, strict CSP, shared rate limits, per-purpose secrets with rotation, least-privilege roles, go2rtc locked down, worker lease, durable audit, health pages, Windows services with auto-start and one-command update, tested backup/restore incl. Vault key, media load test | **Partly** | `worker-lease.test.ts`, `health.test.ts`, `tests/unit/ops-health.test.ts`, `tests/unit/windows-scripts.test.ts`, `tests/unit/prod-env.test.ts`, `backup-restore.test.ts`, load test; tracker SO-*, LG-36, LG-37 | Caddy/HTTPS never run (SO-8 partial); the Windows lab suite and a real service install never run (LG-37 partial, LG-36 and SO-14 awaiting hardware validation); restore with the Vault key on another machine never run (SO-13 partial); durable audit has no independent tamper-evidence checkpoints (SO-11 partial). |
| 6 | Look: logo and name, visible fields, light theme, desktop and phone, rendered checks at 1366, 1920 and phone width | **Met** | `tests/unit/brand.test.tsx`; screenshots `docs/drishti/evidence/p3-0/`, `p5/journeys/` (1366, 1920, 375); tracker BR-* | BR-1 (follow the Asset Management design language) stays `Partially implemented`. The journey screenshots predate the final screen fixes. |
| 7 | Documentation: administrator guide, runbooks, architecture, tracker | **Met** | `docs/drishti/admin-guide.md`, `admin-guide-import.md`, `runbooks/*`, `runbook-tls.md`, `ARCHITECTURE.md` (section 13 current), `DELIVERY-STATUS.md`, this document, `REVIEW-HISTORY.md` | Keep them current after the pilot. |

**Overall:** Release 1 is ready for a **supervised pilot** at one real location, not for estate-wide production. The open parts are
real-hardware and real-server checks, a human security review, and the owner's decisions in section 6.

---

## 4. What was NOT validated, and why

| Not validated | Why | Where it gets checked |
|---|---|---|
| Real NVR behaviour beyond a few live views at two real locations (the build ledger records live video from one real store) | The owner allowed read-only use of the real NVRs locally, but the monitoring worker was never started against the real estate and no real playback/discovery run was recorded | The supervised pilot (`runbooks/monitoring-rollout.md`) |
| Real ffmpeg transcoding/remux for fast playback and export | ffmpeg is not installed on the development PC; tests use a fake | `runbooks/ffmpeg.md` on the server, then the pilot |
| H.265 cameras and browser decoding of many tiles | No H.265 source and no viewing PCs in the tests | Pilot; H.265 transcode is Release 1.1 |
| Real WAN / SD-WAN / VPN links to the stores | Everything ran on loopback on one PC | Pilot, then rollout by cluster |
| The Windows lab suite (`npm run test:windows-lab`) | It changes access lists, makes junctions and compiles C#; the development PC's antivirus quarantines such test helpers and no exclusion can be added | On the production server before install (section 7, step 1) |
| A real server install as Windows services, reboot, sign-out, log roll | No server was available; nothing was installed on the development PC | `runbooks/windows-services.md` section 7 |
| Caddy / HTTPS in practice | No certificate and no server | `runbook-tls.md` section 6 |
| go2rtc's real wording for a refused login | Assumed "wrong user/pass" (go2rtc 1.9.9); a fake go2rtc was used | Pilot check: search the gateway log for `unexplained_failsafe` |
| Load numbers | Fakes on one fast PC (24 cores, 128 GB); a production server will be smaller | Watch the Health page during the pilot |
| Restore onto another machine with the copied Vault key | Would need a second, empty server | `runbooks/backup-restore.md` section 5a/6 |
| Human security testing | All reviews were by AI agents | External review recommended before wide rollout |

---

## 5. Known limits and residual risks

From the review chain (details in `docs/drishti/REVIEW-HISTORY.md` and `docs/drishti/DECISIONS.md`):

| # | Limit or risk | Source | Effect / what to do |
|---|---|---|---|
| L1 | Fast-playback and export pools are per web process; no per-NVR or per-organisation caps | CC-9 | Fine with one web process (the planned layout); revisit if more are run |
| L2 | go2rtc producers stay registered until pruned when idle; no producer clean-up tests | CC-10 | Some extra NVR sessions after a wall closes; watch NVR load in the pilot |
| L3 | "Offline" and "Recorder not reachable" never become "Not checked lately"; the Live page has no monitoring banner | Review C M-4 | A camera down for days on an NVR whose login fails since still says "Offline since …" (owner decision D2) |
| L4 | Camera uptime counts "Recorder not reachable" time as camera downtime | Review C M-3 | Uptime figures are pessimistic when NVRs drop |
| L5 | "Check now" is estate-wide for anyone with the monitoring-operate right on one location | Review C M-7 | Cannot cause refused logins (shared back-off), but adds load |
| L6 | An unattended video wall stops and signs out after the idle limit (8 hours for operators, 60 minutes for administrators) | DECISIONS "Behaviour change P4-L1" | Control-room screens need a touch or a decision (owner decision D4) |
| L7 | Imported display names are "CODE - City"; the existing 216 local locations keep their current names until the owner decides | Ruling R-1 amendment | Owner decision D1; the import preview has "keep current display names" |
| L8 | Double-click on a live tile enlarges it (main stream), not playback as in the legacy hub | Decision point LG-4 | One-line change if the owner wants the legacy gesture (D3) |
| L9 | The web app still holds the full service key, for the auth server's admin API (password resets, people) | ARCHITECTURE 12.1 item 6; ruling FC-1 | Whoever has the web server's env file can reset passwords; keep `web.env` locked (the install does) |
| L10 | A key (JWT) cannot be revoked alone; cutting one off means revoking its role and rotating the project JWT secret | `runbooks/secret-rotation.md` section 3 | Disruptive; only for a real exposure |
| L11 | The Vault root key is not in the database backups; a restore elsewhere without the key file loses every NVR password | `runbooks/backup-restore.md` section 2 | Back the key file up separately, encrypted, and keep a sealed paper copy |
| L12 | Direct inventory writes by the web role are now limited to granted columns and checked by a trigger; the service key still has DELETE on the five inventory tables | Ruling FC-3; pre-handover m-4 | A script holding the service key could hard-delete; keep the service key off any machine but the server |
| L13 | Two-step sign-in: whoever knows a privileged person's password before that person sets up an app can bind their own; one app per person, no recovery codes, no e-mail notice | `runbook-tls.md` section 5 | Hand out one-time passwords in person; keep at least two super administrators |
| L14 | NB-12 residual: an NVR never proven and with no video in 10 minutes, where two cameras fail with the same unknown non-network text, enters the "unexplained" state and every path waits (15 minutes, doubling to 6 hours) until a check proves the login or Try again | DECISIONS NB-12 | The pilot check finds it; look for `unexplained_failsafe` |
| L15 | X round 3 review M-1: saving a new NVR password does not clear "last played video", so streams still running on the old password can make the new login's unexplained failures count as one camera's fault for up to 10 minutes after the last frame | `x-round3-review.md` (Approved) | Short window; the other checks still prove the new login |
| L16 | X round 3 review M-2: the "camera's own failure" rule hides an unknown-wording refusal while any camera keeps playing plus 10 minutes, and the network-failure pattern is broad (EOF, TLS, `dial tcp`, a close without a word): an NVR that just drops the connection on a bad password is never counted as refused by the gateway | `x-round3-review.md` | Other checks still catch it: the open path re-proves the login every 10 minutes, go2rtc's "wrong user/pass" refuses at once, and the worker's own login check |
| L17 | X round 3 review M-3: the gateway's dead-camera test would also pass on the old gateway code (its fake registry decides; the database test proves the fix), and nothing tests that a stream keeps reporting video while it plays | `x-round3-review.md` | Test gap only; the database test `nvr-login-state-db.test.ts` carries the proof |
| L18 | X round 3 review M-4: if the fail-safe fires after an earlier real refusal, it keeps that NVR's level and relabels it "unexplained" on Monitoring, hiding the earlier real refusal | `x-round3-review.md` | Check the audit log and gateway log for the NVR before changing its password |
| L19 | X round 3 review N-1: the "Try again" audit row records "refused" even for the "unexplained" state | `x-round3-review.md` | Cosmetic in the audit log |
| L20 | Pre-handover minors left: the connection test can say "accepted the login" when the NVR never asked for the password (m-1); video does not settle an unproven login on a slow link, so a wall can stay at one tile (m-2); import stamp misses a value moving between two adjacent empty columns (m-3); a live location can point at an archived parent location or uplink (m-5); chunked-body refusal not proven end-to-end (m-6); group "undo" is all-or-nothing (m-7) | `pre-handover-review.md` | None blocks a pilot |
| L21 | Durable audit is append-only in the database but has no independent tamper-evidence checkpoints | SO-11 | Later package |
| L22 | One worker lease for all targets; no sharding; two worker machines never run | SO-14, `worker-lease.md` section 7 | One worker for Release 1 |
| L23 | The database host: Docker Desktop is not suitable for an unattended server | `runbooks/windows-services.md` section 1 | Owner decision D7 |
| L24 | A leftover test organisation (217 locations) remains in the local development database | Final clean-up report | Development data only; never copied to production |

---

## 6. Decisions the owner must make

Each with a recommendation. Record the answer in `docs/drishti/DECISIONS.md`.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Rename the 216 locations to "CODE - City" (for example "ABC - Town"), or keep today's names | **Rename at the production import** (it is the agreed format and searching by city is easier); use "keep current display names" only when re-importing over names someone has already edited. |
| D2 | Review C M-4: should "Offline" and "Recorder not reachable" turn into "Not checked lately" when no fresh check arrives? | **Yes, for the pilot onwards**: a state days old that nobody re-checked should not look current. Small change; until then, read "Offline since" together with the NVR login problems list. |
| D3 | Double-click on a live tile: enlarge (today) or open playback (legacy) | **Keep enlarge**: most viewers have live only, and playback is one click on the tile's button. |
| D4 | The idle limit for unattended operator walls (8 hours today) | **Keep 8 hours for people; create dedicated "display screen" accounts** with live-only rights for control-room walls, and decide later whether those get a longer limit (`SESSION_IDLE_MINUTES`). |
| D5 | Accept CC-9 / CC-10 limits (per-process pools, no per-NVR cap, go2rtc producers pruned when idle) for Release 1 | **Accept for Release 1** with one web process; record it; revisit after the pilot measures NVR load. |
| D6 | Which locations and clusters form the pilot | **One location** with a single, healthy NVR, reachable over a good link and with a cooperative store IT contact; **then its cluster**. Avoid a multi-NVR location for the very first day. |
| D7 | Production database host | **Not Docker Desktop.** Self-hosted Supabase under Docker Engine on a Linux host (or WSL2 with Docker Engine as a system service), or a hosted Supabase project (then plan the Vault key limits in L11). Test an unattended reboot before go-live. |
| D8 | When to switch two-step sign-in on | **From the first production start** (a freshly marked production database enforces it by default): create each administrator, have them sign in and set up the app at once, in person. Only use the audited opt-out if an administrator cannot enrol yet. |
| D9 | Push to `main` and how (section 8) | **Only after the pilot's first day passes**, as a fast-forward of the reviewed tip, with a tag. |
| D10 | External security review | **Commission one before rollout beyond the pilot cluster.** |
| D11 | Read-only NVR accounts | **Create a read-only (viewer) user on every NVR before the production import** (ruling R-1 rule 3); the estate list uses administrator accounts. |

---

## 7. Go-live plan, step by step

Follow the runbooks for the details; this list gives the order and the checks. Never paste secrets into chat, tickets or this repository.

### Step 1 — Lab verification on the production server (before installing anything)
1. On the server, in a checkout of the release with `npm ci` done, in a **normal** (not elevated) PowerShell:
   `$env:DRISHTI_WINDOWS_LAB = '1'; npm run test:windows-lab` (`runbooks/windows-services.md` section 7.0).
2. Every test must pass. Two are a **hard gate**: "-NoWalk refuses a junction or a hard link in a service folder" and "Windows passing a
   folder's entries down never goes through a junction inside it (measured)". If either fails, **stop** and decide before installing.
3. Record the result with the date and Windows version in the tracker (LG-37, SO-11, SO-12).

### Step 2 — Database host and tools
1. Set up the database host chosen in D7. Reboot it unattended and confirm the database comes back by itself.
2. Node.js 20+, Git, go2rtc 1.9.9 and Caddy for Windows, each downloaded with the owner's approval and checked by SHA-256
   (`runbooks/windows-services.md` section 4, item 1). ffmpeg per `runbooks/ffmpeg.md`.

### Step 3 — Secrets and install
1. Generate the env files: `node scripts\gen-secrets.mjs --production --out-dir C:\Drishti\config ...` (`windows-services.md` section 4,
   item 2). Fill the addresses and keys in the locked files only.
2. The configuration file, then `drishti-services.ps1 -Action Install -WhatIf`, then for real, then `-Action Audit` must say
   `access rules: ok` (items 3–5).
3. Production checklist (item 6): service key locked out of NVR logins (`runbooks/secret-rotation.md` section 5), two-step sign-in
   (`runbook-tls.md` section 5), go2rtc's login (`secret-rotation.md` section 4), Caddy and the certificate (`runbook-tls.md` sections
   1–3 and 6). Confirm `gateway.env` has `TRUSTED_PROXY_HOPS=1` behind Caddy.

### Step 4 — First production start
1. Start go2rtc, then run the first release with `update.ps1 -SourcePath <checkout> -DryRun`, then for real (`windows-services.md`
   item 8). The update refuses a test-seeded database and **marks the database as production**; from then on two-step sign-in is on by
   default.
2. Create the organisation and the first super administrators **after** that. Each signs in and sets up the authenticator app at once.
   Keep at least two super administrators. If the web app refuses to start about two-step sign-in, follow the line it prints
   (`runbook-tls.md` section 5, item 2).
3. If the pilot starts without monitoring, set `WorkerExpected = $false` in the configuration and `DRISHTI_WORKER_EXPECTED=false` in
   `web.env`, so updates do not treat the stopped worker as a failure.
4. Health page (`/admin/health`): every check OK.

### Step 5 — Import and monitoring rollout (`runbooks/monitoring-rollout.md`)
1. Import the estate (Admin → Import), with read-only NVR accounts (D11) and the naming choice of D1. In production, imported NVRs
   start with monitoring **off**. Monitoring → Monitoring rollout → "Every NVR of the organisation" → Switch off; the counts must read 0 on.
2. Ask the pilot store's IT contact for the NVR lock policy and confirm the saved account is not used by the store.
3. **Pilot:** switch on one location. Within 5 minutes its cameras show as checked. Open its wall and play back a recording. The worker
   contacts at most 10 never-checked NVRs per round (staggered start).
4. Pilot checks on real hardware: go2rtc's wording for a refused login, a viewer account's 403 on channel status, the lock policy.
   Search the gateway log for `unexplained_failsafe`; lines with `upstream_unexplained` (one camera, normally a dead channel) and
   `upstream_network` (network) are expected and harmless.
5. **Then the pilot's cluster**, then each further cluster or region one at a time, checking "NVR login problems" after each.

### Step 6 — Backup and restore rehearsal
1. Schedule the nightly `backup.ps1` (`runbooks/backup-restore.md` section 4). Back up the Vault key file separately with
   `-IncludeVaultKey` to a different, encrypted medium, plus a sealed paper copy.
2. Rehearse a restore into a disposable database (section 5a). If at all possible, rehearse once onto a second, empty server with the
   copied key file (never done so far). Record the result (SO-13).

### Step 7 — Roll-back plan
- A failed update rolls itself back (`runbooks/update-rollback.md` section 2): release and database. A server problem (disk, worker,
  clocks, backup) keeps the new release and says so (exit code 3).
- Rolling back by hand: `update-rollback.md` section 3. Note what is lost: everything written after the update's own backup.
- If the pilot goes badly: switch monitoring off for the pilot location (Monitoring rollout), stop the services
  (`runbooks/startup-shutdown.md`), and keep the legacy hub in use.

### Step 8 — The first week: what to watch
| Where | What |
|---|---|
| Health page, daily | Every check OK: database, Vault, gateway, worker lease and clock, disk, last backup (fails after 26 hours), two-step sign-in |
| Monitoring → NVR login problems | Any NVR listed: check the password on the NVR, press Try again **once**; three refusals in 30 minutes pause it |
| Audit log | Grants, revocations, sign-ins, two-step resets and unlocks, monitoring switches |
| Gateway log (`C:\Drishti\logs\DrishtiGateway\`) | `unexplained_failsafe` (report every hit), the volume of `upstream_network` |
| `drishti-services.ps1 -Action Status` | Services running, `access rules: ok` |
| Incidents | `runbooks/incidents.md` (NVR-down storm, stuck worker, gateway not answering) |

---

## 8. If the owner pushes to `main`

**Nothing is deployed automatically.** There is no CI or deployment workflow in this repository (no `.github` folder). A push only
publishes the code; the server is changed only by someone running `update.ps1` on it.

The branches are local and stacked; each is an ancestor of the next (checked with `git merge-base --is-ancestor`):

| Order | Branch | Tip | Content |
|---|---|---|---|
| 0 | `main` | `9ad34d1` | Two documentation commits |
| 1 | `feat/plan-1-foundation` | `fe6d362` | Project, auth, roles, inventory, CSV import |
| 2 | `feat/plan-2-monitoring` | `60db30f` | Probes, state machine, worker, discovery |
| 3 | `feat/plan-3-live-feeds` | `8bdc09c` | Groups, gateway, live wall, playback; Drishti directive and tracker |
| 4 | `feat/drishti-p2-access-location` | this branch | Release 1 (266 commits ahead of `main`) |

Recommendation (the owner decides; nobody has pushed or merged anything):
1. Wait for the controller's final gate rerun (section 9) and, ideally, the pilot's first day.
2. Tag the reviewed tip (for example `release-1.0.0`).
3. Because `main` is an ancestor of the tip, `main` can be **fast-forwarded** to the tip: one step brings all four branches in, in
   order, with their history intact. Do not squash: the commit messages are the evidence trail cited by the tracker.
4. The local `main` tracks a remote branch that git reports as gone; check the remote before the first push.
5. Never push `.env*` files, the real estate CSV, or `.superpowers/` (git-ignored; `REVIEW-HISTORY.md` is the copy in the repository).

---

## 9. Gate results

```
Gate results at commit 0b15bea (controller run, recorded 2026-11-19)
  npm run typecheck          clean
  npm run lint               clean
  npm run test:unit          177 files, 2248 passed
  npm run test:integration   94 files, 1081 passed, 3 skipped, 1 todo, 0 failed
  next build                 passed (separate distDir)

Builder run at commit 85fd55f (final fix X round 3, Evidence log): typecheck and lint clean; unit 177 files, 2248 passed;
integration 94 files, 1090 passed, 3 skipped, 1 todo; build passed.

Commits after 85fd55f change documentation only (this handover, REVIEW-HISTORY.md, the tracker, ARCHITECTURE.md section 13, README).

Final rerun: <pending>
```

The rerun at the final commit is recorded by the controller in the tracker's Evidence log (`docs/drishti/DELIVERY-STATUS.md`). The 3
skipped tests are conditional ones (for example the real-ffmpeg tests in `fast-playback.test.ts` and `vod.test.ts`, which skip
because ffmpeg is not installed on the development PC); the 1 todo is EX-3.4, the independent security review.
