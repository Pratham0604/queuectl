const { fork } = require('child_process');
const path = require('path');
const db = require('../db');

const WORKER_SCRIPT = path.join(__dirname, '..', 'worker.js');

function start(count) {
  if (!Number.isInteger(count) || count < 1) {
    console.error('--count must be a positive integer');
    process.exitCode = 1;
    return;
  }

  const pids = [];
  for (let i = 0; i < count; i++) {
    const child = fork(WORKER_SCRIPT, [], {
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
    db.prepare('INSERT INTO workers (pid, started_at) VALUES (?, ?)').run(child.pid, new Date().toISOString());
    pids.push(child.pid);
  }

  console.log(`Started ${count} worker(s): PID(s) ${pids.join(', ')}`);
  console.log('Workers run detached in the background. Use "queuectl worker stop" to stop them.');
}

function stop() {
  const workers = db.prepare('SELECT pid FROM workers').all();

  if (workers.length === 0) {
    console.log('No tracked workers are currently running.');
    return;
  }

  for (const { pid } of workers) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to worker PID ${pid} (will finish its current job before exiting)`);
    } catch (err) {
      console.log(`Worker PID ${pid} was not running (already stopped)`);
    }
    db.prepare('DELETE FROM workers WHERE pid = ?').run(pid);
  }
}

module.exports = { start, stop };