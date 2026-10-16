/**
 * Runs every evaluation demo in the order prd.md section 10 lists them.
 *
 * Each demo runs in its own child process so that a crash or a stray timer in
 * one cannot affect the next, and so the exit code of the whole run reflects
 * every demo.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const DEMOS = [
  ['Concurrent editing', 'concurrency-demo.js'],
  ['Deadlock detection', 'deadlock-demo.js'],
  ['ACID transactions', 'transaction-demo.js'],
  ['Crash recovery', 'recovery-demo.js'],
  ['Index versus full scan', 'index-benchmark.js'],
  ['Scheduling policies', 'scheduling-demo.js'],
  ['Buffer pool replacement', 'buffer-pool-demo.js']
];

const results = [];
for (const [label, file] of DEMOS) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL || 'warn' }
  });
  results.push({ label, status: result.status === 0 ? 'PASS' : 'FAIL' });
}

console.log('\n' + '='.repeat(74));
console.log('  DEMO SUMMARY');
console.log('='.repeat(74));
for (const { label, status } of results) {
  console.log(`  ${status.padEnd(6)} ${label}`);
}

const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n  ${results.length - failed} of ${results.length} demos passed.\n`);
process.exit(failed === 0 ? 0 : 1);
