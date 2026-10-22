# Operations Extras (Plan 8 of 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smaller capabilities that make the hub more useful day to day and that were proposed in chat: Wake-on-LAN through a relay PC, recurring scheduled commands, a security posture view, SNMP checks for printers and switches, regional outage correlation, and a ticket hand-off. Each task is optional and independent; the user decides afterwards what to keep.

**Architecture:** Every task reuses an earlier mechanism (agent command queue from Plan 6, monitor worker from Plan 2, alert engine from Plan 4). No new services.

**Tech Stack:** as earlier plans; `net-snmp` for SNMP v2c/v3 reads (read-only).

**Spec:** chat decisions of 2026-10-22. Builds on Plans 2 to 7.

## Global Constraints

- All earlier constraints apply. Nothing here may change a machine except through the existing guarded command queue.
- SNMP is read-only (GET and WALK only); community strings and v3 credentials are stored in Vault, never returned to the browser.
- Wake-on-LAN sends the magic packet from an online agent PC in the same site (the relay); the hub never sends packets itself. Needs the target MAC address from inventory.
- Recurring jobs create ordinary fleet commands at their due time, so every approval and risk rule of Plan 6 still applies; a recurring job that needs approval waits for it each time unless the rule was approved as a "standing approval" by two administrators, valid for 90 days, risk `low` or `medium` only.
- Tickets: a plain webhook or e-mail hand-off with a stable external reference; no vendor-specific API in this plan.
- `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration` clean at the end of every task.

## File Structure

```
supabase/migrations/20261021000018_extras.sql (+ rollback)
agent/windows/builtin-scripts/wake_on_lan_relay.ps1
lib/fleet/{schedules,wol}.ts   lib/monitor/snmp.ts   lib/queries/{posture,regions}.ts   lib/alerts/tickets.ts
app/(app)/admin/{schedules,posture}/**   components/{posture,regions}/*
```

---

### Task 1: Wake-on-LAN through a relay

**Files:** migration part 1 (`devices.mac_address text` already exists from Plan 6 hardware data; add `wol_relay_device_id uuid null` same-organisation foreign key), `lib/fleet/wol.ts` (`pickRelay(deviceId)`: an online agent PC in the same store that is not the target; `wakeDevice(actor, deviceId)` queues a `wake_on_lan_relay` script job on the relay with params `{ mac, broadcast }`), built-in script `wake_on_lan_relay.ps1` (builds the 102-byte magic packet and sends it with `UdpClient` to the subnet broadcast on UDP 9; supports `-WhatIf`), device page button "Wake up this computer" (shown when the PC is offline and has a MAC), result shown as "Wake-up signal sent. The computer usually starts within a minute."; also used by the command queue wizard as an option "Wake offline computers first".
- [ ] Tests first: magic packet builder bytes (6 x FF then 16 repeats of the MAC) in TypeScript for the relay choice test and in PowerShell for the script (Windows only, `-WhatIf` only); relay selection (same store, online, not the target; none available gives the plain message "No other computer is on at this location to send the wake-up signal."); permissions (operators and administrators only); cross-organisation refusal. Commit `feat: wake-on-LAN through a relay computer`.

---

### Task 2: Recurring commands

**Files:** migration part 2 (`fleet_schedules (id, org_id, name, command_spec jsonb, target_spec jsonb, cron text, tz text default 'Asia/Kolkata', next_run_at, last_run_at, enabled, created_by, standing_approval_by uuid[] default '{}', standing_approval_until timestamptz null)`; `fleet_schedule_runs (id, schedule_id, at, fleet_command_id null, status, detail)`), `lib/fleet/schedules.ts` (validate with a small cron parser limited to five fields with steps and lists; `computeNextRun`; `runDueSchedules(now)` creates fleet commands through the existing fleet service so all rules apply, records a run, advances `next_run_at`; skips a run still pending approval from the previous time), worker hook (every 60 s call `runDueSchedules`, guarded by the worker lock), `app/(app)/admin/schedules/page.tsx` (list, create from an existing library script with params, target by store, group or search, preview of the next five run times in IST, enable/disable, standing approval toggle by two admins).
- [ ] Tests first: `computeNextRun` for hourly, daily at 02:00 IST, weekly Sunday, and invalid expressions; due-run creates exactly one fleet command and advances; a disabled schedule never runs; missed runs while the worker was down create one catch-up run, not many; approval-needed commands remain pending and are not duplicated; standing approval needs two distinct administrators, expires after 90 days and is refused for risk `high`. Commit `feat: recurring fleet commands`.

---

### Task 3: Security posture view

**Files:** `lib/queries/posture.ts`, `app/(app)/admin/posture/page.tsx`, `components/posture/*`, extend the agent collection (Plan 6) only if a field is missing: Windows Defender state and signature age (`Get-MpComputerStatus`), firewall profile states, BitLocker status of the system drive, local administrator group members count, last Windows update install date, pending reboot, RDP enabled, SMBv1 enabled, uptime. Page: fleet-wide counters (for example "37 PCs have no antivirus signature newer than 7 days"), a table filterable by store and by finding with a link to the device, and for each finding a "Fix this" button that creates a built-in script job when one exists (`enable_firewall`, `update_defender_signatures`, `disable_smb1`; all supports `-WhatIf` and medium risk, requiring approval for more than one PC as always).
- [ ] Tests first: query aggregation against seeded devices (counts per finding, stores filter, organisation isolation); the three built-in scripts parse, support `-WhatIf` and pass the Plan 6 static rules; nothing changes on the development PC. Commit `feat: security posture overview with fixes`.

---

### Task 4: SNMP checks for printers and switches

**Files:** migration part 3 (`snmp_profiles (id, org_id, name, version check in ('2c','3'), vault_secret_id, port default 161)`; `devices.snmp_profile_id null` same-organisation foreign key; new device types `printer`, `switch`, `access_point`, `ups` if not already present), `lib/monitor/snmp.ts` (client wrapper around `net-snmp` with timeout 3 s and retries 1; `readPrinter` (status, page count, toner levels via Printer-MIB), `readSwitch` (uptime, interface up/down count via IF-MIB), `readUps` (battery and load via UPS-MIB when present); results become extra checks in `check_state` detail and metrics), worker integration (new check kind `snmp` using the device's profile, interval 300 s), fake SNMP agent for tests (a UDP loopback server answering a fixed set of OIDs using `net-snmp` agent mode), Devices UI: profile selector and a small readout of the latest values; alert rule examples "toner below 10 percent" and "interface down".
- [ ] Tests first: wrapper against the fake agent (success, timeout, wrong community gives auth failure), result parsing for printer toner percentages, state transitions through the existing `monitor_apply_results`; secrets never appear in API responses or logs. The egress guard allows only loopback. Commit `feat: read-only SNMP checks for printers, switches and UPS`.

---

### Task 5: Regional outage correlation

**Files:** `lib/queries/regions.ts`, `components/regions/RegionBanner.tsx`, a Dashboard section "Possible regional problem": when at least 3 stores in the same city (or the same store group, whichever the data has) went down within the same 10 minutes, or more than 60 percent of a region's stores are down, show one grouped incident ("14 stores in Lucknow lost contact between 10:02 and 10:09. This looks like a network or power problem at the provider, not 14 separate faults.") and let the alert engine send one grouped message instead of one per store (a new alert rule kind `regional_outage`, suppression of the per-store messages for 15 minutes; uses existing channel code).
- [ ] Tests first: grouping function over seeded outages (inside and outside the window, different cities, minimum count), suppression logic, text wording. Commit `feat: regional outage correlation and grouped alerts`.

---

### Task 6: Ticket hand-off

**Files:** migration part 4 (`ticket_links (id, org_id, kind, entity_id, external_ref, created_by, created_at)`, unique `(org_id, kind, entity_id)`), `lib/alerts/tickets.ts` (create a ticket by posting a JSON body to a configured webhook URL, or by sending an e-mail to a configured address; stores the returned reference if any; idempotent per entity), buttons "Create ticket" on outages and device problems, setting in admin for the webhook URL or mailbox (stored encrypted in Vault; URL validated against the egress allow-list and `https` only outside tests), outbound payload with the plain-English summary and a deep link to the hub.
- [ ] Tests first: webhook posting against a loopback fake, idempotency (second click shows the existing reference), e-mail path via the existing mail fake, refused for another organisation, secrets never returned. Commit `feat: ticket hand-off for outages and device problems`.

---

### Task 7: Final checks

- [ ] Run all checks and `npm run build`; extend `scripts/seed-demo.ts` with demo printers, a switch, a schedule and a regional outage; update the README feature list. Commit `docs: operations extras demo data`.

---

## Plan self-review

Covered: every item from the proposal list (Wake-on-LAN relay, recurring jobs, security posture, SNMP, regional correlation, tickets). Each task is independent, so any can be dropped without affecting the others. Not covered on purpose: vendor ticket integrations, SNMP writes, configuration backups of switches.
