/**
 * Demo 4 - Crash Recovery (prd.md section 10, item 4)
 *
 * Commits some work, starts another transaction and forces its dirty page to
 * disk, then kills the engine without flushing or closing anything. A second
 * engine opens the same files and runs the three recovery passes. The
 * committed work is present, the uncommitted work is gone.
 *
 * Both halves of the algorithm are needed and both are exercised: REDO
 * because a commit only forces the log, UNDO because the buffer pool steals.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../../src/engine/Engine');
const { section, step, table, runDemo } = require('./harness');

/** @param {string} dataDir */
function engineFor(dataDir) {
  return new Engine({
    dataDir,
    storage: { pageSize: 4096, directoryPages: 4, dataFile: path.join(dataDir, 'documents.dat') },
    bufferPool: { frames: 8 },
    lock: { timeoutMs: 5000, deadlockIntervalMs: 100 },
    scheduler: { policy: 'FIFO', workers: 4 },
    index: { order: 4, indexFile: path.join(dataDir, 'index.dat') },
    recovery: { walFile: path.join(dataDir, 'wal.log'), syncOnCommit: true },
    metrics: { enabled: false }
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabwrite-recovery-'));

  try {
    section('Phase 1 - normal operation');
    const before = engineFor(dataDir);
    await before.start();

    await before.createDocument({ docId: 1, title: 'Thesis' });
    await before.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'Chapter 1 is finished. ' } });
    await before.submitEdit({ docId: 1, operation: { type: 'insert', position: 23, content: 'Chapter 2 is finished. ' } });

    const committed = await before.readDocument(1);
    step(`Committed text (v${committed.version}): ${JSON.stringify(committed.text)}`);

    section('Phase 2 - a transaction that will never commit');
    const manager = before.transactionManager;
    const pageId = before.storage.getDocumentPages(1)[0];
    const doomed = manager.begin({ docId: 1, label: 'interrupted' });

    await manager.write(doomed, 1, pageId, (page) => {
      page.rewriteRecords([
        { recordId: 0, version: 99, payload: Buffer.from(JSON.stringify({ title: 'Thesis' })) },
        { recordId: 1, version: 99, payload: Buffer.from('CORRUPT HALF-WRITTEN CHAPTER 3') }
      ]);
    });
    step(`tx${doomed.txId} wrote page ${pageId} and logged its UPDATE record.`);

    before.bufferPool.flushPage(pageId);
    step('The buffer pool stole the dirty page, so the uncommitted bytes reached disk.');
    step(`Raw on-disk text now: ${JSON.stringify(before.readDocumentTextUnlocked(1))}`);

    section('Phase 3 - crash');
    before.simulateCrash();
    step('Process state discarded: no flush, no clean shutdown, locks never released.');

    section('Phase 4 - restart and recover');
    const after = engineFor(dataDir);
    const report = await after.start();

    table([{
      walRecordsScanned: report.scanned,
      winners: report.winners.join(', ') || '-',
      losers: report.losers.join(', ') || '-',
      pagesRedone: report.redone,
      pagesUndone: report.undone,
      recoveryMs: report.durationMs
    }]);

    section('Verification');
    const recovered = await after.readDocument(1);
    step(`Recovered text (v${recovered.version}): ${JSON.stringify(recovered.text)}`);

    const committedSurvived = recovered.text === committed.text;
    const uncommittedGone = !recovered.text.includes('CORRUPT');
    step(`Committed work survived    : ${committedSurvived}`);
    step(`Uncommitted work rolled back: ${uncommittedGone}`);
    step(`Search index rebuilt        : ${(await after.search('chapter')).docIds.join(', ') || 'no match'}`);

    if (!committedSurvived) throw new Error('Durability violated: committed text did not survive the crash');
    if (!uncommittedGone) throw new Error('Atomicity violated: uncommitted text survived the crash');
    if (!report.losers.includes(doomed.txId)) throw new Error('The interrupted transaction was not detected as a loser');

    await after.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

runDemo('DEMO 4 - CRASH RECOVERY VIA WRITE-AHEAD LOGGING', main);
