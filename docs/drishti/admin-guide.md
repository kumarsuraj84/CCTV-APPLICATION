# CityKart Drishti — administrator guide (Release 1)

For the people who set Drishti up and run it day to day: administrators and super administrators. Plain steps; the technical
background is in `docs/drishti/ARCHITECTURE.md`, `access-model.md` and `locations-model.md`; the server side (services, updates,
backups, incidents) in `docs/drishti/runbooks/`. Written 2026-10-23 (P5.4). Times on every page are India time (IST, 24-hour).

## 0. Before you start

- **Who may do what.** A role says what a person may *administer*; it never gives access to cameras by itself. *Administrator*: manages
  viewers, operators and managers and gives them rights the administrator holds. *Super administrator*: holds every right for the whole
  organisation, manages everyone (other super administrators included), resets two-step sign-in, and sees the Health page. Keep at
  least two super administrators.
- **Every change on an administration page needs a recent sign-in** (within 10 minutes). When the notice at the top of the page says so,
  use "Confirm it's you" (it opens in a new tab, nothing on the page is lost), then save again.
- **Everything is recorded.** Every change, every sign-in and every video opened is in the audit log (Admin → Audit log), which cannot be
  changed or removed by anybody.
- The order that works best for a new installation: regions and clusters (§1) → locations (§2) → NVRs and their cameras (§3, or the
  import §4 for many at once) → find cameras (§5) → groups (§6) → people and rights (§7, §8) → two-step sign-in on (§9).

## 1. Regions and clusters (Admin → Regions and clusters)

Regions group clusters; clusters group locations. Both are optional (a location without a cluster works everywhere), but they let you
give a person "all cameras of cluster UP-1" in one grant that also covers locations added to it later.

1. "Add a region": a short **code** (for example `NORTH`; it never changes) and a display name.
2. "Add a cluster": its code (for example `UP-1`), name and region.
3. To put locations into clusters in bulk: "Suggest clusters from zones" proposes a cluster code from each location's zone and a region
   code from its state. Check the rows, change what is wrong, tick them, "Apply". Nothing changes before you apply.
4. Moving a location to another cluster changes who can see it (people with a grant on the old cluster lose it, the new cluster's gain
   it): the form shows the effect first.

## 2. Locations (Admin → Locations and NVRs)

A location is any place with cameras or IT: a shop, the head office, a distribution centre, a warehouse.

1. "Add a location": code (for example `PTN01`; unique, never changes), name, kind (store, head office, DC, warehouse, other), city,
   zone, state, cluster. "Location", never "store", is the word on every screen.
2. A location that closes is **archived** ("Archive…"), never deleted: its history, recordings references and audit stay; archived
   locations disappear from the lists and from everybody's access, and can be restored.
3. Its network (optional): the location's own address range, so its NVRs and devices are matched to it.

## 3. NVRs (recorders) and their cameras

Open the location, then "Add an NVR" (a location may have two, three or more):

1. Name (for example "Ground floor"), address (IP or host name), web port (80), RTSP port (554), the NVR's user name and **password**,
   the number of cameras it should have, and its clock offset if it is known to be wrong.
2. The password is **write-only**: it goes straight into the Vault and is never shown again (the page says "a password is saved"). To
   change it, type the new one and save. Changing the address or web port needs the password again (it is only ever sent to the address
   it was saved for).
3. "Test the connection" asks the NVR (read only) and says plainly whether it answered, refused the login, or could not be reached.
4. Cameras: the NVR's channels become cameras (placeholders until "Find cameras" fills them in, §5). A camera moved to another NVR or
   channel keeps its identity and its history ("Move"); a camera found twice can be merged ("Choose the duplicate" → "Yes, merge"; it asks
   you to confirm the exact pair).
5. Monitoring of one NVR can be switched off with a reason (maintenance): it is then not contacted at all, its cameras show "Switched off".

## 4. Importing the estate from a CSV file (Admin → Import)

For the real estate (about 216 locations and 4,600 cameras), use the location import. The full guide with every column and examples is
`docs/drishti/admin-guide-import.md`. In short:

1. One row per NVR (repeat the location code for a second NVR). Columns: `code, name, display_name, kind, city, zone, region, cluster,
   ip, port, http_port, user, password, channels, nvr_name, monitoring`.
2. "Check" first: nothing is written; you see what would be created, changed and archived, and each row's problem in plain words.
   Passwords are never shown back.
3. "Import": all or nothing (or "Skip the rows with problems"). Importing the same file again changes nothing.
4. Afterwards: "Find cameras for all locations" (§5), then check the Reconciliation page.
5. Keep the file safe or delete it: it holds NVR passwords.

## 5. Finding cameras (Admin → Locations and NVRs → Find cameras for all locations)

Asks every NVR for its list of cameras, in one go, a few NVRs at a time, read-only towards the NVRs. "Stop the search" finishes the NVRs
being asked and asks no other. Per NVR you can also use "Find cameras" on its page. Cameras that could not be placed automatically wait
on the **Reconciliation** page: a camera never gets a second identity without a person choosing so.

## 6. Camera groups (Groups)

Groups are sets of cameras people look at together ("all entrance doors", "cash counters of UP-1"). **A group never gives access**:
everybody sees only the cameras of a group that their own rights allow.

1. "Make a group": a name. Then add cameras: "Choose a location" → "Show cameras" → tick → "Add selected cameras"; or "Add by name"
   (every camera whose name contains a word, for example `entrance`).
2. Rules (cameras added automatically): by region, cluster, location, NVR or a word in the camera name; new cameras that match join
   the group by themselves.
3. Operators, administrators and super administrators may make and change groups (with live view of the cameras they add).
4. From a live wall, "Add to group" puts the camera you are looking at into a group.

## 7. People (Admin → Users)

1. "Add a person": e-mail, name, role, home location (for information only: it gives no access). Drishti makes a **one-time password**,
   shown once: give it to the person **in person**; at the first sign-in they choose their own.
2. Then "Assign access next" (§8): a new person sees nothing until rights are given.
3. Deactivate a person who leaves: every sign-in and every open video of theirs ends at once (within 60 seconds for open video); their
   history stays. "Sign out everywhere…" ends their sign-ins without deactivating them (a lost laptop). A super administrator can
   "Reset two-step sign-in…" (a lost phone; a reason is required and recorded first).
4. "One-time password" again (a forgotten password): same rule, give it in person.

## 8. Rights (Users → the person → Access)

Rights are explicit: a **capability** at a **place**.

| Capability | Lets the person |
|---|---|
| `cctv.live` | watch live video |
| `cctv.playback` | search and play recordings (1× and fast playback) |
| `cctv.export` | save recordings to a file (IT administrators only, decision E-1) |
| `it.inventory.view`, `it.monitoring.view` | see devices, NVR states and addresses (IT) |
| `admin.users`, `admin.access`, `admin.inventory`, `admin.audit.read` | the administration pages (with an administrator role) |

Places: the whole organisation, a region, a cluster, a location, one NVR, or single cameras. Rules: rights **add up** (a camera grant
never narrows a location grant); a grant on a region or cluster covers locations added to it later; live, playback and export are
separate (live does not give playback).

1. "Add access": choose the places (search by code or name), tick each right for each place, optionally "Valid until" (the right ends at
   midnight IST after that day) and a reason. Presets help (for example "Location IT viewer").
2. **"Check the effect"** — the effective-access preview: how many cameras, locations and assets each right adds or removes, with
   examples, before anything is saved. "Save these changes" saves exactly what was checked; if somebody else changed this person's access
   in the meantime you are asked to check again.
3. To remove a right: "Remove…" with a reason (kept in the history). Open video of a removed camera stops within 60 seconds.
4. **Access review** (Admin → Access review): rights moved over from the old rules (home location, manager or administrator role) are
   marked for review: keep them, remove them, or replace them with narrower ones.
5. Check the result: sign in as the person (or ask them) and look at Live — they must see exactly the cameras you meant.

## 9. Two-step sign-in (multi-factor)

Required for administrators and super administrators once it is switched on; optional for everybody else (Security page → "Set up
two-step sign-in" with an authenticator app). Switching it on is a server step for the owner (runbook-tls.md section 5): every
administrator sets up their app **before** the switch (the Users page shows who has), then the owner switches it on per organisation.
A lost phone: a super administrator resets it (§7.3).

## 10. Checking on the system

- **Health** (Admin → Health, super administrators): database, Vault (saved NVR logins), video gateway, monitoring worker (and who holds
  its lease), clocks, database version against the release, free disk space, the clean-up of unused video sessions, and the test
  fixture switch (a "Problem" in production means the database was seeded for tests: see update-rollback.md section 1), and the last
  good backup ("Problem" in production when it is older than 26 hours: the nightly backup stopped). A worker kept stopped on purpose
  (`DRISHTI_WORKER_EXPECTED=false`) is "Needs attention", not a problem. Each check says
  "OK", "Needs attention", "Problem" or "Not known", with what to do. Problems: `docs/drishti/runbooks/incidents.md`.
- **Monitoring** (Admin → Monitoring): is the checker running, what it found, NVRs that refuse their login, the gaps when it was not
  running, the video gateway.
- **Audit log** (Admin → Audit log, needs `admin.audit.read`): actions or sign-ins, filtered by category, what happened, a person, a day
  range, or a search word. The application cannot change or remove entries: not the web app, the worker, the video path or the
  service key. Only a database superuser (the person who runs the database server) could, so keep that login with the owner. The
  tamper-evident chain that would show such a change (D-15) comes later.
- **Health page disks**: the free space of the data disk (`DRISHTI_DATA_DIR`) and of the backup disk (`DRISHTI_BACKUP_DIR` in
  `web.env`, the same folder as `BackupDir` in `drishti.config.psd1`); the fuller one decides the colour.
