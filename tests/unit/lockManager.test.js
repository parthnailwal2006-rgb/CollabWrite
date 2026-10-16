/**
 * Phase 6 - Lock Manager tests.
 *
 * Asserts the compatibility matrix, FIFO fairness, lock upgrade, timeouts and
 * the wait-for edges the deadlock detector consumes.
 */

'use strict';

const {
  LockManager,
  LOCK_MODES,
  LockTimeoutError,
  LockAbortedError,
  isCompatible
} = require('../../src/engine/lock/LockManager');

const RESOURCE = LockManager.resourceId(1, 4);

/** Resolves after the pending microtasks and timers have run. */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('lock compatibility matrix', () => {
  test('only shared-with-shared is compatible', () => {
    expect(isCompatible(LOCK_MODES.SHARED, LOCK_MODES.SHARED)).toBe(true);
    expect(isCompatible(LOCK_MODES.SHARED, LOCK_MODES.EXCLUSIVE)).toBe(false);
    expect(isCompatible(LOCK_MODES.EXCLUSIVE, LOCK_MODES.SHARED)).toBe(false);
    expect(isCompatible(LOCK_MODES.EXCLUSIVE, LOCK_MODES.EXCLUSIVE)).toBe(false);
  });
});

describe('LockManager', () => {
  let locks;

  beforeEach(() => {
    locks = new LockManager({ timeoutMs: 0 });
  });

  afterEach(() => {
    locks.reset();
  });

  test('grants several shared locks at once', async () => {
    await expect(locks.acquire(1, RESOURCE, LOCK_MODES.SHARED)).resolves.toMatchObject({ granted: true });
    await expect(locks.acquire(2, RESOURCE, LOCK_MODES.SHARED)).resolves.toMatchObject({ granted: true });

    expect(locks.snapshot()[0].holders).toHaveLength(2);
  });

  test('blocks an exclusive request behind a shared holder', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.SHARED);

    let granted = false;
    const pending = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE).then(() => { granted = true; });
    await tick();
    expect(granted).toBe(false);

    locks.release(1, RESOURCE);
    await pending;
    expect(granted).toBe(true);
  });

  test('is idempotent when a transaction re-requests a lock it holds', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await expect(locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE)).resolves.toMatchObject({ granted: true });
    await expect(locks.acquire(1, RESOURCE, LOCK_MODES.SHARED)).resolves.toMatchObject({ granted: true });
  });

  test('upgrades shared to exclusive for the sole holder', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.SHARED);
    await expect(locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE)).resolves.toMatchObject({ upgraded: true });
    expect(locks.snapshot()[0].holders).toEqual([{ txId: 1, mode: 'X' }]);
  });

  test('serves waiters in arrival order so no writer starves', async () => {
    const order = [];
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);

    const second = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE).then(() => order.push(2));
    await tick();
    const third = locks.acquire(3, RESOURCE, LOCK_MODES.EXCLUSIVE).then(() => order.push(3));
    await tick();

    locks.release(1, RESOURCE);
    await second;
    locks.release(2, RESOURCE);
    await third;

    expect(order).toEqual([2, 3]);
  });

  test('does not let a shared request barge past a queued writer', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.SHARED);

    let writerGranted = false;
    let bargerGranted = false;
    const writer = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE).then(() => { writerGranted = true; });
    await tick();
    const barger = locks.acquire(3, RESOURCE, LOCK_MODES.SHARED).then(() => { bargerGranted = true; });
    await tick();

    expect(writerGranted).toBe(false);
    expect(bargerGranted).toBe(false);

    locks.release(1, RESOURCE);
    await writer;
    expect(writerGranted).toBe(true);
    expect(bargerGranted).toBe(false);

    locks.release(2, RESOURCE);
    await barger;
    expect(bargerGranted).toBe(true);
  });

  test('releaseAll frees every resource and wakes waiters', async () => {
    const other = LockManager.resourceId(1, 5);
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await locks.acquire(1, other, LOCK_MODES.EXCLUSIVE);

    const waiter = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await tick();

    locks.releaseAll(1, 'committed');
    await expect(waiter).resolves.toMatchObject({ granted: true });
    expect(locks.getLocksHeldBy(1)).toEqual([]);
  });

  test('rejects a pending request when its own transaction is released', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);
    const waiter = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await tick();

    locks.releaseAll(2, 'deadlock victim');
    await expect(waiter).rejects.toThrow(LockAbortedError);
  });

  test('times a request out when configured to', async () => {
    const timed = new LockManager({ timeoutMs: 40 });
    await timed.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);

    await expect(timed.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE)).rejects.toThrow(LockTimeoutError);
    expect(timed.getStats().timeouts).toBe(1);
    timed.reset();
  });

  test('reports wait-for edges for the deadlock detector', async () => {
    const other = LockManager.resourceId(2, 9);
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await locks.acquire(2, other, LOCK_MODES.EXCLUSIVE);

    locks.acquire(1, other, LOCK_MODES.EXCLUSIVE).catch(() => {});
    locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE).catch(() => {});
    await tick();

    const edges = locks.getWaitForEdges();
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ waiter: 1, holder: 2 }),
        expect.objectContaining({ waiter: 2, holder: 1 })
      ])
    );
  });

  test('tracks average wait time', async () => {
    await locks.acquire(1, RESOURCE, LOCK_MODES.EXCLUSIVE);
    const waiter = locks.acquire(2, RESOURCE, LOCK_MODES.EXCLUSIVE);
    await tick(20);
    locks.release(1, RESOURCE);
    await waiter;

    const stats = locks.getStats();
    expect(stats.waited).toBe(1);
    expect(stats.averageWaitMs).toBeGreaterThan(0);
  });
});
