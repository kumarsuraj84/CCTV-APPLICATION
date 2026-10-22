# Importing locations and NVRs from a CSV file (administrator guide)

Screen: **Admin → Import → Locations and NVRs** (`/admin/import`). Who: an administrator (or super administrator) holding
`admin.inventory` for the whole organisation. Built in P2-5c-2 (`lib/import/locations-csv.ts`, `locations-plan.ts`, `locations-import.ts`,
migration `20261021000028`). The examples below use made-up data only (TEST-NET addresses, invented passwords).

## 1. How it works: check, then import

1. **Choose the file** (CSV, up to 5 MB, up to 5,000 rows).
2. **Check the file.** Nothing is saved. The screen shows:
   - counts: new / changing / unchanged locations and NVRs, passwords that would be saved, new cameras, new regions and clusters;
   - **Problems**, one line each with the **line number**, the **column** and a plain **reason** (for example: line 7, column `ip`,
     "“192.0.2.300” is not a valid IP address.");
   - **Worth a look**: things that are saved but may be a mistake (the same NVR address at two locations, an unknown column, a
     location already in another cluster);
   - what happens to each location and each of its NVRs ("New", "Changes: address, password", "No change"). Passwords are never shown —
     only **"Password: set"** or **"Password: unchanged"**;
   - **Not in the file**: locations of the organisation that the file does not list, NVRs of listed locations that the file does not
     list, cameras on channels above the number of cameras the file gives. They are only listed.
3. **Import.** The same plan is worked out again and must be exactly the one you checked (otherwise: "Something changed since you
   checked the file… Check the file again"). Then **everything is saved in one go, or nothing** (one database transaction): when the
   database refuses one location, nothing of the file is saved and the message names the line.

### All or nothing, or "Skip the rows with problems"

- By default a file with any problem is **not imported at all**. Fix the rows and check again.
- With **"Skip the rows with problems"** ticked, a location with a problem in **any** of its rows is left out **whole** (never half of
  its NVRs); the other locations are imported (still in one transaction).

### Archive, never delete — and only when you confirm

Nothing that is missing from the file is changed unless you tick **"Also archive these N items"** under "Not in the file". Archived
means switched off and hidden, **not deleted**: monitoring history, access grants, groups and the NVR passwords in the vault are kept,
and the item can be restored (Locations and NVRs → the item → Restore). Archiving is offered only for a file **without problems** (a bad
row could hide a location that *is* in the file). An archived NVR's cameras are archived with it; an archived location takes its NVRs
and cameras with it. Their live video streams are closed.

## 2. Columns

The first line names the columns (any order, any case; spaces and dashes count as underscores). Unknown columns are reported as
"not used". A cell left **empty keeps what is saved** (to clear a value, edit the location on its page).

| Column | Needed | Meaning |
|---|---|---|
| `code` | `code` or `name` | The location code (letters, numbers, dashes, up to 50, e.g. `JCL`). Stable: the identity of the location. |
| `name` | (legacy) | The legacy store file's name column. Used as the code (upper case) when there is no `code` column. |
| `display_name` | no | The name people see. A new location without one gets **"CODE - City"** (owner ruling). An existing location keeps a name a person edited; one still at its starting value ("CODE" or "CODE - City") follows the ruling. |
| `kind` | no | `store`, `head office` / `head_office`, `DC` / `distribution centre`, `warehouse`, `other`. New locations default to store. |
| `city`, `zone`, `state`, `address` | no | Plain attributes. Zone and state are tidied (e.g. `jh` → `Jharkhand`). |
| `cluster` | no | Cluster code. A **new** location is put in it. An existing location **without** a cluster joins it (a move: the access of people with grants on that cluster or its region changes at once; audited). An existing location in **another** cluster is **not moved** (warning): move it on its page, which shows the effect on access first. A missing cluster is created with its code as its name. |
| `region` | no, and only with `cluster` | Region code of the cluster (a location joins a region through its cluster). A missing region is created. An existing cluster in another region is not moved (warning). One cluster may not have two regions in one file. |
| `ip` | for an NVR | The NVR's IP address. A row **without** `ip` (and without the other NVR columns) is a location **without an NVR** (a head office). |
| `port` | no | The NVR's video (RTSP) port; default 554. |
| `http_port` | no | The NVR's web (HTTP) port; default 80. |
| `user` | with `ip` | The NVR user name. |
| `password` | for a new NVR | Written to the vault only (write-only). Empty keeps the saved one — **except** when the row changes the NVR's address or web port: then the password must be given again (review I-4: a saved password is only used for the address it was saved for). |
| `channels` | no | The number of cameras of the NVR (0–999). Cameras are made for channels 1..N that never had a camera on this NVR ("Camera N"; real names come from "Find cameras"). Empty keeps the saved number. |
| `nvr_name` | no | The NVR's name (e.g. "Ground floor"). New NVRs default to "NVR" (or "NVR 2", "NVR 3" when a location has several). |
| `monitoring` | no | `yes` / `no`. New NVRs are switched on unless `no`. `no` switches an NVR off (the reason saved is "Switched off by the CSV import."): nothing contacts it. Empty leaves an existing NVR as it is. |

**Several NVRs at one location:** one row per NVR, with the same `code`. The location columns may be repeated or left empty on the later
rows, but may not contradict the first row (that is a problem on the later row). The same NVR (address + web port) twice at one location
is a problem.

### The legacy store file keeps working

`name, city, zone, ip, port, http_port, user, password, channels` is read as "location + its main NVR + channels": the location by its
code (the name column), its NVR by address and web port — and when the address changed, the location's main NVR is updated (one row
per location), never a second NVR made.

## 3. Identity rules (why importing the same file again changes nothing)

- A **location** is matched by its **code** within the organisation (another organisation's locations are never seen or touched).
- An **NVR** is matched by **location + address + web port**; for a location with one row, by the legacy rule above.
- A **camera** is matched by **NVR + channel**. A channel that ever had a camera on that NVR (archived or moved since) gets no new one.
- A password equal to the saved one is "unchanged" (compared inside the database; nothing is re-written). Unchanged NVRs are not even
  saved again (no audit noise).

So the second import of the same file shows every location "No change" and saves nothing.

## 4. Examples (made-up data)

Two stores, one with two NVRs, and a head office:

```
code,display_name,kind,city,zone,state,region,cluster,ip,port,http_port,user,password,channels,nvr_name,monitoring
SMP1,,store,Patna,BR,Bihar,EAST,EAST-1,192.0.2.10,554,80,viewer,change-me-1,16,Ground floor,yes
SMP1,,,,,,,,192.0.2.11,554,80,viewer,change-me-2,8,First floor,yes
SMP2,,store,Ranchi,JH,Jharkhand,EAST,EAST-1,192.0.2.12,554,80,viewer,change-me-3,12,,yes
HO1,Head office Kolkata,head_office,Kolkata,WB,West Bengal,,,,,,,,,,
```

Result: SMP1 "SMP1 - Patna" with two NVRs (24 cameras), SMP2 "SMP2 - Ranchi" (12 cameras), HO1 without an NVR; region EAST and cluster
EAST-1 created. The sample file `public/samples/locations-sample.csv` ("Download a sample file") is this example.

The legacy form:

```
name,city,zone,ip,port,http_port,user,password,channels
SMP3,Gaya,BR,192.0.2.20,554,80,viewer,change-me-4,8
```

## 5. From the command line (local stack only)

`npx tsx scripts/import-estate-local.ts "<path to the CSV>"` prints what the import would do — **counts only**, never a cell value
(problems as counts per column). Add `--apply` to save it (the same single transaction as the screen; `--skip-bad-rows` as the tick
box). It refuses to run against anything but the local stack on port 55321, and it never contacts an NVR.

## 6. After an import

- Run **Find cameras for all locations** (`/admin/locations/discover`) to replace the "Camera N" placeholders with the NVRs' own
  channel names; anything it cannot place goes to the reconciliation list (`/admin/reconciliation`).
- Planner statistics are refreshed automatically after a bulk import.
- Rename the created regions and clusters (they carry their code as their name) on **Regions and clusters**.
