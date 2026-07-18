const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const WORKER_SCRIPT = path.join(__dirname, '..', 'worker.js');
const LOG_DIR = path.join(__dirname, '..', '..', 'data', 'logs');

function start(count) {
  if (!Number.isInteger(count) || count < 1) {
    console.error('--count must be a positive integer');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const pids = [];
  for (let i = 0; i < count; i++) {
    // Redirect the worker's stdout/stderr to a log file rather than
    // inheriting the parent's terminal. A detached background process
    // holding the launching terminal's stdio open can make the launching
    // shell/script appear to hang even though the worker itself is fine.
    const logPath = path.join(LOG_DIR, `worker-${Date.now()}-${i}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const child = fork(WORKER_SCRIPT, [], {
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
    });
    // fork() always opens an IPC channel; disconnecting it (we don't need
    // parent<->child messaging) and unref'ing the child lets THIS process
    // exit immediately instead of hanging around waiting on the channel.
    child.disconnect();
    child.unref();
    db.prepare('INSERT INTO workers (pid, started_at) VALUES (?, ?)').run(child.pid, new Date().toISOString());
    pids.push(child.pid);
  }

  console.log(`Started ${count} worker(s): PID(s) ${pids.join(', ')}`);
  console.log(`Workers run detached in the background, logging to ${LOG_DIR}`);
  console.log('Use "queuectl worker stop" to stop them.');
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
