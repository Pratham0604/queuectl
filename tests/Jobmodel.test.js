const fs = require('fs');
const path = require('path');
const os = require('os');

function cleanupDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

describe('jobModel', () => {
  let jobModel;
  let tmpDbPath;

  beforeEach(() => {
    jest.resetModules();
    tmpDbPath = path.join(os.tmpdir(), `queuectl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.QUEUECTL_DB_PATH = tmpDbPath;
    jobModel = require('../src/jobModel');
  });

  afterEach(() => {
    delete process.env.QUEUECTL_DB_PATH;
    cleanupDbFiles(tmpDbPath);
  });

  test('enqueue creates a pending job with defaults', () => {
    const job = jobModel.enqueue({ id: 'job1', command: 'echo hi' });
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.max_retries).toBe(3); // default from config
  });

  test('enqueue rejects duplicate ids', () => {
    jobModel.enqueue({ id: 'job1', command: 'echo hi' });
    expect(() => jobModel.enqueue({ id: 'job1', command: 'echo hi' })).toThrow(/already exists/);
  });

  test('enqueue rejects jobs missing required fields', () => {
    expect(() => jobModel.enqueue({ id: 'job1' })).toThrow();
    expect(() => jobModel.enqueue({ command: 'echo hi' })).toThrow();
  });

  test('claimNextJob marks a job processing and prevents a second claim', () => {
    jobModel.enqueue({ id: 'job1', command: 'echo hi' });

    const claimed = jobModel.claimNextJob('worker-a');
    expect(claimed.id).toBe('job1');
    expect(claimed.state).toBe('processing');
    expect(claimed.locked_by).toBe('worker-a');

    // No other pending job exists, so a second worker gets nothing --
    // this is the core "no duplicate processing" guarantee.
    const secondClaim = jobModel.claimNextJob('worker-b');
    expect(secondClaim).toBeNull();
  });

  test('claimNextJob returns null when queue is empty', () => {
    expect(jobModel.claimNextJob('worker-a')).toBeNull();
  });

  test('markCompleted transitions a job to completed', () => {
    jobModel.enqueue({ id: 'job1', command: 'echo hi' });
    jobModel.claimNextJob('worker-a');
    const completed = jobModel.markCompleted('job1');
    expect(completed.state).toBe('completed');
  });

  test('markFailed retries with backoff until max_retries, then moves to DLQ', () => {
    jobModel.enqueue({ id: 'job1', command: 'false', max_retries: 2 });

    jobModel.claimNextJob('worker-a');
    let job = jobModel.markFailed('job1', 'exit code 1');
    expect(job.state).toBe('pending'); // attempts=1 < max_retries=2, retry scheduled
    expect(job.attempts).toBe(1);
    expect(job.next_run_at).not.toBeNull();

    // Force-claim again regardless of next_run_at by manipulating claim
    // directly is not exposed, so we simulate the second failure directly.
    job = jobModel.markFailed('job1', 'exit code 1 again');
    expect(job.state).toBe('dead'); // attempts=2 >= max_retries=2 -> DLQ
    expect(job.last_error).toMatch(/exit code 1 again/);
  });

  test('dlqList only returns dead jobs', () => {
    jobModel.enqueue({ id: 'job1', command: 'false', max_retries: 1 });
    jobModel.claimNextJob('worker-a');
    jobModel.markFailed('job1', 'boom'); // attempts=1 >= max_retries=1 -> dead immediately

    const dead = jobModel.dlqList();
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe('job1');
  });

  test('dlqRetry resets a dead job back to pending', () => {
    jobModel.enqueue({ id: 'job1', command: 'false', max_retries: 1 });
    jobModel.claimNextJob('worker-a');
    jobModel.markFailed('job1', 'boom');
    expect(jobModel.getById('job1').state).toBe('dead');

    const retried = jobModel.dlqRetry('job1');
    expect(retried.state).toBe('pending');
    expect(retried.attempts).toBe(0);
    expect(retried.last_error).toBeNull();
  });

  test('dlqRetry throws for a job not in the DLQ', () => {
    jobModel.enqueue({ id: 'job1', command: 'echo hi' });
    expect(() => jobModel.dlqRetry('job1')).toThrow(/not in the DLQ/);
  });

  test('statusSummary counts jobs per state', () => {
    jobModel.enqueue({ id: 'job1', command: 'echo hi' });
    jobModel.enqueue({ id: 'job2', command: 'echo hi' });
    jobModel.claimNextJob('worker-a');

    const summary = jobModel.statusSummary();
    const map = Object.fromEntries(summary.map((r) => [r.state, r.count]));
    expect(map.pending).toBe(1);
    expect(map.processing).toBe(1);
  });
});
