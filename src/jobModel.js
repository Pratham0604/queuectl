const db = require('./db');
const config = require('./config');
const { computeNextRunAt } = require('./scheduler');

function nowIso() {
  return new Date().toISOString();
}

function getById(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function enqueue(job) {
  if (!job || !job.id || !job.command) {
    throw new Error('Job must include at least "id" and "command" fields');
  }

  const existing = getById(job.id);
  if (existing) {
    throw new Error(`Job with id "${job.id}" already exists`);
  }

  const maxRetries =
    job.max_retries !== undefined ? Number(job.max_retries) : parseInt(config.get('max-retries'), 10);
  const ts = nowIso();

  db.prepare(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, next_run_at, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)`
  ).run(job.id, job.command, maxRetries, ts, ts);

  return getById(job.id);
}

// Atomically finds the oldest eligible pending job and marks it "processing"
// in the SAME transaction, so two workers racing this call can never both
// claim the same job. SQLite's own file locking (WAL + busy_timeout) makes
// this safe across separate OS processes, not just separate calls in one
// process.
const claimTxn = db.transaction((workerId, now) => {
  const candidate = db
    .prepare(
      `SELECT id FROM jobs
       WHERE state = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(now);

  if (!candidate) return null;

  const result = db
    .prepare(`UPDATE jobs SET state = 'processing', locked_by = ?, updated_at = ? WHERE id = ? AND state = 'pending'`)
    .run(workerId, now, candidate.id);

  // If another transaction beat us to it between SELECT and UPDATE, changes
  // will be 0 (shouldn't normally happen since this whole block is one
  // transaction, but this is a defensive belt-and-suspenders check).
  if (result.changes === 0) return null;

  return getById(candidate.id);
});

function claimNextJob(workerId) {
  return claimTxn(workerId, nowIso());
}

function markCompleted(id) {
  db.prepare(`UPDATE jobs SET state = 'completed', locked_by = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  return getById(id);
}

function markFailed(id, errorMessage) {
  const job = getById(id);
  if (!job) throw new Error(`Job "${id}" not found`);

  const attempts = job.attempts + 1;
  const backoffBase = parseInt(config.get('backoff-base'), 10);
  const truncatedError = String(errorMessage || '').slice(0, 500);

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs SET state = 'dead', attempts = ?, last_error = ?, locked_by = NULL, updated_at = ?
       WHERE id = ?`
    ).run(attempts, truncatedError, nowIso(), id);
  } else {
    const nextRunAt = computeNextRunAt(backoffBase, attempts);
    db.prepare(
      `UPDATE jobs SET state = 'pending', attempts = ?, next_run_at = ?, last_error = ?, locked_by = NULL, updated_at = ?
       WHERE id = ?`
    ).run(attempts, nextRunAt, truncatedError, nowIso(), id);
  }

  return getById(id);
}

function listByState(state) {
  if (state) {
    return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC').all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
}

function statusSummary() {
  return db.prepare('SELECT state, COUNT(*) as count FROM jobs GROUP BY state').all();
}

function dlqList() {
  return listByState('dead');
}

function dlqRetry(id) {
  const job = getById(id);
  if (!job) throw new Error(`Job "${id}" not found`);
  if (job.state !== 'dead') {
    throw new Error(`Job "${id}" is not in the DLQ (current state: ${job.state})`);
  }

  db.prepare(
    `UPDATE jobs SET state = 'pending', attempts = 0, next_run_at = NULL, last_error = NULL, locked_by = NULL, updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), id);

  return getById(id);
}

module.exports = {
  enqueue,
  getById,
  claimNextJob,
  markCompleted,
  markFailed,
  listByState,
  statusSummary,
  dlqList,
  dlqRetry,
};
