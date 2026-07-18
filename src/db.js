const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Allow tests (and advanced users) to point at an isolated DB file.
const DB_PATH = process.env.QUEUECTL_DB_PATH || path.join(DATA_DIR, 'queuectl.db');

const db = new Database(DB_PATH);

// WAL mode + a busy timeout let multiple worker processes safely share
// one SQLite file without "database is locked" errors under normal load.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    command      TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_retries  INTEGER NOT NULL DEFAULT 3,
    next_run_at  TEXT,
    locked_by    TEXT,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workers (
    pid        INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
`);

module.exports = db;
