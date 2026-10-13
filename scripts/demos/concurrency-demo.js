/**
 * Demo 1 - Concurrent Editing (prd.md section 10, item 1)
 *
 * Shows three collaborators editing one document at the same time. The
 * scheduler queues their requests, the lock manager serialises them at page
 * granularity, and every edit survives: the final document contains all three
 * contributions and the version numbers form a contiguous sequence, which is
 * what "no lost updates" means in practice.
 */

'use strict';

const { withEngine, section, step, table, runDemo } = require('./harness');

async function main() {
  const { engine, dispose } = await withEngine({ scheduler: { workers: 3, policy: 'FIFO' } });

  try {
    section('Setup');
    await engine.createDocument({ docId: 1, title: 'Group Report', ownerId: 1 });
    await engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 0, content: 'INTRODUCTION\n\nCONCLUSION\n' }
    });
    const start = await engine.readDocument(1);
    step(`Document starts at version ${start.version} with ${start.text.length} characters.`);

    section('Three collaborators edit simultaneously');
    const editors = [
      { userId: 1, username: 'ananya', content: '[ananya: added background] ' },
      { userId: 2, username: 'rahul', content: '[rahul: added method] ' },
      { userId: 3, username: 'priya', content: '[priya: added results] ' }
    ];

    const results = await Promise.all(editors.map((editor) => engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 13, content: editor.content },
      userId: editor.userId,
      username: editor.username
    })));

    table(results.map((result, i) => ({
      user: editors[i].username,
      txId: result.transaction.txId,
      version: result.version,
      lockWaitMs: result.transaction.lockWaitMs,
      pagesWritten: result.transaction.modifiedPages.length,
      state: result.transaction.state
    })));

    section('Verification');
    const final = await engine.readDocument(1);
    const allPresent = editors.every((editor) => final.text.includes(editor.content));
    const versions = results.map((r) => r.version).sort((a, b) => a - b);
    const contiguous = versions.every((v, i) => i === 0 || v === versions[i - 1] + 1);

    step(`Every contribution present : ${allPresent}`);
    step(`Versions assigned          : ${versions.join(', ')} (contiguous: ${contiguous})`);
    step(`Final document length      : ${final.text.length} characters at version ${final.version}`);
    console.log(`\n   Final text:\n   ${JSON.stringify(final.text)}`);

    if (!allPresent) throw new Error('A contribution was lost - the lost update problem was not prevented');
    if (!contiguous) throw new Error('Versions are not contiguous - the schedule was not serialisable');

    section('Engine counters');
    const stats = engine.getStats();
    table([{
      committed: stats.transactions.committed,
      aborted: stats.transactions.aborted,
      locksGranted: stats.locks.granted,
      lockWaits: stats.locks.waited,
      avgLockWaitMs: stats.locks.averageWaitMs,
      bufferHitRatio: stats.bufferPool.hitRatio
    }]);
  } finally {
    await dispose();
  }
}

runDemo('DEMO 1 - CONCURRENT EDITING WITHOUT LOST UPDATES', main);
