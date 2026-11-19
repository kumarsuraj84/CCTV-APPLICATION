# CityKart Drishti — Release 1 review history (the evidence chain)

Why this file exists: the builders' reports, the review files and the controller's ledger live in `.superpowers/sdd/drishti/`, which
is git-ignored and therefore **not in the repository**. This file is the copy that is: for every Release 1 work package, the review
rounds, their verdicts, the counts by severity, the key findings in one line each, and how they were fixed (commits from `git log`).
No secrets, passwords, addresses or real CSV contents appear here.

**Who reviewed.** Every reviewer was an **AI agent** (independent Claude Opus or Sonnet reviewer sessions, each given only the brief,
the diff and read access; none was the builder). They were not human penetration testers. Their reviews were read-only: they read
code, ran single test files, typecheck and lint, and ran read-only SQL against the local database. **Recommendation: commission an
external, human security review before rolling Release 1 out beyond the pilot cluster** (tracker RX-3; `release1-exit.test.ts`
"EX-3.4" is still a todo).

Severity words are the reviewers' own: **Critical** (must not ship), **Important** (fix before the package is accepted), **Minor**
(fix later or accept). "Approved" means no open Critical or Important finding. Where a count was not written in the review file, the
cell says so. Reviews marked "ledger" were recorded only in the controller's ledger `progress.md` (no separate review file).

Sources (git-ignored): `.superpowers/sdd/drishti/<package>-review.md`, `-rereview*.md`, `final-review-A/B/C.md`,
`final-fix-X-review.md`, `final-fix-Y-review.md`, `pre-handover-review.md`, `x-round3-review.md`, `release1-cleanups-review.md`,
`progress.md`. In the repository: the tracker's Evidence log (`docs/drishti/DELIVERY-STATUS.md`) and the rulings in
`docs/drishti/DECISIONS.md`.

---

## Overview

| Package | Content | Rounds | Final verdict |
|---|---|---|---|
| P2-1 | Capability access model in the database | review + fix round (ledger) | Accepted by controller |
| P2-2 | Enforcement across the app | review + fix round (ledger) | Accepted by controller |
| P2-3 | Access administration screens | review + fix round (ledger) | Accepted by controller |
| P2-4 | Session registry, ≤ 60 s revocation | review + re-review | Approved |
| P2-5a | Locations, recorders, assets model | review + fix round (ledger) | Accepted by controller |
| P2-5b | The app on the recorder model | review + re-review | Approved |
| P2-5c-1 / P2-5c-2 | Admin screens, import, discover-all, Wi-Fi inventory | review, combined review, re-review | Approved |
| T-1 | "Store" → "Location" wording and routes | review | Approved |
| P2-6 | Service roles, outbound restriction, shared limits, secrets | review + re-review | Approved |
| P2-7 | Worker lease and fencing | review + re-review | Approved |
| P3-0 | Brand quick pass (logo, name, visible fields) | controller browser check | Accepted by controller |
| P3-1 | Shell, multi-factor, fresh sign-in, CSP, TLS readiness | review + re-review | Approved |
| P4-L1 | Live walls, roll-ups, groups navigation | review + re-review, 2 fix rounds | Accepted by controller after fix round 2 (no second re-review) |
| P4-L2 | Playback essentials, stream-only fast playback | review + re-review | Approved |
| Release 1 clean-ups | Carried minors from all packages | review (fixed through P5.4 round 2) | Closed by P5.4 re-review 2 |
| P5.4 | Windows services, update, backup/restore, health, audit | review + 4 re-reviews, 5 fix rounds | Last re-review: Needs fixes (N-4r), fixed in round 5, then checked by the pre-handover review |
| P5.5 | Load test, browser journeys, exit tests | covered by final reviews A/B/C | — |
| Final reviews A / B / C | Whole branch: access/DB; auth/sessions/media/secrets; worker/data/screens/ops | one round each | Needs fixes (A 1, B 3, C 14 Important) |
| Final fix X | NVR login safety and rollout | review, round 2, round 3 review | Approved (round 3) |
| Final fix Y | Auth, MFA, SQL guards, admin, import | review | Approved |
| Final clean-up | Y-R minors and leftover C minors | pre-handover review | — |
| Pre-handover review | Delta since the final reviews | one round | Needs fixes (1 Important) → fixed by X round 3 |

---

## P2-1 — capability access model (ledger)
| Round | Verdict | Critical / Important / Minor | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 4 / about 7 | I-1 `grant_access` could narrow access (union rule broken; preview disagreed); I-2 the interim editor resurrected expired or future grants as permanent; I-3 the legacy migration re-inserted revoked grants; I-4 the editor hid organisation-wide migrated grants | Commit `ea80ba9` (migration 0012); accepted by the controller with tests |

Build commits `e4c6e76`, `2e5e3a4`.

## P2-2 — enforcement (ledger)
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 2 / 9 | I-1 CCTV-only viewers could read NVR check errors through the API (masking only in the page); I-2 playback errors showed NVR login internals to CCTV viewers; M-3 ruling: the file path needs export AND playback | Commits `3fe957a`, `ea5822f` (migration 0014: column revoke and a reasons view, neutral texts) |

Build commits `34b8809`, `5527c28`.

## P2-3 — access administration (ledger)
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 2 / 14 | I-1 "last active super administrator" checked only in the app (race) → SQL trigger; I-2 demotion left `admin.*` rights on a non-administrator; M-1 reactivation review leaked grant lists; M-5 preview token → HMAC | Commits `750eab3`, `f93c0ac` (migration 0017) |

Build commits `78fd7d8`, `ce55736`, `0a33411`.

## P2-4 — session registry and ≤ 60 s revocation
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Spec Approved; quality Needs fixes | 0 / 1 / 12 | I-1 the deferred re-check trigger had no bound on its cost per transaction (a bulk change could make a commit very slow); tile reconnect; a false green on the monitoring panel | Commits `14ed51c`..`732c578` (migration 0032; commit-time re-check 205 s → 0.4 s) |
| Re-review | **Approved** | 0 / 0 / 4 new | N1–N3 carried to the clean-ups | Release 1 clean-ups (migration 0044) |

Build commits `c8be7c0`..`29039e4` (migration 0029); measured revocation 14.8 s at the 15 s interval.

## P2-5a — locations, recorders, assets (ledger)
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 2 / 16 | I-1 an asset-scope grant on an NVR asset exposed recorder-level IT data; I-2 negative tests had been loosened | Commits `87e70dd`, `e2017d7` (migration 0022) |

Build commits `1626224`, `119e532` (migrations 0018–0021).

## P2-5b — the application on the recorder model
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 5 / 11 | I-1 discovery made a second identity for a camera that moved channel on the same NVR; I-2 false matches blocked cameras on a second NVR; I-3 placeholder cameras came back after archive; I-4 an NVR of an inactive location was never monitored after activation; I-5 tests did not pin these | Commits `c18668e`..`6512220` (migration 0025) |
| Re-review (Sonnet) | **Approved** | 0 / 0 / 6 new | All five Important fixed with biting tests | Minors carried to P2-5c-1 |

Build commits `41ee9f0`..`9213a38` (migrations 0023/0024, contract migration).

## P2-5c-1 and P2-5c-2 — admin screens, import, discover-all
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| P2-5c-1 review (Opus) | Needs fixes | 0 / 7 / 13 | I-3 "Find cameras" bypassed the login back-off; I-4 a changed NVR address kept and sent the old password to the new host; I-5 merge buttons acted on one click; I-6 a name-only group rule could probe camera names; I-7 group counting recomputed everything twice | Commits `380097c`..`f45656f` (migration 0027) |
| Combined review (5c-1 fixes + 5c-2) | Needs fixes | 0 / 4 / 16 | A-N1 merge confirmation could name the wrong camera; B-I1 the CSV reader merged rows and moved one row's password onto another location; B-I2 messages repeated raw cells (a password could show in the preview); B-I3 the import preview was a password oracle | Commits `8261bcf`..`255bde7` (migration 0030), `400cd32`..`bd00cad` (migration 0031) |
| Re-review (Sonnet) | **Approved** | 0 / 0 / 14 minors noted | Minors carried to T-1 | T-1 |

Build commits `5d42025`..`0ca7757` (0026), `c58d8c4`..`1160c90` (0028).

## T-1 — "Location" wording
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Sonnet) | **Approved** | 0 / 0 / 5 low + 4 info | Redirects safe; guard test sound; stale sentences | Release 1 clean-ups (`3973581`, `95b077a`) |

Build commits `bf81431`..`c4a975e`.

## P2-6 — hardening, service roles, secrets
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Spec Approved; security Needs fixes | 0 / 4 / 16 | I-1 worker and gateway silently kept the full service key (production check depended on NODE_ENV); I-2 go2rtc's API login failed open; I-3 the sign-in delay was check-then-act; I-4 every auth-server error counted as a wrong password (global lock-out) | Commits `29f9255`..`9956ae7` (migration 0035) |
| Re-review | **Approved** | 0 / 0 / 4 new | All four Important fixed with tests | Clean-ups |

Build commits `e3f8c68`..`ab60a9b` (migration 0033).

## P2-7 — worker lease and fencing
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Spec Approved; quality Needs fixes | 0 / 1 / 9 | I-1 the SQL late-result guard trusted the worker's clock (a skewed clock could freeze targets) | Commits `19bff8b`..`5ff5154` (migration 0039) |
| Re-review (Sonnet) | **Approved** | 0 / 0 / 5 | Residuals R-1..R-5 | Clean-ups |

Build commits `cb5739a`..`6d37b98` (migration 0036).

## P3-0 — brand quick pass
No independent review; the controller checked the sign-in page in a browser (full logo, visible fields). Commit `eef5b3b`;
screenshots `docs/drishti/evidence/p3-0/`.

## P3-1 — shell, multi-factor, fresh sign-in, CSP
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 6 / 15 | I-1 auth cookies not HttpOnly; I-2 a commit carried another builder's deletion (HEAD did not build); I-3 fresh sign-in was per-action opt-in with gaps; I-4 the first enroller could bind their own authenticator; I-5 app-side limits bypassable via the auth server; I-6 the only end-to-end second-factor test skipped silently | Commits `d26b7ac`..`a0904eb` (migration 0037) |
| Re-review (Sonnet) | **Approved** | 0 / 0 / 4 residuals | I-4 password-holder variant mitigated and documented | Clean-ups |

Build commits `787d200`..`1eb1903` (migration 0034).

## P4-L1 — live walls and roll-ups
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 3 / 13 | I-1 the per-person stream cap could be exceeded (renewals, unused tokens); I-2 wall activity kept idle sessions alive; I-3 NVR-down cameras read "Recorder not reachable" on Live but "offline" on Locations (MC-4) | Commits `99cc8b2`..`9a17330` (migration 0040) |
| Re-review 1 | Needs fixes | 0 / 1 / 5 | N-1 leaving a wall left its tokens counting for 90 s | Commits `29dfb6e`..`3dfedfa` (migration 0043) |
| After fix round 2 | No second independent re-review; accepted by the controller with the round-2 tests | — | Double-click stays "enlarge" (owner to confirm) | — |

Build commits `e4a13c7`..`305bca8` (migration 0038).

## P4-L2 — playback essentials
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | 0 / 3 / 7 | I-1 a playback-only viewer could dump a recording at line speed; I-2 paused viewers held the 8 server-wide slots; I-3 the oldest-recording hint blocked navigation | Commits `edd131f`..`b5ded6d` (migration 0042: signed speed, per-person budget, one fast stream) |
| Re-review (Sonnet) | **Approved** | 0 / 0 / 6 new | — | Clean-ups |

Build commits `26bb238`..`823fd56`.

## Release 1 clean-ups
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Sonnet) | Needs fixes | 0 / 1 / 8 | Important 1: the test-organisation guard could be bypassed by renaming to `demo-sample-data`; Minor 2: nothing checked the test fixture switch was off in production | P5.4 fix round 2 (`93cb9df`, migration 0046); confirmed fixed by P5.4 re-review 2 |

Build commits `3a67370`..`e879b23` (migration 0044).

## P5.4 — Windows operations
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | Needs fixes | **2** / 7 / 15 | C-1 `update.ps1` could not stop or start services (every real update would fail); C-2 install, config and backup folders were never locked (privilege escalation, secrets readable); I-1 the database roll back never ran; I-2 database password on a command line; I-5 audit append-only bypass with the service key | Commits `1b235fe`, `428c36d`, `bdb5ba9` (migration 0045) |
| Re-review 1 | Needs fixes | 0 / 2 / 8 + nit | N-1 folder locks kept foreign owners and entries; N-2 fixture switch could be on in production | Round 2: `93cb9df`, `94030f0`, `85bf5b5` (migration 0046) |
| Re-review 2 | Needs fixes | 0 / 1 / 6 | N-3 the ACL reset followed junctions (an ordinary user could redirect it across the disk) | Round 3: `6e5206e`, `4922dee`, `4b8cfeb` (migration 0047; antivirus-safe default tests) |
| Re-review 3 | Needs fixes | 0 / 2 / 6 | N-4 a junction swapped in between walk and reset; N-5 Audit reported the legitimate `app\current` | Round 4: `aef8e19`, `d5d4dde`, `c1bdc68` |
| Re-review 4 | Needs fixes | 0 / 1 (conditional) / several | N-4r the lock of a service-writable folder depended on unverified Windows propagation | Round 5: `a1679d6`, `f6998a2`, `6d1b1ed`, `0d2b4ac`, `e3b3ef8`, `3f5711a`; checked by the pre-handover review; lab hard gate before install |

Build commits `b791fa9`..`d20a56f` (migration 0041). Honest status: verified by design and unit tests; the Windows lab suite has
never run.

## P5.5 — load test, journeys, exit tests
No separate review; its minors went to the clean-ups and it was in scope of final reviews A/B/C. Commits `0a17d1b` (fix: per-address
limits behind the TLS proxy, found by the load test), `376f63a` (tests), `7015426` (results).

## Final whole-branch reviews (at `7015426`)
| Review | Verdict | C / I / M | Key findings | Fixed by |
|---|---|---|---|---|
| A (Opus): access and database | Needs fixes | 0 / 1 / 7 | I-1 multi-factor for administrators off by default and unchecked in production | Final fix Y (`7824bc1`, `a9b4091`; ruling FY-1) |
| B (Opus): auth, sessions, media, secrets | Needs fixes | 0 / 3 / 8 | I-1 = A I-1; I-2 code guessing had no ceiling; I-3 generated `gateway.env` lacked `TRUSTED_PROXY_HOPS` | Final fix Y (FY-2, `2cd32ad`); P5.4 round 3 |
| C (Opus): worker, data, screens, operations | Needs fixes | 0 / 14 / 30 | I-1..I-3 NVR login back-off weak, absent for live/playback, "forbidden" treated as refused; I-4 first start contacts every NVR; I-5 any failed health check rolled back an update; I-6 proxy hops missing; I-7 device edit turned an AP into an "NVR"; I-8 lenient device CSV; I-9 restore under an archived parent; I-10 screens said `npm run worker`; I-11 nothing noticed stopped backups; I-12 Caddy vs folder locks; I-13 Docker Desktop as host; I-14 exit criterion 3 not met | X (I-1..I-4), Y (I-7..I-9, I-10 `9942efb`), P5.4 round 3 (I-5, I-6, I-11..I-13); I-14: gates recorded, security review still open |

## Final fix X — NVR login safety and rollout
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Build round 1 | — | — | One shared, database-backed login back-off for every path; monitoring rollout screen; imported NVRs off in production | `c36f040` (migration 0048), `820151a`, `7b72be9`, `e8e4d57`; rulings NB-1..NB-6 |
| Review (Opus) | Needs fixes | 0 / 2 / 10 | I-1 the live wall registered every go2rtc source when the one RTSP proof had no answer; I-2 a 403 or 200 before any password was sent counted as a proven login | Round 2: `4e32c30` (migration 0050), `05f6880`, `cf9b0db`; rulings NB-7..NB-12 |
| Pre-handover review (below) | Needs fixes | 0 / 1 / 7 | The round-2 fail-safe let one dead camera or a WAN drop mark a healthy NVR "login refused" | Round 3: `2e555d1` (migration 0052), `9b23564`, `85fd55f` |
| X round 3 review | **Approved** | 0 / 0 / 4 + 1 nit | M-1 new password does not clear "last played video" (up to 10 minutes); M-2 the camera's-own rule and the broad network pattern can hide an unknown-wording refusal (other checks still catch it); M-3 gateway dead-camera test would pass on old code (the database test proves the fix); M-4 fail-safe after a real refusal relabels it "unexplained"; N-1 Try-again audit row says "refused" | Not fixed; listed as known limits in `RELEASE-1-HANDOVER.md` |

## Final fix Y — auth, MFA, SQL guards, admin, import
| Round | Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|---|
| Review (Opus) | **Approved** | 0 / 0 / 11 (Y-R1..Y-R11) | Migration 0049 equals the database; minors: service key could still switch MFA off with no person, no break-glass for a locked code step, chunked bodies, import column naming | Final clean-up |

Commits `7824bc1` (migration 0049), `2cd32ad`, `a9b4091`, `ee95fbb`, `a2720c9`, `d593013`, `4bf30ed`, `c39f9a2`, `f15b2e4`, `9942efb`,
`880ee2f`, `8a85605`; rulings FY-1..FY-16.

## Final clean-up
Commits `aa7a6fd` (migration 0051), `9ae98c6`, `3b8fa62`, `5d98446`, `b075f8f`, `e2f4db0`, `a362a6b`, `32db060`, `0b15bea`; rulings
FC-1..FC-8. Reviewed as part of the pre-handover review.

## Pre-handover review (at `0b15bea`)
| Verdict | C / I / M | Key findings | Fix |
|---|---|---|---|
| Needs fixes | 0 / 1 / 7 | I-1 the gateway fail-safe (NB-12) marked a healthy NVR "login refused" for one dead camera channel or a network failure, blocking every path for the window; m-1..m-7 (connection-test wording, video not settling an unproven login, import stamp edge case, service key DELETE on inventory tables, archived-parent references, chunked-body proof, group undo all-or-nothing) | I-1: final fix X round 3 (approved). Minors: not fixed; known limits in the handover |

The reviewer also confirmed: migrations 0001–0051 contiguous with rollbacks, function bodies equal to the committed files, no tracked
secrets or real CSV, `privilege_violations()` empty.

---

## What this chain does and does not prove
- It proves that each package was read by an independent AI reviewer, that every Critical and Important finding was fixed (with tests
  that fail on the old code, per the re-reviews), and that the last reviews approved.
- It does not replace a human security review or penetration test, and it does not prove behaviour on real NVRs, a real Windows
  server, real WAN links or HTTPS through Caddy (see `RELEASE-1-HANDOVER.md` section 4).
