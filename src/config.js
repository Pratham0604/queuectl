const db = require('./db');

const DEFAULTS = {
  'max-retries': '3',
  'backoff-base': '2',
};

function ensureDefaults() {
  const insert = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULTS)) {
    insert.run(key, value);
  }
}
ensureDefaults();

function get(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULTS[key];
}

function set(key, value) {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function all() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const merged = { ...DEFAULTS };
  for (const row of rows) merged[row.key] = row.value;
  return merged;
}

module.exports = { get, set, all, DEFAULTS };
