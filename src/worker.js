#!/usr/bin/env node

/**
 * Worker process. One instance of this file = one OS process = one worker.
 * `queuectl worker start --count N` forks N of these.
 *
 * Execution is intentionally synchronous (execSync) because each worker
 * only ever handles one job at a time anyway. This has a nice side effect
 * for graceful shutdown: SIGTERM is only actually acted on in the JS event
 * loop *after* the current synchronous execSync call returns, so "finish
 * the current job before exiting" falls out naturally instead of needing
 * manual coordination.
 */

const { execSync } = require('child_process');
const jobModel = require('./jobModel');

const WORKER_ID = `worker-${process.pid}`;
const POLL_INTERVAL_MS = 500;

let shuttingDown = false;

function log(message) {
  console.log(`[${WORKER_ID}] ${message}`);
}

process.on('SIGTERM', () => {
  log('received SIGTERM, will exit after the current job (if any) finishes');
  shuttingDown = true;
});

process.on('SIGINT', () => {
  log('received SIGINT, will exit after the current job (if any) finishes');
  shuttingDown = true;
});

function runJob(job) {
  log(`claimed job "${job.id}" -> executing: ${job.command}`);
  try {
    execSync(job.command, { stdio: 'inherit' });
    jobModel.markCompleted(job.id);
    log(`job "${job.id}" completed successfully`);
  } catch (err) {
    const exitInfo = err.status !== undefined ? `exit code ${err.status}` : err.message;
    jobModel.markFailed(job.id, exitInfo);
    const updated = jobModel.getById(job.id);
    if (updated.state === 'dead') {
      log(`job "${job.id}" failed (${exitInfo}) -> exhausted retries, moved to DLQ`);
    } else {
      log(`job "${job.id}" failed (${exitInfo}) -> will retry at ${updated.next_run_at}`);
    }
  }
}

function loop() {
  if (shuttingDown) {
    log('shutting down gracefully');
    process.exit(0);
  }

  let job = null;
  try {
    job = jobModel.claimNextJob(WORKER_ID);
  } catch (err) {
    log(`error while claiming job: ${err.message}`);
  }

  if (job) {
    runJob(job);
    setImmediate(loop);
  } else {
    setTimeout(loop, POLL_INTERVAL_MS);
  }
}

log('started, polling for jobs...');
loop();