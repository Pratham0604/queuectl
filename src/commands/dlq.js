const jobModel = require('../jobModel');

function list() {
  const jobs = jobModel.dlqList();
  if (jobs.length === 0) {
    console.log('DLQ is empty');
    return;
  }
  for (const job of jobs) {
    console.log(
      `${job.id}  attempts=${job.attempts}/${job.max_retries}  command="${job.command}"  last_error="${job.last_error || ''}"`
    );
  }
}

function retry(jobId) {
  try {
    const job = jobModel.dlqRetry(jobId);
    console.log(`Job "${job.id}" moved from DLQ back to pending`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { list, retry };
