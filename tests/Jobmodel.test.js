const fs = require("fs");
const path = require("path");
const os = require("os");

const dbPath = path.join(os.tmpdir(), "queuectl-test.db");

process.env.QUEUECTL_DB_PATH = dbPath;

const db = require("../src/db");
const jobModel = require("../src/jobModel");

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM workers").run();
});

afterAll(() => {
  db.close();

  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = dbPath + suffix;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
});

describe("jobModel", () => {

  test("enqueue creates a pending job with defaults", () => {
    const job = jobModel.enqueue({
      id: "job1",
      command: "echo hi"
    });

    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.max_retries).toBe(3);
  });

  test("enqueue rejects duplicate ids", () => {
    jobModel.enqueue({
      id: "job1",
      command: "echo hi"
    });

    expect(() =>
      jobModel.enqueue({
        id: "job1",
        command: "echo hi"
      })
    ).toThrow();
  });

  test("claimNextJob claims only once", () => {
    jobModel.enqueue({
      id: "job1",
      command: "echo hi"
    });

    const first = jobModel.claimNextJob("worker-1");

    expect(first.state).toBe("processing");

    const second = jobModel.claimNextJob("worker-2");

    expect(second).toBeNull();
  });

  test("markCompleted completes a job", () => {

    jobModel.enqueue({
      id: "job1",
      command: "echo hi"
    });

    jobModel.claimNextJob("worker");

    const job = jobModel.markCompleted("job1");

    expect(job.state).toBe("completed");
  });

  test("failed job retries before DLQ", () => {

    jobModel.enqueue({
      id: "job1",
      command: "false",
      max_retries: 2
    });

    jobModel.claimNextJob("worker");

    let job = jobModel.markFailed(
      "job1",
      "error"
    );

    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(1);
    expect(job.next_run_at).not.toBeNull();
  });

  test("job reaches DLQ after max retries", () => {

    jobModel.enqueue({
      id: "job1",
      command: "false",
      max_retries: 1
    });

    jobModel.claimNextJob("worker");

    const job = jobModel.markFailed(
      "job1",
      "boom"
    );

    expect(job.state).toBe("dead");
  });

  test("dlqRetry restores job", () => {

    jobModel.enqueue({
      id: "job1",
      command: "false",
      max_retries: 1
    });

    jobModel.claimNextJob("worker");

    jobModel.markFailed(
      "job1",
      "boom"
    );

    const job = jobModel.dlqRetry("job1");

    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.last_error).toBeNull();
  });

  test("statusSummary returns counts", () => {

    jobModel.enqueue({
      id: "job1",
      command: "echo"
    });

    jobModel.enqueue({
      id: "job2",
      command: "echo"
    });

    jobModel.claimNextJob("worker");

    const summary = jobModel.statusSummary();

    const map = Object.fromEntries(
      summary.map(r => [r.state, r.count])
    );

    expect(map.pending).toBe(1);
    expect(map.processing).toBe(1);
  });

});