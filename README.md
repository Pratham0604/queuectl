# QueueCTL

A CLI-based background job queue system with worker processes, automatic
retries using exponential backoff, and a Dead Letter Queue (DLQ) for jobs
that permanently fail — all backed by persistent SQLite storage.

```
queuectl enqueue '{"id":"job1","command":"sleep 2"}'
queuectl worker start --count 3
queuectl status
```

## Table of Contents

1. [Setup Instructions](#setup-instructions)
2. [Usage Examples](#usage-examples)
3. [Architecture Overview](#architecture-overview)
4. [Assumptions & Trade-offs](#assumptions--trade-offs)
5. [Testing Instructions](#testing-instructions)

---

## Setup Instructions

**Requirements:** Node.js 18+ and npm.

```bash
git clone <this-repo-url>
cd queuectl
npm install
npm link          # makes the `queuectl` command available globally
```

`npm link` registers `queuectl` as a global command backed by this
directory. If you'd rather not use a global link, you can always run it
locally instead:

```bash
node bin/queuectl.js <command>
```

The first time any command runs, a SQLite database file is created at
`data/queuectl.db` (auto-created, gitignored). No separate database server
is required — everything is self-contained.

To uninstall the global link later: `npm unlink -g queuectl` (run from the
project directory, or `npm rm -g queuectl`).

---

## Usage Examples

### Enqueue a job

```bash
$ queuectl enqueue '{"id":"job1","command":"echo Hello World"}'
Job enqueued: job1 (state=pending, max_retries=3)
```

A job only requires `id` and `command`. Optional: `max_retries` (defaults
to the current `max-retries` config value).

```bash
$ queuectl enqueue '{"id":"job2","command":"false","max_retries":2}'
Job enqueued: job2 (state=pending, max_retries=2)
```

### Start workers

```bash
$ queuectl worker start --count 3
Started 3 worker(s): PID(s) 4821, 4822, 4823
Workers run detached in the background, logging to /path/to/queuectl/data/logs
Use "queuectl worker stop" to stop them.
```

Workers run as independent, detached OS processes (real parallelism, not
just concurrent async tasks in one process), and log their activity to
`data/logs/`.

### Check status

```bash
$ queuectl status
Job Status Summary
------------------
pending     : 0
processing  : 0
completed   : 1
failed      : 0
dead        : 1

Active Workers
--------------
PID 4821  started 2026-07-18T04:20:00.000Z
PID 4822  started 2026-07-18T04:20:00.000Z
PID 4823  started 2026-07-18T04:20:00.001Z
```

### List jobs

```bash
$ queuectl list
job1  [completed]  attempts=0/3  command="echo Hello World"
job2  [dead]  attempts=2/2  command="false"  last_error="exit code 1"

$ queuectl list --state pending
No jobs in state "pending"
```

### Dead Letter Queue

```bash
$ queuectl dlq list
job2  attempts=2/2  command="false"  last_error="exit code 1"

$ queuectl dlq retry job2
Job "job2" moved from DLQ back to pending
```

### Configuration

```bash
$ queuectl config list
Current Configuration
----------------------
max-retries = 3
backoff-base = 2

$ queuectl config set max-retries 5
Config "max-retries" set to "5"
```

`max-retries` and `backoff-base` set here become the defaults used by
`enqueue` for any job that doesn't specify its own `max_retries`.

### Stop workers

```bash
$ queuectl worker stop
Sent SIGTERM to worker PID 4821 (will finish its current job before exiting)
Sent SIGTERM to worker PID 4822 (will finish its current job before exiting)
Sent SIGTERM to worker PID 4823 (will finish its current job before exiting)
```

Each worker finishes whatever job it's currently executing before it
exits — no job is killed mid-execution.

---

## Architecture Overview

### Storage: SQLite (not raw JSON)

The assignment allows either JSON files or an embedded DB. This project
uses **SQLite via `better-sqlite3`**, in WAL (Write-Ahead Logging) mode
with a busy timeout. The reason is concurrency: multiple worker
*processes* need to safely claim jobs from the same queue without
duplicating work. Hand-rolling that with JSON files means implementing
your own file locking; SQLite's transactional guarantees give you that
safety for free, while still being a single embedded file with zero
external services — the persistence story stays exactly as simple as
"one file on disk."

```
jobs table
├── id            TEXT PRIMARY KEY
├── command       TEXT
├── state         TEXT   (pending | processing | completed | failed | dead)
├── attempts      INTEGER
├── max_retries   INTEGER
├── next_run_at   TEXT   (ISO timestamp — backoff delay gate)
├── locked_by     TEXT   (which worker currently owns this job)
├── last_error    TEXT
├── created_at / updated_at

config table   — key/value store for max-retries, backoff-base
workers table  — tracks PIDs of currently running worker processes
```

### Job Lifecycle

```
pending --(claimed by worker)--> processing --(exit code 0)--> completed
                                      |
                                (non-zero exit / not found)
                                      |
                                      v
                          attempts < max_retries?
                              /            \
                           yes              no
                            |                 |
                            v                 v
              pending (next_run_at = now + base^attempts)   dead (DLQ)
```

`dlq retry <id>` resets a `dead` job back to `pending` with
`attempts = 0`, so it re-enters the normal lifecycle from scratch.

### Preventing duplicate processing (locking)

This is the core correctness requirement, and it's handled with one
atomic SQL statement wrapped in a transaction:

```sql
-- inside a single SQLite transaction
SELECT id FROM jobs
WHERE state = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)
ORDER BY created_at ASC LIMIT 1;

UPDATE jobs SET state = 'processing', locked_by = ?, updated_at = ?
WHERE id = ? AND state = 'pending';
```

Because the SELECT and UPDATE happen inside one transaction, and SQLite
serializes writers across processes (via WAL + file locking), two workers
racing this call can never both walk away with the same job — one gets
the job, the other's transaction sees `state != 'pending'` and gets
nothing. This is verified directly in `tests/jobModel.test.js` and
observable live by running multiple workers against a queue of jobs with
unique commands and checking the logs never show two workers claiming the
same job ID.

### Worker process model

`queuectl worker start --count N` uses Node's `child_process.fork()` to
spawn N fully independent OS processes running `src/worker.js`, detached
from the parent CLI process (so they keep running after the `worker
start` command returns) and with `stdio` redirected to per-worker log
files under `data/logs/`.

Each worker process runs a simple poll loop:

```
loop:
  if shutting_down: exit(0)
  job = claimNextJob()
  if job:
    execute job.command synchronously
    mark completed / failed (with backoff or DLQ)
  else:
    wait 500ms
  repeat
```

Job execution uses `execSync`, deliberately synchronous. Since a single
worker only ever processes one job at a time anyway, this has a useful
side effect: `SIGTERM` is only actually acted on by the JS event loop
*after* the current `execSync` call returns — so "finish current job
before exit" happens naturally rather than needing extra coordination
logic.

PIDs of started workers are recorded in the `workers` table so that
`queuectl worker stop`, even if run from a completely separate CLI
invocation later, can find and signal them.

### Exponential backoff

```
delay_seconds = backoff_base ^ attempts
```

computed in `src/scheduler.js` (kept isolated from the rest of the logic
specifically so it's trivial to unit test). `attempts` is the
post-increment count, so the first retry after one failure waits
`base^1` seconds, the second `base^2`, and so on, until `attempts`
reaches `max_retries`, at which point the job moves to `dead` instead of
being rescheduled.

---

## Assumptions & Trade-offs

- **SQLite over JSON**: chosen specifically because the assignment calls
  out "race conditions / duplicate job execution" as a disqualifying
  mistake, and safe concurrent access across separate OS processes is
  much harder to get right with plain JSON files than with a
  transactional embedded database.
- **Polling interval (500ms)**: workers poll for new work rather than
  being pushed to. Simple and reliable for a CLI tool of this scope; the
  trade-off is up to ~500ms latency before a freshly enqueued job gets
  picked up, which is unlikely to matter for a background job queue.
- **Synchronous job execution (`execSync`)**: each worker handles exactly
  one job at a time (this is what "N workers = N processes" means here).
  This simplifies graceful shutdown considerably, at the cost of a worker
  being blocked for the full duration of a long-running command — which
  is the expected/intended behavior for a worker process.
- **No job timeout by default**: a command that hangs forever will hang
  that worker forever. This was left as a bonus-feature trade-off per the
  assignment's own "optional" list rather than core scope.
- **`config set` applies to future enqueues only**: changing
  `max-retries` doesn't retroactively change `max_retries` on jobs
  already in the queue, since each job stores its own value at creation
  time. This matches the "per-job attempt budget" mental model.
- **Worker log files instead of inheriting the terminal**: detached
  background workers write to `data/logs/*.log` instead of the launching
  terminal, so `worker start` returns immediately and doesn't leave the
  invoking shell/script waiting on an open stdio pipe.
- **Errors are truncated to 500 chars** (`last_error` column) purely to
  keep the DB tidy for very verbose command failures.

---

## Testing Instructions

### Automated tests

```bash
npm test
```

This runs the full Jest suite (`tests/scheduler.test.js` and
`tests/jobModel.test.js`), covering:
- Backoff delay formula correctness across different bases/attempts
- Enqueue validation (required fields, duplicate ID rejection)
- Atomic claim behavior — a second worker cannot claim an already-claimed
  job (the core concurrency guarantee)
- Full retry → backoff → DLQ lifecycle
- DLQ retry resetting a job back to `pending`
- Status summary aggregation

Each test run uses an isolated temporary SQLite file
(`QUEUECTL_DB_PATH` env var) so tests never touch your real `data/queuectl.db`.

### Manual end-to-end verification

Covers all 5 scenarios called out in the assignment:

```bash
# 1. Basic job completes successfully
queuectl enqueue '{"id":"ok","command":"echo hello"}'
queuectl worker start --count 1
sleep 1
queuectl list --state completed   # should show "ok"

# 2. Failed job retries with backoff, then moves to DLQ
queuectl enqueue '{"id":"bad","command":"false","max_retries":2}'
sleep 3
queuectl dlq list                 # should show "bad" after 2 failed attempts

# 3. Multiple workers process jobs without overlap
queuectl worker start --count 3
for i in 1 2 3 4 5; do
  queuectl enqueue "{\"id\":\"batch-$i\",\"command\":\"sleep 1 && echo done-$i\"}"
done
sleep 3
cat data/logs/*.log                # confirm no job ID is claimed twice

# 4. Invalid commands fail gracefully
queuectl enqueue '{"id":"nope","command":"this-command-does-not-exist"}'
sleep 2
queuectl list --state dead          # eventually lands in DLQ, no crash

# 5. Job data survives restart
queuectl worker stop
queuectl status                     # counts persist even with 0 workers running
# (there's no separate "queuectl server" to restart — persistence is
#  verified by the fact every command above is a fresh, short-lived CLI
#  process reading the same data/queuectl.db file)
```

---

## Command Reference

| Category | Command | Description |
|---|---|---|
| Enqueue | `queuectl enqueue '{"id":"job1","command":"sleep 2"}'` | Add a new job |
| Workers | `queuectl worker start --count 3` | Start N workers |
| Workers | `queuectl worker stop` | Stop workers gracefully |
| Status | `queuectl status` | Job state summary + active workers |
| List | `queuectl list --state pending` | List jobs, optionally by state |
| DLQ | `queuectl dlq list` | List dead-lettered jobs |
| DLQ | `queuectl dlq retry job1` | Requeue a DLQ job |
| Config | `queuectl config set max-retries 3` | Set a config value |
| Config | `queuectl config list` | Show current config |

Run `queuectl --help` or `queuectl <command> --help` for built-in help at
any time.
