/**
 * Computes the exponential backoff delay, in seconds, before a failed
 * job's next retry attempt.
 *
 * delay = base ^ attempts
 *
 * @param {number} base - backoff base (config: backoff-base)
 * @param {number} attempts - number of attempts already made (post-increment)
 * @returns {number} delay in seconds
 */
function computeBackoffDelaySeconds(base, attempts) {
  return Math.pow(base, attempts);
}

function computeNextRunAt(base, attempts, fromDate = new Date()) {
  const delaySeconds = computeBackoffDelaySeconds(base, attempts);
  return new Date(fromDate.getTime() + delaySeconds * 1000).toISOString();
}

module.exports = { computeBackoffDelaySeconds, computeNextRunAt };
