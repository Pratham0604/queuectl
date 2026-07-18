const jobModel = require('../jobModel');

function run(jobJson) {
  let payload;
  try {
    payload = JSON.parse(jobJson);
  } catch (err) {
    console.error(`Invalid JSON payload: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const job = jobModel.enqueue(payload);
    console.log(`Job enqueued: ${job.id} (state=${job.state}, max_retries=${job.max_retries})`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { run };
