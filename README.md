# CityKart Network Monitoring Hub

Monitors CCTV cameras, NVRs, servers, attendance machines, footfall counters and any other IP device,
with live camera feeds and per-user access to stores and cameras. Built on the Citykart Desk stack
(Next.js 16, Supabase/PostgreSQL, shadcn/ui). The app listens on **port 3212**.

- Design: `docs/superpowers/specs/2026-10-21-network-monitoring-hub-design.md`
- Plans: `docs/superpowers/plans/`
- Legacy app kept for reference only: `reference/cctv-hub-legacy/`

## First run (needs Node 20+ and Docker)

    npm install
    npm run db:start        # local Supabase on ports 55321-55324 (first run downloads images)
    npm run db:reset        # applies the migrations and the seed organisation
    npm run env:local       # writes .env.local (git-ignored) with generated keys and secrets
    node scripts/create-dev-admin.mjs
    npm run dev             # http://localhost:3212

The dev admin's e-mail and password are in `.env.local` (`DEV_ADMIN_EMAIL`, `DEV_ADMIN_PASSWORD`).

## Checks

    npm run typecheck
    npm run lint
    npm run test:unit
    npm run test:integration   # needs the local Supabase stack; uses disposable organisations

Integration tests only run against the local stack (port 55321) and never touch a real store.

## Monitoring (worker)

The checks run in a separate process, the worker, next to the web app:

    npm run worker          # checks devices and NVRs every 60 s, cameras every 300 s; Ctrl+C stops it cleanly
    npm run worker:dev      # same, restarts when the code changes

- It answers "Check now" requests within a few seconds and shows its progress on the **Monitoring** page (administrators).
  Operators, administrators and platform owners may press **Check now**; managers and viewers may not.
- `GET /api/health` says whether the database and the worker are alive (`ok` or `degraded`). It carries no names, counts or error details.
- Time while the worker was not running is never counted as downtime.
- Only one worker may run against a database at a time.
- **Integration tests must not run while a worker uses the same database**: both write the single `worker_state` row. Stop the worker first.

### Demo without any hardware

    npm run fake:nvr                  # pretend NVR, camera port and devices, on 127.0.0.1 only (add --flip, --port=NNNN)
    npm run demo:seed                 # DEMO organisation: 3 stores, 14 cameras, 4 devices, one demo user per role
    npm run worker                    # in another window
    npm run dev

`demo:seed` works on the local stack only. It creates one demo person for each role, with the e-mail
`demo.<role>@demo.example.test` (`demo.user`, `demo.agent`, `demo.manager`, `demo.admin`, `demo.platform-owner`). Their passwords are made up
when you run it and printed **once**, in the terminal; they are not saved anywhere. If you lose them, run `npm run demo:seed -- --fresh` for new ones.
Everything it creates points at 127.0.0.1 and lives in its own organisation. Stop the worker, then
`npm run demo:seed -- --reset` removes that organisation and nothing else (`-- --fresh` removes and adds it again).
Sign in as the demo administrator, press **Find cameras** for DEMO1 on Manage stores, then **Check now** on Monitoring.

## Safety rules

No passwords, keys or tokens in the repository, logs or chat. NVR passwords live only in Supabase Vault.
Do not connect to production systems from a development machine.
