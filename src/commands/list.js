const jobModel = require('../jobModel');

const VALID_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

function run(state) {
  if (state && !VALID_STATES.includes(state)) {
    console.error(`Invalid state "${state}". Must be one of: ${VALID_STATES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const jobs = jobModel.listByState(state);
  if (jobs.length === 0) {
    console.log(state ? `No jobs in state "${state}"` : 'No jobs found');
    return;
  }

  for (const job of jobs) {
    const parts = [
      job.id,
      `[${job.state}]`,
      `attempts=${job.attempts}/${job.max_retries}`,
      `command="${job.command}"`,
    ];
    if (job.next_run_at) parts.push(`next_run_at=${job.next_run_at}`);
    if (job.last_error) parts.push(`last_error="${job.last_error}"`);
    console.log(parts.join('  '));
  }
}

module.exports = { run };
