/**
 * Demo 3 - Transactions and ACID (prd.md section 10, item 3)
 *
 * Walks the four guarantees one at a time:
 *   Atomicity   an aborted transaction leaves nothing behind, even though its
 *               dirty page was already stolen to disk.
 *   Consistency a stale edit is rejected by the optimistic version check.
 *   Isolation   a second writer blocks until the first commits.
 *   Durability  the WAL carries BEGIN, UPDATE and COMMIT in that order.
 */

'use strict';

const { LOCK_MODES } = require('../../src/engine/lock/LockManager');
const { withEngine, section, step, table, sleep, runDemo } = require('./harness');

async function main() {
  const { engine, dispose } = await withEngine();

  try {
    const manager = engine.transactionManager;
    await engine.createDocument({ docId: 1, title: 'ACID' });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'baseline' } });
    const pageId = engine.storage.getDocumentPages(1)[0];

    // ------------------------------------------------------------- Atomicity
    section('A - Atomicity: an aborted transaction leaves no trace');
    step(`Before: ${JSON.stringify((await engine.readDocument(1)).text)}`);

    const doomed = manager.begin({ docId: 1, label: 'will-abort' });
    await manager.write(doomed, 1, pageId, (page) => {
      page.rewriteRecords([
        { recordId: 0, version: 50, payload: Buffer.from(JSON.stringify({ title: 'ACID' })) },
        { recordId: 1, version: 50, payload: Buffer.from('PARTIAL WRITE THAT MUST VANISH') }
      ]);
    });
    step(`tx${doomed.txId} wrote to page ${pageId} and logged an UPDATE record.`);

    engine.bufferPool.flushPage(pageId);
    step('Buffer pool stole the dirty page: the uncommitted bytes are now on disk.');
    step(`Raw page content: ${JSON.stringify(engine.readDocumentTextUnlocked(1))}`);

    await manager.abort(doomed, 'demonstrating rollback');
    step(`tx${doomed.txId} aborted; before-image restored from the WAL.`);
    step(`After : ${JSON.stringify((await engine.readDocument(1)).text)}`);

    // ----------------------------------------------------------- Consistency
    section('B - Consistency: the optimistic version check rejects a stale edit');
    const current = await engine.readDocument(1);
    step(`Document is at version ${current.version}.`);
    step(`A client that still believes it is at version 1 submits an edit ...`);

    try {
      await engine.submitEdit({
        docId: 1,
        operation: { type: 'insert', position: 0, content: 'stale edit' },
        baseVersion: 1
      });
      throw new Error('The stale edit was accepted, which it must not be');
    } catch (error) {
      if (error.code !== 'VERSION_CONFLICT') throw error;
      step(`Rejected with ${error.code}: expected v${error.expectedVersion}, actual v${error.actualVersion}.`);
      step('The client is told the current version so it can rebase and retry.');
    }

    // ------------------------------------------------------------- Isolation
    section('C - Isolation: a second writer waits for the first to commit');
    const first = manager.begin({ docId: 1, label: 'holder' });
    await manager.acquireLock(first, 1, pageId, LOCK_MODES.EXCLUSIVE);
    step(`tx${first.txId} holds X on page ${pageId}.`);

    const second = manager.begin({ docId: 1, label: 'waiter' });
    let granted = false;
    const waiting = manager.acquireLock(second, 1, pageId, LOCK_MODES.EXCLUSIVE)
      .then(() => { granted = true; });

    await sleep(30);
    step(`After 30ms, tx${second.txId} granted: ${granted} (it is queued behind tx${first.txId}).`);

    await manager.commit(first);
    await waiting;
    step(`tx${first.txId} committed; tx${second.txId} granted: ${granted}.`);
    await manager.abort(second, 'demo cleanup');

    // ------------------------------------------------------------ Durability
    section('D - Durability: the write-ahead log records the commit first');
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: '>> ' } });

    const records = engine.wal.readAll();
    table(records.slice(-6).map((record) => ({
      lsn: record.lsn.toString(),
      type: record.typeName,
      txId: record.txId,
      pageId: record.pageId || '-',
      beforeBytes: record.beforeImage ? record.beforeImage.length : 0,
      afterBytes: record.afterImage ? record.afterImage.length : 0
    })));
    step('Each UPDATE carries a full before-image (for UNDO) and after-image (for REDO).');

    section('Transaction counters');
    const stats = engine.transactionManager.getStats();
    table([{
      begun: stats.begun,
      committed: stats.committed,
      aborted: stats.aborted,
      averageCommitMs: stats.averageCommitMs
    }]);
  } finally {
    await dispose();
  }
}

runDemo('DEMO 3 - ACID TRANSACTION LIFECYCLE', main);
