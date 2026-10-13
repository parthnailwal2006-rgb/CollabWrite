/**
 * Demo 6 - Scheduling Comparison (prd.md section 10, item 6)
 *
 * Runs the same workload under FIFO and under round-robin and reports the
 * mean waiting and turnaround times.
 *
 * The workload is deliberately skewed: one "hot" document receives a burst of
 * requests while several other documents send one each. Under FIFO the later
 * arrivals queue behind the whole burst - the convoy effect. Under
 * round-robin the scheduler rotates across documents, so a document that sent
 * one request is served long before the burst drains.
 *
 * Total throughput is unchanged; what changes is who waits, which is exactly
 * the point of comparing scheduling policies.
 */

'use strict';

const { Scheduler, POLICIES } = require('../../src/engine/scheduler/Scheduler');
const { section, step, table, sleep, runDemo } = require('./harness');

const BURST = 16;
const OTHERS = 6;
const SERVICE_MS = 6;

/**
 * Runs the skewed workload under one policy.
 * @param {'FIFO'|'ROUND_ROBIN'} policy
 */
async function runWorkload(policy) {
  const scheduler = new Scheduler({ policy, workers: 2 });
  const pending = [];

  // The burst arrives first, which is what makes FIFO look bad.
  for (let i = 0; i < BURST; i += 1) {
    pending.push(scheduler.submit({ docId: 'hot', operation: 'edit' }, () => sleep(SERVICE_MS)));
  }
  for (let i = 0; i < OTHERS; i += 1) {
    pending.push(scheduler.submit({ docId: `doc-${i}`, operation: 'edit' }, () => sleep(SERVICE_MS)));
  }

  scheduler.start();
  await Promise.all(pending);

  const metrics = scheduler.getMetrics();
  const quiet = scheduler.completed.filter((task) => task.docId !== 'hot');
  const quietWait = quiet.reduce((sum, task) => sum + task.waitingMs, 0) / quiet.length;

  return { scheduler, metrics, quietWait };
}

async function main() {
  section('Workload');
  step(`${BURST} requests burst onto one document, then ${OTHERS} other documents send one each.`);
  step(`Each request occupies a worker for about ${SERVICE_MS}ms; the pool has 2 workers.`);

  const fifo = await runWorkload(POLICIES.FIFO);
  const roundRobin = await runWorkload(POLICIES.ROUND_ROBIN);

  section('Results');
  table([
    {
      policy: 'FIFO',
      completed: fifo.metrics.completed,
      avgWaitingMs: fifo.metrics.averageWaitingMs,
      avgTurnaroundMs: fifo.metrics.averageTurnaroundMs,
      maxWaitingMs: fifo.metrics.maxWaitingMs,
      avgWaitQuietDocsMs: Number(fifo.quietWait.toFixed(2))
    },
    {
      policy: 'ROUND_ROBIN',
      completed: roundRobin.metrics.completed,
      avgWaitingMs: roundRobin.metrics.averageWaitingMs,
      avgTurnaroundMs: roundRobin.metrics.averageTurnaroundMs,
      maxWaitingMs: roundRobin.metrics.maxWaitingMs,
      avgWaitQuietDocsMs: Number(roundRobin.quietWait.toFixed(2))
    }
  ]);

  section('Interpretation');
  const improvement = fifo.quietWait === 0
    ? 0
    : ((fifo.quietWait - roundRobin.quietWait) / fifo.quietWait) * 100;

  step(`Documents outside the burst waited ${fifo.quietWait.toFixed(1)}ms under FIFO`);
  step(`and ${roundRobin.quietWait.toFixed(1)}ms under round-robin: a ${improvement.toFixed(0)}% reduction.`);
  step('Mean waiting time across all requests is similar, because the total work is identical.');
  step('Round-robin redistributes the waiting rather than reducing it, which is the trade-off.');

  if (roundRobin.quietWait >= fifo.quietWait) {
    throw new Error('Round-robin did not reduce waiting time for the non-burst documents');
  }

  section('Worker utilisation under round-robin');
  table(roundRobin.metrics.workers.map((worker) => ({
    worker: worker.id,
    state: worker.state,
    tasksProcessed: worker.tasksProcessed,
    busyMs: worker.busyMs
  })));
}

runDemo('DEMO 6 - FIFO VERSUS ROUND-ROBIN SCHEDULING', main);
