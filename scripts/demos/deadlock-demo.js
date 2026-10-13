/**
 * Demo 2 - Deadlock Detection (prd.md section 10, item 2)
 *
 * Two transactions lock two documents in opposite order, producing a cycle in
 * the wait-for graph. The detector finds it with Tarjan's SCC pass, picks a
 * victim, and aborts it so the survivor completes.
 *
 * A note the examiner should hear: the ordinary edit path cannot deadlock,
 * because Engine.executeEdit acquires page locks in ascending page order and
 * a total acquisition order makes a cycle impossible. This demo therefore
 * uses the lower-level transaction API, where a caller is free to lock
 * several documents in any order it likes. Prevention where it is cheap,
 * detection where it is not.
 */

'use strict';

const { LOCK_MODES } = require('../../src/engine/lock/LockManager');
const { withEngine, section, step, table, holdEventLoop, sleep, runDemo } = require('./harness');

async function main() {
  const release = holdEventLoop();
  const { engine, dispose } = await withEngine({ lock: { deadlockIntervalMs: 100, timeoutMs: 10000 } });

  try {
    section('Setup');
    await engine.createDocument({ docId: 1, title: 'Budget' });
    await engine.createDocument({ docId: 2, title: 'Schedule' });

    const pageA = engine.storage.getDocumentPages(1)[0];
    const pageB = engine.storage.getDocumentPages(2)[0];
    step(`Document 1 occupies page ${pageA}; document 2 occupies page ${pageB}.`);

    const manager = engine.transactionManager;
    const txA = manager.begin({ label: 'T-A' });
    const txB = manager.begin({ label: 'T-B' });
    step(`Started transactions ${txA.txId} and ${txB.txId}.`);

    section('Each transaction takes its first lock');
    await manager.acquireLock(txA, 1, pageA, LOCK_MODES.EXCLUSIVE);
    step(`tx${txA.txId} holds X on page ${pageA}`);
    await manager.acquireLock(txB, 2, pageB, LOCK_MODES.EXCLUSIVE);
    step(`tx${txB.txId} holds X on page ${pageB}`);

    section('Each now requests the lock the other holds');
    step(`tx${txA.txId} requests X on page ${pageB} ... blocks`);
    step(`tx${txB.txId} requests X on page ${pageA} ... blocks`);

    const outcomeA = manager.acquireLock(txA, 2, pageB, LOCK_MODES.EXCLUSIVE)
      .then(() => 'ACQUIRED', (error) => error.name);
    const outcomeB = manager.acquireLock(txB, 1, pageA, LOCK_MODES.EXCLUSIVE)
      .then(() => 'ACQUIRED', (error) => error.name);

    await sleep(50);

    section('Wait-for graph at the moment of deadlock');
    table(engine.lockManager.getWaitForEdges().map((edge) => ({
      edge: `tx${edge.waiter} -> tx${edge.holder}`,
      waitingFor: edge.resourceId,
      mode: edge.mode
    })));

    section('Lock table');
    table(engine.lockManager.snapshot().map((entry) => ({
      resource: entry.resourceId,
      holders: entry.holders.map((h) => `tx${h.txId}:${h.mode}`).join(', ') || '-',
      waiting: entry.waiting.map((w) => `tx${w.txId}:${w.mode}`).join(', ') || '-'
    })));

    section('Detector result');
    const [resultA, resultB] = await Promise.all([outcomeA, outcomeB]);
    const history = engine.deadlockDetector.getStats().history;

    table(history.map((entry) => ({
      cycle: entry.cycle.map((id) => `tx${id}`).join(' -> '),
      victim: `tx${entry.victim}`,
      detectedAt: entry.detectedAt
    })));

    table([
      { transaction: `tx${txA.txId}`, outcome: resultA, locksHeld: engine.lockManager.getLocksHeldBy(txA.txId).length },
      { transaction: `tx${txB.txId}`, outcome: resultB, locksHeld: engine.lockManager.getLocksHeldBy(txB.txId).length }
    ]);

    const acquired = [resultA, resultB].filter((r) => r === 'ACQUIRED');
    const aborted = [resultA, resultB].filter((r) => r === 'LockAbortedError');

    step(`Survivors: ${acquired.length}, victims aborted: ${aborted.length}`);
    if (history.length === 0) throw new Error('No deadlock was detected');
    if (acquired.length !== 1 || aborted.length !== 1) {
      throw new Error('Expected exactly one survivor and one victim');
    }

    await manager.abort(txA, 'demo cleanup');
    await manager.abort(txB, 'demo cleanup');

    section('Detector counters');
    const stats = engine.deadlockDetector.getStats();
    table([{
      sweeps: stats.sweeps,
      deadlocksDetected: stats.deadlocksDetected,
      victimsAborted: stats.victimsAborted
    }]);
  } finally {
    release();
    await dispose();
  }
}

runDemo('DEMO 2 - DEADLOCK DETECTION AND VICTIM SELECTION', main);
