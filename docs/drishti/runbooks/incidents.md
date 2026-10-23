# Runbook: incidents (P5.4)

First look, every time: the Health page (`/admin/health`, super administrators) and `drishti-services.ps1 -Action Status`; then the log
of the service concerned, `C:\Drishti\logs\<service>\<service>.log` (JSON lines, newest last, never a secret). Times on the pages are
India time (IST); the logs are UTC.

## 1. Many NVRs "not reachable" at once (an NVR-down storm)

Symptoms: the Locations page and Home show many locations with "recorder not reachable"; Monitoring lists many NVRs offline; people
report "the video server did not answer" for whole clusters.

1. Is it Drishti or the network? If the NVRs of one region or cluster are all down at the same minute, it is almost always the VPN /
   SD-WAN (the NVRs are reached over it). Check from the server: `Test-NetConnection <one NVR address> -Port 80`. Do not change anything
   on the NVRs.
2. Drishti is behaving as designed: cameras of an unreachable NVR show "recorder not reachable", never "offline" (P4-L1 rule); the
   worker backs off its logins to a failing NVR (the earlier NVR login back-off ruling, no lockout), so a storm does not lock NVR
   accounts and does not flood the network. Outages are recorded per NVR; nothing needs to be cleared afterwards.
3. When the network is back, results return within one round (cameras every few minutes; "Check now" on the Monitoring page asks at
   once). The Health page's worker check stays "OK" throughout (the worker itself is fine).
4. If only Drishti sees them down (people at the location see their NVR fine): check the server's own network route to that subnet,
   and `OUTBOUND_TARGET_ALLOWLIST` / the registered NVR addresses (an NVR moved to a new address needs its address changed on its page).
5. Record the window in the incident log; the outage history keeps the per-NVR times.

## 2. The worker is stuck (the Health page: "Monitoring worker: Not running" or "no worker holds the lease")

1. `drishti-services.ps1 -Action Status`: is `DrishtiWorker` running? If stopped: `-Action Start -Service DrishtiWorker`, then read the
   end of its log for the reason (`worker_config_refused` = a missing or wrong key in `worker.env`; `worker_crashed` = an error, with its
   stack).
2. Running but "Not running" on the Health page (no heartbeat for over 30 s):
   - the log shows `lease_standby` repeatedly: another worker holds the lease. Only one worker per database may work (P2-7); find the
     other one (the Health page shows "Lease taken on <host>"), stop it. A second worker started by mistake waits harmlessly.
   - `lease_lost` / `lease_acquire_failed`: the database is not reachable or refuses the worker's key (rotate it as in
     `secret-rotation.md`, then restart the worker).
   - nothing new in the log for minutes: the process hangs. `-Action Restart -Service DrishtiWorker`; the lease ends 20 s after the
     last renewal, so the restarted worker takes over with a new epoch; nothing it had in flight can be written after that (fencing).
3. "Clocks: the worker's clock is N seconds ahead/behind": put the server on time sync (`w32tm /resync`; in a domain the domain
   controller is the source). Results dated more than 30 s in the future are dated at the database's time; a clock behind makes results
   look old ("Not checked lately").
4. "Clean-up of unused video sessions: last run over 30 minutes ago": the worker runs it every 10 minutes while it holds the lease;
   fix the worker first. The clean-up is harmless to run late (unused rows just wait longer).

## 3. The gateway is not answering (Health: "Video gateway: Not answering"; live video and playback fail for everybody)

1. `-Action Status`: `DrishtiGateway` running? If not: start it and read its log. Typical refusals at start: `gateway_config_refused`
   (its key, `STREAM_TOKEN_SECRET` missing/weak, go2rtc answers without its login — see 3.3), `gateway_listen_failed` (port 3412 taken:
   `Get-NetTCPConnection -LocalPort 3412`).
2. Running, but the page cannot reach it: Caddy routes `/g/*` to 127.0.0.1:3412 (runbook-tls.md); `curl.exe -s http://127.0.0.1:3412/g/health`
   on the server should answer JSON. If that works, the problem is Caddy or the browser's address (`GATEWAY_ALLOWED_ORIGINS` must list
   the address people open).
3. go2rtc: `DrishtiGo2rtc` running? `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:1984/api/streams` must answer **401** (its
   login is required). 200 means it runs without its login: fix `go2rtc.env`/`go2rtc.yaml` and restart go2rtc, then the gateway.
4. "Answering, but it cannot check open video connections": the gateway cannot reach the database registry; open videos are closed
   after the fail-closed time (by design). Check the database and the gateway's key.
5. After any restart of the gateway, open walls reconnect by themselves within a minute.

## 4. Other alarms of the Health page

| Check | Meaning | What to do |
|---|---|---|
| Database: Problem | the web app cannot ask the database | the Supabase stack (`docker ps`, its logs); the web app's key in `web.env` |
| Vault: Problem | the check secret does not decrypt: the server's Vault root key is not the one the NVR passwords were saved with | **stop**; do not type passwords again yet. Usually a rebuilt database container without the saved key file: put the key back (`backup-restore.md` section 2) and restart the database |
| Database version: Problem | migrations of this release are not applied | `update-rollback.md`: run the migrations (or finish the update) |
| Database version: Needs attention | the database is newer than the code | a code roll back without the database: deliberate? else update again |
| Free disk space | backups and logs will fail | move old backups off the server (keep the retention rule), check log sizes |
