# Worker lease and fencing (P2-7, WP-2.5, decision D-8, tracker SO-14)

The monitoring worker used to refuse to start when another worker's heartbeat was still moving (`lib/monitor/guard.ts`). That was
check-then-act: two workers started within one poll interval both passed, and a worker that was paused (a laptop lid, a VM pause, a long
garbage collection, a network cut) and then resumed carried on writing next to its replacement. P2-7 replaces it with an atomic lease and a
fencing token that the database checks on every worker write. `lib/monitor/guard.ts` and its tests are gone.

| Piece | Where |
|---|---|
| Table, functions, fence, grants, `privilege_violations()` | `supabase/migrations/20261021000036_p27_worker_lease.sql` (rollback `supabase/rollback/20261021000036_p27_worker_lease_rollback.sql`); review round 1: `20261021000039_p27_review_fixes.sql` (scoped fences, per-epoch late-result rule, future results dated now(), new epoch on every acquisition, `worker_rows_guard`; rollback `supabase/rollback/20261021000039_p27_review_fixes_rollback.sql`) |
| Lease client (acquire, renew, release, local deadline, epoch fences) | `lib/monitor/lease.ts` (`WorkerLease`) |
| Standby / active / lost / stopped | `lib/monitor/supervisor.ts` (`WorkerSupervisor`) |
| Fenced writes of the data layer | `lib/monitor/supabase-db.ts` (option `fence`) |
| Runner stop on a lost lease | `lib/monitor/runner.ts` (`abandon()`), `lib/monitor/checks.ts` (`deps.signal`) |
| Worker entry point | `services/worker/index.ts` |
| Lease in the worker status | `lib/monitor/health.ts` (`getWorkerLease`, `WorkerStatus.lease`) |
| Tests | `tests/unit/worker-lease.test.ts`, `tests/unit/worker-supervisor.test.ts`, `tests/unit/monitor-db-fence.test.ts`, `tests/integration/worker-lease.test.ts` |

## 1. The lease

`worker_leases (name, holder uuid, lease_until, fencing_token bigint, holder_info jsonb, acquired_at, renewed_at, released_at)`, one row
per lease name. Nobody holds INSERT, UPDATE or DELETE on it (only its functions write it, as the database owner); the web app and the
service role may read it.

- **`worker_acquire_lease(name, holder, ttl_sec = 20, holder_info = {})`** is ONE statement:
  `INSERT … ON CONFLICT (name) DO UPDATE … WHERE lease_until <= now() OR released_at IS NOT NULL OR holder = p_holder`.
  A free name gets token 1. A held name is taken only when its lease has ended (or been released), or when the caller already holds it.
  Every acquisition is a new epoch with `fencing_token + 1`: a takeover, the same holder after its own lease ended, and (review round 1,
  M-2, migration 0039) also the live holder asking again (a worker that gave its lease up locally and takes it back can never have a
  request of its old epoch accepted in the new one); only a renewal keeps a token. It returns `acquired, fencing_token, lease_until` and, when refused, `retry_after_ms` (how long the current lease still runs, on
  the database clock). Two callers at once: the second one waits for the first one's row lock and then sees a live lease, so exactly one
  of them gets it (test (a): 12 at once through PostgREST, 8 `WorkerLease` objects at once).
- **`worker_renew_lease(name, holder, fencing_token, ttl_sec)`** extends the lease only for the same holder AND token while
  `lease_until > now()`. A stale token, another holder, a released lease or one that has ended (even with nobody else holding it) is
  refused: an ended lease is lost, and the worker must take it again as a new epoch (test (c)).
- **`worker_release_lease(name, holder, fencing_token)`** sets `lease_until = now()` and `released_at`; another worker can take it at once
  with token + 1 (test (h)). The worker releases on a graceful stop, after its runner has finished.
- Name: lower-case letters, digits, `-`, `_`, parts separated by `:` (`monitor`, `monitor:shard-3`, `test:<uuid>`); TTL 1..900 s; holder
  information a JSON object of at most 2 KB (host name and process id; never anything secret).
- **Only the database clock decides who holds the lease.** Every lease decision compares with `now()` in the database. The worker never
  reads its wall clock for the lease (test (f): a worker clock in 2039 or 1999 changes nothing; the unit test fails if `Date.now` is
  called). This is about the LEASE only: other parts of monitoring still compare the worker's clock with other clocks (section 9).

## 2. The fence and the locking argument

Every worker write is a database function that first runs `worker_fence(p_lease, p_fencing_token)` in the same transaction:

```sql
SELECT fencing_token, lease_until, released_at FROM public.worker_leases WHERE name = p_lease FOR SHARE;
-- refused (SQLSTATE WL001) unless: a row exists, fencing_token = p_fencing_token, released_at IS NULL and lease_until > now()
```

**Why a refused write can never interleave with a takeover.** acquire, renew and release change the lease row, so they take its row lock
in `FOR NO KEY UPDATE` mode (an `UPDATE` of non-key columns, or `ON CONFLICT DO UPDATE`). `FOR SHARE` conflicts with that mode (`FOR KEY
SHARE` would not, which is why it is not used). PostgREST runs each call in its own transaction, so:

1. **A fenced write started first.** Its `FOR SHARE` lock is held until it commits. A takeover that arrives meanwhile waits for the lock.
   When the write commits, the takeover re-reads the row (READ COMMITTED re-check) and only then hands out token + 1. Every row the
   write changed is therefore committed BEFORE the new holder exists. (Test (d), locking argument: a batch held open for 8 s in its own
   session; the takeover waited, then got token + 1; the whole batch was applied.)
2. **A takeover started first.** If it has committed, the write's `FOR SHARE` reads the new row: the token differs, refused. If it has not
   committed yet, the write's `FOR SHARE` waits for it, then reads the new row: refused. Either way nothing of the write is applied.
3. **The lease ran out but nobody took it yet.** `lease_until > now()` is false: refused (an ended lease is not this worker's any more,
   even before someone else takes it).

**All or nothing.** The fence runs first and a refusal raises, so the whole call is rolled back: a batch of results is applied whole or
not at all (test (d): 6 races of a 10-result batch against a takeover, each 0 or 10; a batch sent after the takeover: 0 of 20).

`now()` is the start of the write's transaction. A write that began while the lease was valid and runs past `lease_until` still
completes; that is safe, because by case 1 no one can take the lease over until it has committed.

Deadlocks: a write takes the lease row (share) and then target rows (`check_state … FOR UPDATE`); acquire, renew and release take only
the lease row. No cycle is possible. Starvation: a renewal waits for the writes in progress (milliseconds each, at most
`recorderConcurrency` = 10 at a time); with renewals every 5 s and a 20 s TTL there are three more chances before the lease would end.

## 3. What is fenced

| Write | Function | Notes |
|---|---|---|
| Check results (devices, recorders, cameras through their active mapping; the location roll-ups are views over them) | `monitor_apply_results(org, results, threshold, lease, token)` | the 3-argument version is DROPPED, so an unfenced call cannot even resolve; threshold no longer optional |
| Heartbeat | `monitor_heartbeat(lease, token, at)` | |
| Gaps | `monitor_record_gap(lease, token, from, to)` | |
| Round times | `monitor_mark_round(lease, token, kind, at)` | kind `assets` (devices and NVRs) or `cameras` |
| Run start, progress, finish ("check now") | `monitor_run_started`, `monitor_run_progress`, `monitor_run_finished` | |
| Camera addresses reported by an NVR (discovery during a round) | `monitor_save_camera_ips(lease, token, org, rows)` | only while the camera is still on that recorder; plain addresses only |

**The fence is scoped to the rows it protects** (review round 1, M-1, migration 0039). The global worker rows (heartbeat, gaps, round
times, run start/progress/finish) go through `worker_fence_global`: only the lease `monitor`, and a `test:` lease only from the service
role (the tests and the worker's development key). Results and camera addresses go through `worker_fence_org`: `monitor` or a shard
`monitor:<n>`, and a `test:` lease only for a test organisation. Any other name is refused with SQLSTATE **WL002** ("this lease may not
write these rows"; an ordinary error in the worker, not a lost lease); no lease at all stays WL001. So a worker built with another lease
name can never write the global rows next to the real one.

The worker's direct table writes of P2-6 (`worker_state` columns, `monitor_gaps` INSERT, `cameras.camera_ip`) are revoked, and
`privilege_violations()` now reports any table or column write held by `monitor_worker`, any function it may execute without a
`p_fencing_token` argument (except `worker_acquire_lease`, the logged credential read and the three housekeeping prunes), any such
function that takes the argument but whose source never names `worker_fence` (review M-7; renew and release are the exceptions), any
grant on `worker_fence`, `worker_fence_global`, `worker_fence_org` or `worker_rows_guard`, and any write on `worker_leases` (each probed in
a rolled-back transaction in the integration test). Limit: the detector reads the source text; it does not prove the fence runs on every
path (every fenced function calls it as its first statement, and each one has a refusal test).

**Old worker code on the service key** (review M-5). The P2-6 worker wrote `worker_state` and `monitor_gaps` directly; on its own key
(`monitor_worker`) that is refused by the grants. On the development fallback (the service key) the trigger `worker_rows_guard` refuses
direct INSERT/UPDATE of both tables (42501, "written only by the worker's fenced functions"), so an old worker no longer looks alive: its
heartbeat and start-up gap are refused and its results find no function (PGRST202). The fenced functions and `monitor_request_check` run
as the owner and are not affected. Test fixtures that set and restore these rows send the header `x-drishti-test-fixture: on`; this is a
guard against old code, not a security boundary (the service key is trusted with everything else). An old worker can still write a
camera address directly (`cameras.camera_ip`, harmless); stop every old worker before starting the new one.

Not fenced, deliberately: the housekeeping prunes (`rate_limit_prune`, `media_sessions_prune`, `vault_reads_prune`) delete rows by age
only; two runs are harmless. The worker runs them only while it holds the lease. Credential reads are reads (logged per read).
Later alert and incident writes must take `p_fencing_token` too; `privilege_violations()` will report them otherwise.

**SQL late-result guard (D-8, scoped in review round 1, I-1).** Result times are the worker's clock. `monitor_apply_results`:
1. dates a result that is more than 30 s ahead of the database's `now()` at `now()` (a worker clock running ahead, even by days, can no
   longer push `last_checked_at` into the future and freeze the target until then);
2. skips a result older than its target's `last_checked_at` only when it comes from the SAME lease and the same or an older fencing
   token (`check_state.applied_lease`, `applied_fencing_token` remember who applied the last one). A newer epoch always applies: the
   fence already guarantees that an older epoch cannot write after a takeover, and the new holder's clock may be behind the old one's.
A result at the same time is applied. Tests: a clock three days ahead, then a normal result; a takeover by a worker an hour behind;
a late result of the same epoch (skipped).

## 4. The worker

`WorkerSupervisor` (`services/worker/index.ts` runs it):

- **standby**: `WorkerLease.acquire` tries until it holds the lease. While another worker holds it, it retries just after that lease
  would end (`retry_after_ms`, at most the TTL); while the database cannot be reached, after 1, 2, 4, … up to 30 s. It never crashes on a
  database error and logs each kind of failure once (`lease_standby`, `lease_acquire_failed`).
- **active**: a NEW `MonitorRunner` per epoch, whose `SupabaseMonitorDb` carries that epoch's fence (`WorkerLease.fence()`): every write
  sends `p_lease` and `p_fencing_token`; without a valid token nothing is sent (`LeaseLostError`). The lease is renewed every 5 s with a TTL
  of 20 s.
- **lost** (`lease_lost`, logged once per epoch) when a renewal is refused, when the database refuses a write (WL001), or when the local
  deadline passes without a good renewal. The runner is abandoned at once (`abandon()`: no timer fires again, the checks in progress probe
  no further target and send nothing, nothing is written on the way out), and the worker goes back to standby.
- **stopped**: on SIGINT/SIGTERM/SIGBREAK the runner finishes what it can within 15 s (its last writes still fenced with a valid token),
  then the lease is released so that another worker can take it at once. A lease taken just as the stop arrives (an acquisition already
  on its way) is released at once too; a release waits at most 3 s for the database, so a stop never hangs on it (review M-3).

Logs carry the fencing token as `epoch` (`lease_acquired`, `lease_lost`, `lease_released`, `worker_started`): a token is no secret and is
the main diagnostic, but the logger hides every field whose name contains "token" (review M-6).

**The local deadline.** The worker uses a token only until *(time the last good acquisition or renewal was SENT) + TTL − 2 s*, measured on
its monotonic clock (`performance.now`). The database set `lease_until` from its own `now()`, which is no earlier than the moment the
request was sent, so the worker stops using a token before the database would refuse it, whatever the two wall clocks say. A watchdog
timer ends the epoch at that deadline even when every database call hangs (a paused or cut-off worker), so it stops all work on its own.

**Epoch fences.** A fence is bound to one acquisition. When the worker loses the lease and takes it again, the old runner's fence stays
shut, and since review round 1 the database gives a new token too, so neither a new send nor a request of the old epoch already on its
way is accepted in the new one.

Housekeeping runs only while the supervisor is active. Health: `getWorkerStatus().lease` (holder, token, taken, renewed, `held`,
`renewedAgeSec`, holder information) for the admin pages; the public `/api/health` answer is unchanged (no holder ids in public).

## 5. "Check now" across a takeover

Decision: `check_requested_at` **stays in `worker_state`** (the brief's simplest correct option). It is written by the web app
(`monitor_request_check`, stamped with the database clock) and is a request, not a worker result, so it is not fenced. Everything the
worker writes to answer it (run start, progress, run finish) is fenced. A takeover in the middle of a run therefore cannot lose the
request: the new holder's start-up finds the run open (started after the request, not finished) and repeats it once, which closes it; the
old holder's late progress and finish are refused, so it can neither close the new run nor start another. Test (g): the request survives,
the new holder runs it exactly once over several polls, and the request time is untouched. A per-organisation `monitor_requests` table
would only matter once workers are sharded (one check for all organisations is how the checker works today).

## 6. Failure modes

| Situation | What happens |
|---|---|
| Two workers started together | exactly one acquires; the other waits in standby and logs it once |
| The holder stops cleanly | it releases; the standby worker takes over within its next retry (at most 20 s, usually at once) |
| The holder crashes or is killed | its lease ends 20 s after its last renewal; the standby worker takes over with token + 1 |
| The holder is paused (VM, sleep, debugger) and resumes | it stopped using its token at its local deadline (watchdog); every request it had already sent reaches the database after the takeover and is refused (WL001); its renewal is refused; it goes to standby (test (b)) |
| The database is unreachable | renewals fail; the token is kept until the local deadline, then given up (nothing is sent without it); the worker retries with back-off and takes the lease again when the database is back (a new epoch, test (i)) |
| A renewal is slow | the deadline counts from when it was sent, never from the answer |
| Clocks differ between worker and database | irrelevant for WHO holds the lease (database clock only); results are dated by the worker: more than 30 s ahead is dated at the database's now(), a clock behind makes results look old ("Not checked lately"); the worker logs `worker_clock_skew` and the worker status shows `clockSkewSec` / `clockSkewWarning` (section 9) |
| A late result of an earlier round | skipped by the SQL guard when it is from the same epoch; a newer epoch always applies |
| An old (P2-6) worker is still running | on its own key: refused by the grants; on the service key: its direct worker_state / gap writes are refused by `worker_rows_guard`, its results find no function; it shows as not running. Stop it. |
| A worker built with another lease name | refused for the global rows (WL002); results only under `monitor` / `monitor:<n>` |
| Someone writes `worker_leases` by hand | only the database owner can; `privilege_violations()` reports any other write grant |

## 7. Sharding seam

The lease name is a parameter (`WorkerLease({ name })`, default `monitor`), and every fenced function takes the lease name with its
token. Two names are held by two workers at the same time and a token is valid only for its own name (tests). The worker entry point does
NOT offer the name as a setting yet: a shard worker would still check every target. Sharding needs the targets split first (for example
locations by hash into `monitor:shard-<n>`, the fence then also checking that a result's target belongs to the shard), and `worker_state`
per lease name instead of the single global row.

## 8. Operating notes

- One worker per database is still the normal set-up; a second one started by mistake now waits harmlessly in standby.
- Tests use lease names `test:<uuid>` (and `monitor:test-<uuid>` for the shard-name case) only, never `monitor` (`tests/setup/lease.ts`);
  the test helpers `worker_lease_set_until_test` and `worker_lease_forget_test` refuse any other name and are for the service role only.
  The tests that need a second database session (psql in the database container) FAIL when Docker cannot be reached, unless
  `DRISHTI_SKIP_DOCKER_TESTS=1` says on purpose that this run has none.
- Rolling back: stop the worker; roll back 0039 first (worker code of commit `6d37b98`), then 0036 (worker code of commit `9956ae7`);
  each rollback script has a dry run (`-v drishti_dry_run=1`).

## 9. Clock comparisons that remain (review M-8)

The lease itself uses the database clock only. These comparisons still mix clocks:

| Comparison | Clocks | Effect of a difference |
|---|---|---|
| Result times vs `last_checked_at` | worker (results) vs earlier results; the 30 s future limit vs the database | ahead > 30 s: dated now(); behind: results look old, a target can show "Not checked lately"; a takeover always applies (section 3) |
| "Check now": `check_requested_at` vs `run_started_at` | database vs worker | a worker clock behind the database by more than a run's time can repeat a run once; ahead can make a request look answered until its next run |
| Heartbeat age on the pages and `/api/health` | worker (heartbeat) vs web server | the worker can look stopped or alive for longer by the difference |
| Gaps (silences between beats, start-up gap) | worker | none between machines; a clock step on the worker makes one gap longer or shorter |
| The check-now cooldown | web server vs worker (`run_finished_at`) | the 30 s cooldown is longer or shorter by the difference |

The worker's clock difference is measured at every heartbeat (`worker_state.heartbeat_db_at` next to `last_heartbeat`), logged once
beyond 30 s (`worker_clock_skew`) and shown as `WorkerStatus.clockSkewSec` / `clockSkewWarning`. Keep the worker's computer on time sync.
