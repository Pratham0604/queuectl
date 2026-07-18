#!/usr/bin/env node
const { Command } = require('commander');

const enqueueCmd = require('../src/commands/enqueue');
const workerCmd = require('../src/commands/workerCmd');
const statusCmd = require('../src/commands/status');
const listCmd = require('../src/commands/list');
const dlqCmd = require('../src/commands/dlq');
const configCmd = require('../src/commands/configCmd');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue system with retries, exponential backoff, and a Dead Letter Queue')
  .version('1.0.0');

program
  .command('enqueue <jobJson>')
  .description('Add a new job to the queue, e.g. \'{"id":"job1","command":"sleep 2"}\'')
  .action((jobJson) => enqueueCmd.run(jobJson));

const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .option('--count <n>', 'Number of workers to start', '1')
  .description('Start one or more workers in the background')
  .action((opts) => workerCmd.start(parseInt(opts.count, 10)));

worker
  .command('stop')
  .description('Stop all tracked workers gracefully (finishes current job first)')
  .action(() => workerCmd.stop());

program
  .command('status')
  .description('Show a summary of all job states and active workers')
  .action(() => statusCmd.run());

program
  .command('list')
  .option('--state <state>', 'Filter by state (pending, processing, completed, failed, dead)')
  .description('List jobs, optionally filtered by state')
  .action((opts) => listCmd.run(opts.state));

const dlq = program.command('dlq').description('View or retry jobs in the Dead Letter Queue');

dlq
  .command('list')
  .description('List all jobs currently in the DLQ')
  .action(() => dlqCmd.list());

dlq
  .command('retry <jobId>')
  .description('Move a job from the DLQ back to pending')
  .action((jobId) => dlqCmd.retry(jobId));

const config = program.command('config').description('Manage runtime configuration');

config
  .command('set <key> <value>')
  .description('Set a config value, e.g. "queuectl config set max-retries 3"')
  .action((key, value) => configCmd.set(key, value));

config
  .command('list')
  .description('Show current configuration values')
  .action(() => configCmd.list());

program.parse(process.argv);
