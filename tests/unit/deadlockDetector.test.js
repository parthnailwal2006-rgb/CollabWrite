/**
 * Phase 6 - Deadlock Detector tests.
 *
 * Exercises Tarjan's SCC pass directly against synthetic wait-for graphs,
 * then against the real lock manager, so a bug in either the algorithm or the
 * edge extraction is caught on its own.
 */

'use strict';

const { DeadlockDetector } = require('../../src/engine/lock/DeadlockDetector');
const { LockManager, LOCK_MODES } = require('../../src/engine/lock/LockManager');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds a detector over a stub lock manager with a fixed graph.
 * @param {Array<[number, number]>} edges - [waiter, holder] pairs.
 * @param {Map<number, number>} [lockCounts] - txId -> locks held.
 */
function detectorFor(edges, lockCounts = new Map()) {
  const stub = {
    getWaitForEdges: () => edges.map(([waiter, holder]) => ({ waiter, holder })),
    getLocksHeldBy: (txId) => new Array(lockCounts.get(txId) || 0).fill('resource')
  };
  return new DeadlockDetector(stub, { intervalMs: 0 });
}

describe('wait-for graph analysis', () => {
  test('finds no cycle in an acyclic graph', () => {
    const detector = detectorFor([[1, 2], [2, 3], [4, 3]]);
    expect(detector.findCycles()).toEqual([]);
  });

  test('finds a two-transaction cycle', () => {
    const detector = detectorFor([[1, 2], [2, 1]]);
    expect(detector.findCycles()).toEqual([[1, 2]]);
  });

  test('finds a three-transaction cycle', () => {
    const detector = detectorFor([[1, 2], [2, 3], [3, 1]]);
    expect(detector.findCycles()).toEqual([[1, 2, 3]]);
  });

  test('finds two independent cycles in one pass', () => {
    const detector = detectorFor([[1, 2], [2, 1], [3, 4], [4, 3]]);
    const cycles = detector.findCycles();

    expect(cycles).toHaveLength(2);
    expect(cycles).toEqual(expect.arrayContaining([[1, 2], [3, 4]]));
  });

  test('ignores a transaction that merely waits on a long chain', () => {
    const detector = detectorFor([[1, 2], [2, 3], [3, 4], [4, 5]]);
    expect(detector.findCycles()).toEqual([]);
  });
});

describe('victim selection', () => {
  test('picks the transaction holding the fewest locks', () => {
    const counts = new Map([[1, 5], [2, 1], [3, 3]]);
    const detector = detectorFor([[1, 2], [2, 3], [3, 1]], counts);

    expect(detector.selectVictim([1, 2, 3])).toBe(2);
  });

  test('breaks a tie by choosing the youngest transaction', () => {
    const counts = new Map([[1, 2], [2, 2]]);
    const detector = detectorFor([[1, 2], [2, 1]], counts);

    expect(detector.selectVictim([1, 2])).toBe(2);
  });
});

describe('detection against a live lock manager', () => {
  test('detects the classic opposite-order deadlock and names one victim', async () => {
    const locks = new LockManager({ timeoutMs: 0 });
    const victims = [];
    const detector = new DeadlockDetector(locks, {
      intervalMs: 0,
      onVictim: (txId) => victims.push(txId)
    });

    const resourceA = LockManager.resourceId(1, 4);
    const resourceB = LockManager.resourceId(2, 5);

    await locks.acquire(1, resourceA, LOCK_MODES.EXCLUSIVE);
    await locks.acquire(2, resourceB, LOCK_MODES.EXCLUSIVE);

    const first = locks.acquire(1, resourceB, LOCK_MODES.EXCLUSIVE).catch((e) => e.name);
    const second = locks.acquire(2, resourceA, LOCK_MODES.EXCLUSIVE).catch((e) => e.name);
    await tick();

    const found = detector.detect();
    expect(found).toHaveLength(1);
    expect(found[0].cycle).toEqual([1, 2]);
    expect(victims).toHaveLength(1);

    // Releasing the victim's locks breaks the cycle and the survivor proceeds.
    locks.releaseAll(victims[0], 'deadlock victim');
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((o) => o === 'LockAbortedError')).toHaveLength(1);

    locks.reset();
  });

  test('records detection history and counters', () => {
    const detector = detectorFor([[1, 2], [2, 1]], new Map([[1, 1], [2, 1]]));
    detector.onVictim = () => {};
    detector.detect();

    const stats = detector.getStats();
    expect(stats.sweeps).toBe(1);
    expect(stats.deadlocksDetected).toBe(1);
    expect(stats.history[0]).toMatchObject({ cycle: [1, 2], victim: 2 });
  });
});
