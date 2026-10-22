# Windows Deployment Tracking and Reinstall Pilot (Plan 7 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IT can see which Windows versions run where and which Windows 10 PCs can move to Windows 11, and can run a controlled, two-person-approved, scheduled in-place Windows repair or reinstall on a PC from head office. A full clean format is delivered as a lab-validated runbook and a guarded stub, not as an automatic feature.

**Architecture:** Everything rides on the Plan 6 agent and command queue: three new job kinds (`deployment_preflight`, `deployment_stage`, `deployment_apply`) driven by a deployment request with a strict state machine, approvals, a schedule window and a timeline. Images are hosted by the hub and downloaded by the PC over the VPN with resume and SHA-256 verification. The destructive step is off by default twice: a hub switch and an agent setting.

**Tech Stack:** as Plans 5 and 6 (Next.js 16, Supabase, PowerShell 5.1 agent), `IMAGE_DIR` on the hub's disk.

**Spec:** chat decisions of 2026-10-22 (Windows 10 and 11 only, no domain, no Intune, all PCs on the VPN with 50 to 150 Mbps, no server controllers, "format and reinstall from head office" wanted). Builds on Plans 2 to 6.

## Global Constraints

- All earlier constraints apply, including: **no test or demo ever changes a real machine**. Preflight and staging may run in tests against fakes; the apply step is executed only through `-WhatIf` and a fake executor. Never run `setup.exe`, `diskpart`, `dism /apply`, `bcdedit`, `shutdown` or any disk or boot change on the development PC.
- A deployment request needs: the PC (with an agent), a kind (`repair_install` or `clean_reinstall`), an image, a schedule window (start and end in IST, at least 1 hour, at most 12 hours, only in the future), a backup confirmation (the requester ticks that user data is backed up or not needed and types the PC's host name), and **two approvals by two different administrators, neither being the requester**.
- `deployment_apply` jobs are handed out only when the hub setting `ENABLE_DEPLOYMENT_APPLY=1` is set **and** the request is inside its window **and** the latest preflight (less than 24 hours old) passed with no `fail`; the agent runs them only when its local config has `allowDestructive: true` and the job signature verifies. Both switches default to off.
- `clean_reinstall` is not automated here: the agent's executor for it returns a failed result "A clean reinstall is a lab-validated procedure. See docs/deployment/windows-reinstall-pilot.md." unless the lab kit marker file exists on the PC; the hub offers the kind only when `ENABLE_CLEAN_REINSTALL=1`.
- Servers: no remote reinstall (no management controller). Requests for a PC of type `server` are refused with the plain message "Servers must be reinstalled on site or through the virtualisation host."
- Image files are never served without the device bearer token and a deployment request that references the image for that device; a download counts toward the request's timeline.
- Windows 10 reached end of support on 14 October 2025. The Windows 11 readiness rule is a documented approximation of Microsoft's requirements (64-bit CPU 1 GHz or faster with 2 or more cores on the supported CPU list approximated as Intel Core 8th generation and newer or AMD Ryzen 2000 and newer, 4 GB RAM, 64 GB storage, UEFI with Secure Boot capable, TPM 2.0); results say "probably ready" or list the reasons, and are advice only.
- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration` clean at the end of every task; PowerShell tests only on Windows.

## File Structure

```
supabase/migrations/20261021000016_win11_readiness.sql  ..000017_deployments.sql (+ rollbacks)
agent/windows/CityKartAgent.ps1 (readiness fields, deployment executors)  agent/windows/deployment/*.ps1
lib/deploy/{readiness,images,requests,states}.ts   lib/actions/admin/deployments.ts
app/(app)/admin/deployments/**  app/(app)/admin/images/page.tsx  app/api/agent/images/[id]/route.ts  app/api/admin/images/upload/route.ts
docs/deployment/windows-reinstall-pilot.md
```

---

### Task 1: Windows 11 readiness and the Windows version picture

**Files:** migration `20261021000016_win11_readiness.sql` (adds to `device_hardware`: `tpm_version text`, `secure_boot boolean`, `boot_mode text` ('UEFI'|'BIOS'), `cpu_generation_note text`, `win11_ready text` ('yes'|'no'|'unknown'), `win11_reasons jsonb default '[]'`; extends `agent_ingest` to store them) + rollback, `lib/deploy/readiness.ts` (pure `assessWin11(hw): { ready: 'yes'|'no'|'unknown'; reasons: string[] }` used by both the agent-side SQL mirror and tests; the SQL function does the same assessment on ingest so the rule lives in one documented place: implement it in SQL (`win11_assess(...)`) and have `readiness.ts` call the database in tests), agent changes (collect TPM via `Get-Tpm`/`Win32_Tpm`, Secure Boot via `Confirm-SecureBootUEFI`, boot mode via `bcdedit`-free check of `$env:firmware_type` or the registry value `PEFirmwareType`), `lib/queries/fleet.ts` (cards: Windows 10 PCs ready / not ready with reasons grouped, Windows 11 count, builds table), Fleet page cards; tests `tests/integration/win11-readiness.test.ts`, extend `tests/unit/agent-ps.test.ts` (dry run contains the new keys with real values on the dev PC).
- [ ] Tests first: rule cases (all pass; each single failure gives its own reason: TPM below 2.0, no Secure Boot capability, BIOS boot mode, RAM under 4 GB, system disk under 64 GB, unsupported CPU, unknown CPU gives `unknown`); a Windows 11 PC is reported "already on Windows 11"; the fleet query counts and reason grouping. Commit `feat: Windows 11 readiness and version overview`.

---

### Task 2: Image catalogue and hosting

**Files:** migration `20261021000017_deployments.sql` part 1 (table `deployment_images (id, org_id, name, kind check in ('iso','wim'), windows_version text, edition text, language text, file_name, file_size bigint, sha256, created_by, created_at)`; RLS admin read; service writes), `lib/deploy/images.ts` (register, list, delete; deletion refused while an open request uses it), `app/api/admin/images/upload/route.ts` (streaming upload with running SHA-256 to `IMAGE_DIR/<id>/<file>`, admin only, limit 12 GB, cleanup on failure, rejects a name that is not `.iso` or `.wim`), `app/api/agent/images/[id]/route.ts` (bearer auth, Range support, requires an open deployment request for that device and image, writes a timeline event on first byte), `app/(app)/admin/images/page.tsx`; tests `tests/integration/images.test.ts`.
- [ ] Tests first: upload of a 2 MB dummy file with correct hash; wrong extension refused; oversize and aborted uploads leave no file; download needs bearer and a referencing request, honours Range (206 with correct headers), refuses other devices and other organisations; list and delete rules. Commit `feat: Windows image catalogue and hosting`.

---

### Task 3: Deployment requests and the state machine

**Files:** migration part 2 (`deployment_requests (id, org_id, device_id, kind, image_id, status, requested_by, approved_by_1, approved_by_2, window_start, window_end, backup_confirmed boolean, hostname_confirmed text, preflight jsonb, preflight_at, notes, created_at, updated_at)`, `deployment_events (id, request_id, org_id, at, actor_id null, kind text, detail text)`; extend the `agent_jobs.kind` check with the three new kinds), `lib/deploy/states.ts` (pure transition table), `lib/deploy/requests.ts`, `tests/unit/deploy-states.test.ts`, `tests/integration/deploy-requests.test.ts`.
States and allowed moves: `requested → approved` (second distinct approval) `| rejected | cancelled`; `approved → preflight_running → preflight_passed | preflight_failed`; `preflight_passed → staging → staged`; `staged → awaiting_window` (automatically when staged); `awaiting_window → applying` (inside the window only); `applying → completed | failed`; `preflight_failed | failed → requested`? no: a failed request is closed and a new one must be made; `cancelled` is allowed from every state before `applying`. Every transition is a single service function that checks the current state, the actor, the window and the preconditions, appends a `deployment_events` row and audits. Functions: `createRequest` (validations from the constraints, including the server refusal, the image existing, a unique open request per PC), `approve` (two distinct approvers, neither the requester; the second approval moves to `approved` and queues the preflight job), `reject`, `cancel`, `onPreflightResult`, `onStageProgress/Result`, `startApply` (called by the queue handing-out rule), `onApplyResult`. The queue rule is implemented where jobs are handed out (Plan 6's `agent_next_jobs`): extend it so `deployment_apply` jobs are returned only under the Global Constraints (setting, window, fresh passed preflight); other kinds unchanged.
- [ ] Tests first: every legal and illegal transition; approval rules; window rules with a fake clock (before, inside, after); preflight freshness; one open request per PC; the apply job never handed out when `ENABLE_DEPLOYMENT_APPLY` is off, outside the window, or without a fresh passed preflight, and handed out when all three hold; events recorded; audit rows. Commit `feat: deployment requests with approvals, windows and a state machine`.

---

### Task 4: Agent side: preflight, staging, apply

**Files:** `agent/windows/deployment/{Preflight,Stage,Apply}.ps1` (dot-sourced), agent changes (job kinds, `allowDestructive` config, progress reporting), `lib/deploy/jobs.ts` (builds the three jobs for a request and parses their results), tests `tests/unit/agent-ps.test.ts` (Windows only), `tests/unit/deploy-jobs.test.ts`.
Behaviour: **Preflight** (read-only, always allowed): AC power or battery over 50%, free space on the system drive at least 2.5 times the image size and at least 30 GB, BitLocker state of the system drive (warn when protected: the apply step suspends it), boot mode UEFI, Secure Boot, TPM, partition layout summary, a user logged on (warn), pending reboot (fail), image reachable (HTTP HEAD with the bearer returns the right size), OS edition and activation state, Windows 11 readiness for upgrades; result `{ checks: [{id, status, detail}], summary }`. **Stage**: downloads the image in 8 MB ranges with resume to `C:\ProgramData\CityKartAgent\images\<id>\image.iso`, throttled to the job's `maxMbps` (default 40), reports progress each minute (bytes, percent, speed), verifies SHA-256, and for ISO files mounts it read-only (`Mount-DiskImage`) only to confirm `setup.exe` exists, then dismounts. **Apply** (guarded): `repair_install` mounts the ISO, suspends BitLocker for one reboot if protected, and starts `setup.exe /auto upgrade /quiet /eula accept /dynamicupdate disable /migratedrivers all /showoobe none` (keeps files and apps); it reports `succeeded` with "Setup started" before the restart because the PC restarts into Setup, and the next check-in after the reinstall reports the new build; `clean_reinstall` is the stub from the Global Constraints. All executors support `-WhatIf` and print each command line they would run; `-WhatIf` is the only mode used in tests.
- [ ] Tests first: unit for `lib/deploy/jobs.ts` (job params and signatures, result parsing, a preflight with any `fail` blocks progress); PowerShell (Windows only, development PC, read-only): the preflight in dry-run mode against a fake image URL served by a loopback Node server (HEAD returns the size) produces a valid report; staging runs against the loopback server with a 5 MB file, resumes after a simulated interruption (the server closes the first response halfway), verifies the SHA-256 and rejects a wrong one, writing only under a temp folder (the staging folder root is a parameter in tests); `-WhatIf` apply prints the setup command line and changes nothing; `allowDestructive: false` makes the real apply refuse with a plain message (tested without `-WhatIf` because it must refuse before doing anything); parse checks of all new scripts. Commit `feat: agent deployment preflight, staging and guarded apply`.

---

### Task 5: Screens

**Files:** `lib/actions/admin/deployments.ts`, `app/(app)/admin/deployments/{page.tsx,new/page.tsx,[id]/page.tsx}`, `components/deploy/{RequestWizard,Timeline,PreflightReport}.tsx`, nav item "Deployments" (admins), the device page's Overview shows the deployment history, Fleet page links.
Screens: list (PC, kind, image, window, status, approvals "1 of 2"); wizard (choose PC with search; kind; image; window start and end; backup confirmation with the host-name typing check; a plain-words risk panel: what happens, how long it takes at the PC's speed (image size and the PC's recent `hubMs`-based estimate shown as a range), that the user will lose work if the PC restarts during the day, and that a repair install keeps files and apps while a clean reinstall removes everything); request page: timeline (every event with IST time and actor), approve/reject/cancel buttons honouring the rules, preflight report with coloured checks, staging progress bar, "Open remote screen" and device links. Plain English throughout; no wording that suggests the feature is switched on when it is not: when `ENABLE_DEPLOYMENT_APPLY` is off the request page says "The final step is switched off on this hub. Ask the administrator who runs the server to enable it after lab testing."
- [ ] Service-level integration tests exist from earlier tasks; add signed-out redirect checks and typecheck/lint. Commit `feat: deployment screens`.

---

### Task 6: Runbook and final checks

**Files:** `docs/deployment/windows-reinstall-pilot.md`, README section, `.env.example` (`IMAGE_DIR`, `ENABLE_DEPLOYMENT_APPLY=0`, `ENABLE_CLEAN_REINSTALL=0`), `scripts/seed-demo.ts` (demo images, one demo request in each state, using demo PCs).
Runbook contents: scope and what is and is not automated; lab setup (3 PCs of different models and one VM); the pilot steps for `repair_install` with success criteria (build changes, files and apps intact, agent returns, activation kept); the clean-reinstall design (WinPE ramdisk booted once via the Windows boot manager, `diskpart` layout for UEFI, `dism /apply-image` from a WIM, driver injection per model, unattend file with the workgroup name, local administrator account and a `FirstLogonCommands` entry that installs the agent with a limited-use enrolment token, activation from the firmware key `OA3xOriginalProductKey`), BitLocker, user data backup, bandwidth (a 5 GB image at 50 Mbps takes about 15 to 30 minutes), rollback, risk register, go/no-go checklist, servers (virtualisation host console or on site). The runbook states plainly that the clean reinstall path is untested here.
- [ ] Run all checks and `npm run build`. Commit `docs: Windows reinstall pilot runbook and demo data`.

---

## Plan self-review

Covered: Windows version tracking and Windows 11 readiness (Task 1), controlled in-place repair/reinstall with two-person approval, windows and fresh preflight (Tasks 2 to 5), a clean-reinstall runbook (Task 6). Deliberately not automated: the clean format (needs lab validation), server reinstall (no controller), BIOS changes. Untestable here: a real Windows Setup run; everything before it is tested against fakes and dry runs.
