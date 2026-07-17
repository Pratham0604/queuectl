const jobModel = require('../jobModel');
const db = require('../db');

const STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

function run() {
  const summary = jobModel.statusSummary();
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const row of summary) {
    counts[row.state] = row.count;
  }

  console.log('Job Status Summary');
  console.log('------------------');
  for (const state of STATES) {
    console.log(`${state.padEnd(12)}: ${counts[state]}`);
  }

  const workers = db.prepare('SELECT pid, started_at FROM workers ORDER BY started_at ASC').all();
  console.log('\nActive Workers');
  console.log('--------------');
  if (workers.length === 0) {
    console.log('(none tracked)');
  } else {
    for (const w of workers) {
      console.log(`PID ${w.pid}  started ${w.started_at}`);
    }
  }
}

module.exports = { run };