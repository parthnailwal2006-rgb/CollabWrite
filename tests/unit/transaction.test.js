/**
 * Phase 5 - Transaction Manager tests.
 *
 * The ACID properties are asserted individually:
 *   Atomicity  - an aborted transaction leaves no trace, even after its dirty
 *                page was stolen to disk.
 *   Isolation  - a second transaction blocks on a page the first holds.
 *   Durability - the COMMIT record precedes the data in the WAL.
 */

'use strict';

const path = require('path');

const { StorageManager } = require('../../src/engine/storage/StorageManager');
const { BufferPool } = require('../../src/engine/buffer/BufferPool');
const { LockManager } = require('../../src/engine/lock/LockManager');
const { WAL, RECORD_TYPES } = require('../../src/engine/recovery/WAL');
const { ConflictResolver, ConflictError } = require('../../src/engine/conflict/ConflictResolver');
const {
  TransactionManager,
  TransactionAbortedError,
  TX_STATES
} = require('../../src/engine/transaction/TransactionManager');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TransactionManager', () => {
  let dataDir;
  let storage;
  let bufferPool;
  let wal;
  let lockManager;
  let manager;
  let pageId;

  beforeEach(() => {
    dataDir = makeDataDir();
    storage = new StorageManager({
      dataFile: path.join(dataDir, 'documents.dat'),
      pageSize: 4096,
      directoryPages: 4
    });
    storage.open();
    pageId = storage.createDocument(1);

    bufferPool = new BufferPool(storage, { frames: 4 });
    wal = new WAL({ walFile: path.join(dataDir, 'wal.log'), syncOnCommit: false });
    wal.open();
    lockManager = new LockManager({ timeoutMs: 0 });
    manager = new TransactionManager({
      storage,
      bufferPool,
      lockManager,
      wal,
      conflictResolver: new ConflictResolver()
    });
  });

  afterEach(() => {
    lockManager.reset();
    wal.close();
    storage.close();
    cleanup(dataDir);
  });

  const writeText = (tx, text, version = 1) => manager.write(tx, 1, pageId, (page) => {
    page.rewriteRecords([{ recordId: 1, version, payload: Buffer.from(text) }]);
  });

  test('assigns increasing transaction ids and logs BEGIN', () => {
    const first = manager.begin();
    const second = manager.begin();

    expect(second.txId).toBe(first.txId + 1);
    expect(wal.readAll()[0]).toMatchObject({ type: RECORD_TYPES.BEGIN, txId: first.txId });
  });

  test('commits a write and makes it durable', async () => {
    const tx = manager.begin({ docId: 1 });
    await writeText(tx, 'committed');
    await manager.commit(tx);

    expect(tx.state).toBe(TX_STATES.COMMITTED);
    expect(storage.readPage(pageId).readRecord(1).payload.toString()).toBe('committed');

    const types = wal.readAll().map((r) => r.type);
    expect(types).toEqual([RECORD_TYPES.BEGIN, RECORD_TYPES.UPDATE, RECORD_TYPES.COMMIT]);
  });

  test('writes the WAL UPDATE record before the page reaches disk', async () => {
    const tx = manager.begin();
    await writeText(tx, 'write-ahead');

    // Not yet committed, so the log already has the record but the data file
    // still holds the old image.
    expect(wal.readAll().some((r) => r.type === RECORD_TYPES.UPDATE)).toBe(true);
    expect(storage.readPage(pageId).recordCount).toBe(0);

    await manager.commit(tx);
    expect(storage.readPage(pageId).recordCount).toBe(1);
  });

  test('abort undoes a change that was already stolen to disk', async () => {
    const committed = manager.begin();
    await writeText(committed, 'original');
    await manager.commit(committed);

    const doomed = manager.begin();
    await writeText(doomed, 'should vanish', 2);
    bufferPool.flushPage(pageId); // the buffer pool steals the dirty page
    expect(storage.readPage(pageId).readRecord(1).payload.toString()).toBe('should vanish');

    await manager.abort(doomed, 'test rollback');

    expect(doomed.state).toBe(TX_STATES.ABORTED);
    expect(storage.readPage(pageId).readRecord(1).payload.toString()).toBe('original');
    expect(wal.readAll().some((r) => r.type === RECORD_TYPES.ABORT)).toBe(true);
  });

  test('releases every lock at commit, which is the shrinking phase', async () => {
    const tx = manager.begin();
    await writeText(tx, 'locked');
    expect(lockManager.getLocksHeldBy(tx.txId)).toHaveLength(1);

    await manager.commit(tx);
    expect(lockManager.getLocksHeldBy(tx.txId)).toHaveLength(0);
  });

  test('isolates concurrent writers to the same page', async () => {
    const first = manager.begin();
    await writeText(first, 'first');

    const second = manager.begin();
    let secondDone = false;
    const pending = writeText(second, 'second', 2).then(() => { secondDone = true; });

    await tick();
    expect(secondDone).toBe(false);

    await manager.commit(first);
    await pending;
    await manager.commit(second);

    expect(secondDone).toBe(true);
    expect(storage.readPage(pageId).readRecord(1).payload.toString()).toBe('second');
  });

  test('rejects a write whose expected version is stale', async () => {
    const setup = manager.begin();
    await writeText(setup, 'v1', 1);
    await manager.commit(setup);

    const tx = manager.begin();
    await expect(
      manager.write(tx, 1, pageId, () => {}, { expectedVersion: 99 })
    ).rejects.toThrow(ConflictError);
    await manager.abort(tx, 'conflict');
  });

  test('runInTransaction commits on success and aborts on failure', async () => {
    const { transaction } = await manager.runInTransaction({ docId: 1 }, async (tx) => {
      await writeText(tx, 'auto-commit');
    });
    expect(transaction.state).toBe(TX_STATES.COMMITTED);

    await expect(
      manager.runInTransaction({ docId: 1 }, async (tx) => {
        await writeText(tx, 'auto-abort', 2);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(storage.readPage(pageId).readRecord(1).payload.toString()).toBe('auto-commit');
    expect(manager.getStats()).toMatchObject({ committed: 1, aborted: 1 });
  });

  test('a transaction marked as a deadlock victim cannot continue', async () => {
    const tx = manager.begin();
    manager.markDeadlockVictim(tx.txId, [tx.txId, 999]);

    await expect(writeText(tx, 'doomed')).rejects.toThrow(TransactionAbortedError);
  });

  test('page version is the highest record version present', () => {
    const { Page } = require('../../src/engine/storage/Page');
    const page = new Page(pageId, 4096);
    expect(TransactionManager.pageVersion(page)).toBe(0);

    page.insertRecord(0, 'meta', 7);
    page.insertRecord(1, 'content', 3);
    expect(TransactionManager.pageVersion(page)).toBe(7);
  });
});
