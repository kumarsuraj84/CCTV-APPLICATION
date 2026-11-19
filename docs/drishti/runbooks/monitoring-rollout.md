# Runbook: monitoring rollout and NVR logins (pilot first, then by cluster)

Final fix X, rulings NB-1..NB-5 in `docs/drishti/DECISIONS.md`. Who: an administrator with inventory rights for the whole
organisation (or a super administrator). Every change below asks for a fresh sign-in and is audited.

## Why
The NVRs are real and their accounts lock after 5 to 7 refused logins (Hikvision "illegal login lock", per account or per source
address, about 30 minutes). Drishti therefore:
- contacts nothing whose monitoring is switched off (no checks, no live video, no playback, no camera discovery);
- keeps ONE login back-off for every path in the database: after a refused login an NVR is left alone for 15 minutes, then 30, 60,
  120, 240 and at most 360; at most one refused login per window; three refused logins in 30 minutes pause it until the oldest is 30
  minutes old or a corrected password is saved (round 2, NB-10);
- registers at most one live source for an NVR whose login check got no answer yet (NB-7);
- never takes a dead camera or a network failure for a wrong password (NB-12, round 3);
- contacts at most 10 never-checked NVRs per camera round when the worker starts (doubling while they succeed).

## Before the first start of the services
1. Import the estate (Admin → Import). In production a new NVR whose row leaves `monitoring` empty starts **switched off**.
2. Admin → Monitoring → **Monitoring rollout**: choose "Every NVR of the organisation", "Switch off", reason "Before the pilot". The
   counts at the bottom must read 0 on.
3. Ask the store IT owner, for each pilot NVR: its lock policy (attempts, duration, per IP or per account), and that the saved account is a
   read-only (viewer) user not used by the store itself.

## Pilot
4. Monitoring rollout → "One location" → the pilot location → "Switch on" → reason "Pilot". Start (or keep running) the services.
5. Within 5 minutes Admin → Monitoring shows the location's cameras checked. If its NVR appears under **NVR login problems**, fix the
   password on the NVR page (a new password is tried at once) or on the NVR itself and press **Try again**. Do not press Try again
   repeatedly: the third refusal in 30 minutes pauses the NVR (saving a corrected password still tries it at once).
6. Open the location's live wall and play back a recording. A tile that reads "Login refused: ask an administrator to check the NVR
   password" means the same as step 5 (CCTV-only viewers see "Camera not available.").
7. Pilot checks still to confirm on the real hardware (cannot be proven with the lab fakes): go2rtc's error text for a refused login
   (expected "wrong user/pass"; the gateway matches it), whether a viewer account gets 403 on the channel status (Drishti then checks by
   RTSP), the lock policy observed in step 3. If go2rtc words a refused login differently, the gateway's fail-safe (NB-12, revised in
   round 3) still stops: when two DIFFERENT cameras of an NVR that was not proven and played no video in the last 10 minutes fail with
   the same unknown text, the NVR waits for a window and Monitoring lists it as "go2rtc refused something we cannot explain: check the
   NVR password and the pilot log" (Try again ends it). The gateway logs it as `gateway_session` with outcome `login_refused`, reason
   `unexplained_failsafe`: search the gateway log for it after the pilot and report any hit (a wrong-password wording then needs adding
   to `isGo2rtcLoginRefusal`, a network wording to `isNetworkFailureText`). Lines with outcome `upstream_unexplained` are single
   unexplained failures (one camera: normally a dead channel); lines with `upstream_network` are network failures (never a login
   problem, never listed). One dead camera, or a dropped WAN link, never puts an NVR in that list.

## Then by cluster and region
8. Monitoring rollout → "A cluster" (the pilot's) → Switch on. NVRs never checked before are contacted 10 per round (every 5 minutes),
   20, 40 ... while they succeed; refused ones are left alone and listed.
9. Each further cluster or region the same way, one at a time, checking NVR login problems after each.

## Settings (worker.env / web.env)
| Setting | Default | Meaning |
|---|---|---|
| `MONITOR_NEW_RECORDERS_PER_ROUND` | 10 | never-checked NVRs contacted per camera round (1-500), doubling while they succeed |
| `NVR_LOGIN_BACKOFF_SEC` | 900 | first wait after a refused login (60 s - 1 day) |
| `NVR_LOGIN_BACKOFF_MAX_SEC` | 21600 | longest wait (doubling up to this) |
| `RECORDER_FAIL_THRESHOLD` | 3 | failed reachability checks before an NVR is "not reachable" |
| `FAIL_THRESHOLD` | 2 | failed checks before a camera is offline |
| `RECORDER_CONCURRENCY` | 10 | NVRs checked at the same time |
| `CAMERA_CHECK_SEC` / `DEVICE_CHECK_SEC` | 300 / 60 | check intervals |
Fixed: one lane per NVR, at most 4 RTSP checks per NVR, 8 s NVR and 5 s RTSP timeouts, 3 s TCP connect.

## Load at 216 NVRs (estimate, review C)
Per NVR every 5 minutes: one TCP connect a minute, one ISAPI status read and one channel list (a Digest exchange each), one RTSP
DESCRIBE for each camera the NVR reports offline, one password read an hour. Estate: about 3 HTTP requests a second to NVRs; a camera
round takes about 30-70 s over the WAN. The scheduling is tested at 218 fake NVRs (`tests/unit/monitor-rollout.test.ts`).
