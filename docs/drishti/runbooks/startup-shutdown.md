# Runbook: start-up and shut-down (P5.4)

Applies to: the Windows installation (`windows-services.md`). All commands from an elevated PowerShell in `C:\Drishti\app\current`.

## Start (after maintenance, or when something was stopped by hand)

1. The database: the Supabase stack is up (self-hosted Docker: `docker ps` shows the db, rest, auth and kong containers healthy; hosted:
   the project's status page). Nothing of Drishti starts usefully without it (the worker waits in standby and retries; the web app
   and the gateway refuse to start in production when they cannot check what they need).
2. `.\deploy\windows\drishti-services.ps1 -Action Start` — go2rtc, worker, gateway, web app in that order (the gateway depends on go2rtc).
3. Caddy (the HTTPS front, runbook-tls.md): `Start-Service caddy` (its own service).
4. `.\deploy\windows\drishti-services.ps1 -Action Status` — four `Running` and `health: ok`. Then the Health page (`/admin/health`).
   A process that refused to start says why in one plain line at the end of its log (`C:\Drishti\logs\<service>\<service>.log`, events
   `web_config_refused`, `worker_config_refused`, `gateway_config_refused`): a missing or weak secret, the full service key in the
   wrong file, go2rtc answering without its login, an organisation that has not locked the service key out of NVR logins.

The services start by themselves after a reboot (delayed automatic start). The service host restarts a program that ends by itself
(5 s, doubling to 60 s); Windows restarts the host if it fails (5 s, 10 s, 60 s).

## Stop (maintenance, a Windows update, a backup outside the nightly one)

1. Tell the people watching video (they lose it at once; pages say "The video server did not answer" and retry).
2. `.\deploy\windows\drishti-services.ps1 -Action Stop` — web app first (no new video), then gateway (open sockets closed cleanly), worker
   (finishes the checks in progress within 15 s, then hands its lease back), go2rtc.
3. Each log ends with the program's own stop line (`gateway_stopped`, `worker_stopped`); `"did not stop in time: ended"` from the host
   means the program was ended after its stop timeout (look at the lines before it).

One service only: `-Action Restart -Service DrishtiGateway` (for example after rotating the gateway's key, runbook `secret-rotation.md`).

## Order matters when

- go2rtc's login changes: recreate/restart go2rtc first, then the gateway and the web app (`secret-rotation.md` section 4). On Windows,
  `drishti-services.ps1 -Action Restart -Service DrishtiGo2rtc` stops the gateway first (it depends on go2rtc: Windows would refuse to
  stop go2rtc under it), restarts go2rtc, starts the gateway again and says so; then `-Action Restart -Service DrishtiWeb`.
- The database comes back after an outage: nothing to do; the worker takes its lease again (a new epoch) and the web app reconnects.
  The Health page's "Monitoring worker" check turns "OK" within a minute.
- Windows updates on the server: stop as above, update, reboot; the services start by themselves; check `-Action Status`.
