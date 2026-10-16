/**
 * Phase 12 - Engine integration tests.
 *
 * These are the assertions the evaluation plan in prd.md section 10 is scored
 * against: concurrent editing without lost updates, conflict detection,
 * deadlock handling, crash recovery and the index speed-up.
 */

'use strict';

const { Engine } = require('../../src/engine/Engine');
const { ConflictError } = require('../../src/engine/conflict/ConflictResolver');
const { LOCK_MODES } = require('../../src/engine/lock/LockManager');
const {
  makeDataDir,
  engineConfig,
  startEngine,
  cleanup,
  holdEventLoop
} = require('../helpers/engineHarness');

jest.setTimeout(30000);

describe('engine end to end', () => {
  let dataDir;
  let engine;

  beforeEach(async () => {
    dataDir = makeDataDir();
    engine = await startEngine(dataDir);
  });

  afterEach(async () => {
    await engine.stop();
    cleanup(dataDir);
  });

  test('creates, edits and reads a document', async () => {
    await engine.createDocument({ docId: 1, title: 'Notes', ownerId: 1 });

    const first = await engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 0, content: 'hello world' },
      baseVersion: 1
    });
    expect(first.version).toBe(2);

    const second = await engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 5, content: ' brave' },
      baseVersion: 2
    });
    expect(second.text).toBe('hello brave world');

    const read = await engine.readDocument(1);
    expect(read).toMatchObject({ docId: 1, version: 3, title: 'Notes', text: 'hello brave world' });
  });

  test('applies a delete', async () => {
    await engine.createDocument({ docId: 1 });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'hello brave world' } });
    const result = await engine.submitEdit({ docId: 1, operation: { type: 'delete', position: 5, length: 6 } });

    expect(result.text).toBe('hello world');
  });

  test('rejects a stale edit with the current version attached', async () => {
    await engine.createDocument({ docId: 1 });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'first' }, baseVersion: 1 });

    const stale = engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 0, content: 'stale' },
      baseVersion: 1
    });

    await expect(stale).rejects.toThrow(ConflictError);
    await expect(stale).rejects.toMatchObject({ expectedVersion: 1, actualVersion: 2 });
  });

  test('a rejected edit leaves the document untouched', async () => {
    await engine.createDocument({ docId: 1 });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'kept' } });

    await expect(engine.submitEdit({
      docId: 1,
      operation: { type: 'insert', position: 0, content: 'lost' },
      baseVersion: 1
    })).rejects.toThrow(ConflictError);

    expect((await engine.readDocument(1)).text).toBe('kept');
    expect(engine.transactionManager.getStats().aborted).toBeGreaterThan(0);
  });

  test('three concurrent editors all land, with no lost update', async () => {
    await engine.createDocument({ docId: 1 });

    const results = await Promise.all([
      engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'AAA' }, userId: 1 }),
      engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'BBB' }, userId: 2 }),
      engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'CCC' }, userId: 3 })
    ]);

    // Serialisable execution: the versions form a contiguous sequence.
    expect(results.map((r) => r.version).sort()).toEqual([2, 3, 4]);

    const text = (await engine.readDocument(1)).text;
    expect(text).toHaveLength(9);
    for (const fragment of ['AAA', 'BBB', 'CCC']) {
      expect(text).toContain(fragment);
    }
  });

  test('edits to different documents run concurrently', async () => {
    for (let docId = 1; docId <= 4; docId += 1) await engine.createDocument({ docId });

    await Promise.all([1, 2, 3, 4].map((docId) => engine.submitEdit({
      docId,
      operation: { type: 'insert', position: 0, content: `doc-${docId}` }
    })));

    for (let docId = 1; docId <= 4; docId += 1) {
      expect((await engine.readDocument(docId)).text).toBe(`doc-${docId}`);
    }
  });

  test('grows onto more pages as the document outgrows one', async () => {
    await engine.createDocument({ docId: 1 });
    const body = 'lorem ipsum dolor sit amet '.repeat(500);

    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: body } });
    const read = await engine.readDocument(1);

    expect(read.text).toBe(body);
    expect(read.pages.length).toBeGreaterThan(1);
  });

  test('preserves multi-byte characters across a page boundary', async () => {
    await engine.createDocument({ docId: 1 });
    const body = 'निरंतर सहयोग '.repeat(400);

    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: body } });
    expect((await engine.readDocument(1)).text).toBe(body);
  });

  test('detects a deadlock between two multi-document transactions', async () => {
    const release = holdEventLoop();
    try {
      await engine.createDocument({ docId: 1 });
      await engine.createDocument({ docId: 2 });

      const manager = engine.transactionManager;
      const pageA = engine.storage.getDocumentPages(1)[0];
      const pageB = engine.storage.getDocumentPages(2)[0];

      const first = manager.begin({ label: 'first' });
      const second = manager.begin({ label: 'second' });

      await manager.acquireLock(first, 1, pageA, LOCK_MODES.EXCLUSIVE);
      await manager.acquireLock(second, 2, pageB, LOCK_MODES.EXCLUSIVE);

      // Opposite acquisition order: a cycle in the wait-for graph.
      const outcomes = await Promise.all([
        manager.acquireLock(first, 2, pageB, LOCK_MODES.EXCLUSIVE).then(() => 'granted', (e) => e.name),
        manager.acquireLock(second, 1, pageA, LOCK_MODES.EXCLUSIVE).then(() => 'granted', (e) => e.name)
      ]);

      expect(outcomes.filter((o) => o === 'granted')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'LockAbortedError')).toHaveLength(1);

      const history = engine.deadlockDetector.getStats().history;
      expect(history).toHaveLength(1);
      expect(history[0].cycle.sort()).toEqual([first.txId, second.txId].sort());

      await manager.abort(first, 'test cleanup');
      await manager.abort(second, 'test cleanup');
    } finally {
      release();
    }
  });

  test('indexes committed text and serves a keyword search', async () => {
    await engine.createDocument({ docId: 1 });
    await engine.createDocument({ docId: 2 });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'write ahead logging guarantees durability' } });
    await engine.submitEdit({ docId: 2, operation: { type: 'insert', position: 0, content: 'two phase locking guarantees isolation' } });

    expect((await engine.search('guarantees')).docIds).toEqual([1, 2]);
    expect((await engine.search('durability')).docIds).toEqual([1]);
    expect((await engine.search('logging', { useIndex: false })).docIds).toEqual([1]);
  });

  test('reports a buffer-pool hit ratio above zero after repeated reads', async () => {
    await engine.createDocument({ docId: 1 });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'cached' } });
    for (let i = 0; i < 5; i += 1) await engine.readDocument(1);

    expect(engine.bufferPool.getStats().hits).toBeGreaterThan(0);
  });

  test('rejects an edit to a document that does not exist', async () => {
    await expect(engine.submitEdit({
      docId: 999,
      operation: { type: 'insert', position: 0, content: 'x' }
    })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });
});

describe('crash recovery', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = makeDataDir();
  });

  afterEach(() => cleanup(dataDir));

  test('committed edits survive a crash and uncommitted ones do not', async () => {
    const first = await startEngine(dataDir);
    await first.createDocument({ docId: 1, title: 'Durable' });
    await first.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'committed text' } });

    // Start a transaction, write, force the dirty page out (a steal), then
    // die before committing.
    const manager = first.transactionManager;
    const pageId = first.storage.getDocumentPages(1)[0];
    const doomed = manager.begin({ docId: 1 });
    await manager.write(doomed, 1, pageId, (page) => {
      page.rewriteRecords([
        { recordId: 0, version: 99, payload: Buffer.from(JSON.stringify({ title: 'Durable' })) },
        { recordId: 1, version: 99, payload: Buffer.from('UNCOMMITTED GARBAGE') }
      ]);
    });
    first.bufferPool.flushPage(pageId);
    first.simulateCrash();

    const restarted = new Engine(engineConfig(dataDir));
    const report = await restarted.start();

    expect(report.winners.length).toBeGreaterThan(0);
    expect(report.losers).toContain(doomed.txId);
    expect(report.undone).toBeGreaterThan(0);

    const recovered = await restarted.readDocument(1);
    expect(recovered.text).toBe('committed text');
    await restarted.stop();
  });

  test('a document survives a clean restart', async () => {
    const first = await startEngine(dataDir);
    await first.createDocument({ docId: 1, title: 'Persisted' });
    await first.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'durable content' } });
    await first.stop();

    const second = await startEngine(dataDir);
    expect((await second.readDocument(1)).text).toBe('durable content');
    expect((await second.search('durable')).docIds).toEqual([1]);
    await second.stop();
  });

  test('the index is rebuilt to match the recovered text', async () => {
    const first = await startEngine(dataDir);
    await first.createDocument({ docId: 1 });
    await first.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: 'alpha keyword' } });
    first.simulateCrash();

    const second = await startEngine(dataDir);
    expect((await second.search('alpha')).docIds).toEqual([1]);
    await second.stop();
  });
});
