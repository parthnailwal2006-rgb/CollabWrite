/**
 * Phase 7 - Scheduler and Worker Pool tests.
 *
 * The interesting claims are that concurrency is actually bounded by the pool
 * size, that FIFO preserves arrival order, that round-robin rotates across
 * documents, and that the recorded waiting and turnaround times are real.
 */

'use strict';

const { Scheduler, POLICIES } = require('../../src/engine/scheduler/Scheduler');
const { WorkerPool, WORKER_STATES } = require('../../src/engine/scheduler/WorkerPool');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WorkerPool', () => {
  test('rejects a pool smaller than one worker', () => {
    expect(() => new WorkerPool(0)).toThrow(/at least 1/);
  });

  test('hands out idle workers circularly', () => {
    const pool = new WorkerPool(3);
    const first = pool.acquire();
    const second = pool.acquire();

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  test('tracks the IDLE and BUSY state machine', () => {
    const pool = new WorkerPool(1);
    const worker = pool.acquire();
    expect(worker.state).toBe(WORKER_STATES.IDLE);

    worker.assign({ taskId: 1 });
    expect(worker.state).toBe(WORKER_STATES.BUSY);
    expect(pool.idleCount).toBe(0);
    expect(pool.acquire()).toBeNull();

    pool.release(worker);
    expect(worker.state).toBe(WORKER_STATES.IDLE);
    expect(worker.tasksProcessed).toBe(1);
  });
});

describe('Scheduler', () => {
  test('rejects an unknown policy', () => {
    expect(() => new Scheduler({ policy: 'SJF' })).toThrow(/Unknown scheduling policy/);
  });

  test('runs a task and resolves with its value', async () => {
    const scheduler = new Scheduler({ workers: 2 });
    scheduler.start();

    await expect(scheduler.submit({ docId: 1 }, async () => 'done')).resolves.toBe('done');
    expect(scheduler.getMetrics()).toMatchObject({ submitted: 1, succeeded: 1, failed: 0 });
  });

  test('propagates a task failure to the caller', async () => {
    const scheduler = new Scheduler({ workers: 1 });
    scheduler.start();

    await expect(scheduler.submit({ docId: 1 }, async () => {
      throw new Error('task exploded');
    })).rejects.toThrow('task exploded');
    expect(scheduler.getMetrics().failed).toBe(1);
  });

  test('never runs more tasks at once than there are workers', async () => {
    const scheduler = new Scheduler({ workers: 2 });
    scheduler.start();

    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(10);
      running -= 1;
    };

    await Promise.all(Array.from({ length: 8 }, (_, i) => scheduler.submit({ docId: i }, work)));
    expect(peak).toBe(2);
  });

  test('FIFO dispatches in arrival order', async () => {
    const scheduler = new Scheduler({ workers: 1, policy: POLICIES.FIFO });
    scheduler.start();

    const order = [];
    await Promise.all([1, 2, 3, 4].map((id) => scheduler.submit({ docId: id }, async () => {
      order.push(id);
      await delay(2);
    })));

    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('round-robin rotates across documents instead of draining one', async () => {
    const scheduler = new Scheduler({ workers: 1, policy: POLICIES.ROUND_ROBIN });

    // Queue three tasks for document A before a single task for document B.
    const order = [];
    const record = (label) => async () => {
      order.push(label);
      await delay(2);
    };
    const pending = [
      scheduler.submit({ docId: 'A' }, record('A1')),
      scheduler.submit({ docId: 'A' }, record('A2')),
      scheduler.submit({ docId: 'A' }, record('A3')),
      scheduler.submit({ docId: 'B' }, record('B1'))
    ];
    scheduler.start();
    await Promise.all(pending);

    // B1 arrived last but must not wait behind the whole A burst.
    expect(order.indexOf('B1')).toBeLessThan(order.indexOf('A3'));
  });

  test('a priority task jumps the queue', async () => {
    const scheduler = new Scheduler({ workers: 1, policy: POLICIES.FIFO });

    const order = [];
    const record = (label) => async () => {
      order.push(label);
      await delay(2);
    };
    const pending = [
      scheduler.submit({ docId: 1 }, record('normal-1')),
      scheduler.submit({ docId: 1 }, record('normal-2')),
      scheduler.submit({ docId: 1, priority: true }, record('urgent'))
    ];
    scheduler.start();
    await Promise.all(pending);

    expect(order[0]).toBe('urgent');
  });

  test('records waiting and turnaround times per task', async () => {
    const scheduler = new Scheduler({ workers: 1 });
    scheduler.start();

    await Promise.all([1, 2, 3].map((id) => scheduler.submit({ docId: id }, () => delay(15))));

    const metrics = scheduler.getMetrics();
    expect(metrics.completed).toBe(3);
    expect(metrics.averageWaitingMs).toBeGreaterThan(0);
    expect(metrics.averageTurnaroundMs).toBeGreaterThanOrEqual(metrics.averageWaitingMs);
    expect(metrics.maxWaitingMs).toBeGreaterThanOrEqual(metrics.averageWaitingMs);
  });

  test('refuses a policy change while work is queued', () => {
    const scheduler = new Scheduler({ workers: 1 });
    scheduler.submit({ docId: 1 }, async () => 'queued');

    expect(() => scheduler.setPolicy(POLICIES.ROUND_ROBIN)).toThrow(/while tasks are queued/);
    scheduler.start();
  });

  test('round-robin lowers mean waiting time when one document floods the queue', async () => {
    const run = async (policy) => {
      const scheduler = new Scheduler({ workers: 1, policy });
      const pending = [];
      for (let i = 0; i < 12; i += 1) pending.push(scheduler.submit({ docId: 'hot' }, () => delay(4)));
      for (let i = 0; i < 4; i += 1) pending.push(scheduler.submit({ docId: `cold-${i}` }, () => delay(4)));
      scheduler.start();
      await Promise.all(pending);

      const cold = scheduler.completed.filter((t) => String(t.docId).startsWith('cold'));
      return cold.reduce((sum, t) => sum + t.waitingMs, 0) / cold.length;
    };

    const fifo = await run(POLICIES.FIFO);
    const roundRobin = await run(POLICIES.ROUND_ROBIN);
    expect(roundRobin).toBeLessThan(fifo);
  });
});
