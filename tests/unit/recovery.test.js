/**
 * Phase 11 - WAL and Recovery Manager tests.
 *
 * Recovery is only believable if the failure is real, so these tests write
 * genuine before- and after-images, corrupt or truncate the log where a crash
 * would, and then assert the ARIES-style outcome: committed work survives,
 * uncommitted work disappears.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { WAL, RECORD_TYPES } = require('../../src/engine/recovery/WAL');
const { RecoveryManager } = require('../../src/engine/recovery/RecoveryManager');
const { StorageManager } = require('../../src/engine/storage/StorageManager');
const { Page } = require('../../src/engine/storage/Page');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

const PAGE_SIZE = 4096;

describe('WAL', () => {
  let dataDir;
  let wal;

  beforeEach(() => {
    dataDir = makeDataDir();
    wal = new WAL({ walFile: path.join(dataDir, 'wal.log'), syncOnCommit: false });
    wal.open();
  });

  afterEach(() => {
    wal.close();
    cleanup(dataDir);
  });

  test('assigns increasing log sequence numbers', () => {
    expect(wal.logBegin(1)).toBe(1n);
    expect(wal.logCommit(1)).toBe(2n);
    expect(wal.logBegin(2)).toBe(3n);
  });

  test('round-trips every record type', () => {
    const before = Buffer.alloc(32, 0xaa);
    const after = Buffer.alloc(32, 0xbb);

    wal.logBegin(1);
    wal.logUpdate(1, 7, before, after);
    wal.logCommit(1);
    wal.logAbort(2);
    wal.logCheckpoint();

    const records = wal.readAll();
    expect(records.map((r) => r.typeName)).toEqual(['BEGIN', 'UPDATE', 'COMMIT', 'ABORT', 'CHECKPOINT']);

    const update = records[1];
    expect(update.pageId).toBe(7);
    expect(update.beforeImage.equals(before)).toBe(true);
    expect(update.afterImage.equals(after)).toBe(true);
  });

  test('restores the next LSN when reopened', () => {
    wal.logBegin(1);
    wal.logCommit(1);
    wal.close();

    const reopened = new WAL({ walFile: path.join(dataDir, 'wal.log'), syncOnCommit: false });
    reopened.open();
    expect(reopened.logBegin(2)).toBe(3n);
    reopened.close();

    wal.open();
  });

  test('discards a torn trailing record rather than failing to open', () => {
    wal.logBegin(1);
    wal.logUpdate(1, 4, Buffer.alloc(16, 1), Buffer.alloc(16, 2));
    wal.logCommit(1);
    const fullSize = wal.size;
    wal.close();

    // Simulate a crash during the final write by truncating mid-record.
    fs.truncateSync(path.join(dataDir, 'wal.log'), fullSize - 3);

    const reopened = new WAL({ walFile: path.join(dataDir, 'wal.log'), syncOnCommit: false });
    reopened.open();
    const records = reopened.readAll();
    expect(records.map((r) => r.typeName)).toEqual(['BEGIN', 'UPDATE']);
    reopened.close();

    wal.open();
  });

  test('truncate empties the log and resets the LSN', () => {
    wal.logBegin(1);
    wal.truncate();

    expect(wal.readAll()).toEqual([]);
    expect(wal.logBegin(2)).toBe(1n);
  });
});

describe('RecoveryManager', () => {
  let dataDir;
  let storage;
  let wal;
  let recovery;
  let pageId;

  /** Builds a page image carrying one text record. */
  const imageWith = (text, version) => {
    const page = new Page(pageId, PAGE_SIZE);
    page.rewriteRecords([{ recordId: 1, version, payload: Buffer.from(text) }]);
    return page.serialize();
  };

  const currentText = () => {
    const record = storage.readPage(pageId).readRecord(1);
    return record ? record.payload.toString() : null;
  };

  beforeEach(() => {
    dataDir = makeDataDir();
    storage = new StorageManager({
      dataFile: path.join(dataDir, 'documents.dat'),
      pageSize: PAGE_SIZE,
      directoryPages: 4
    });
    storage.open();
    pageId = storage.createDocument(1);

    wal = new WAL({ walFile: path.join(dataDir, 'wal.log'), syncOnCommit: false });
    wal.open();
    recovery = new RecoveryManager({ wal, storage });
  });

  afterEach(() => {
    wal.close();
    storage.close();
    cleanup(dataDir);
  });

  test('classifies winners and losers', () => {
    wal.logBegin(1);
    wal.logCommit(1);
    wal.logBegin(2);
    wal.logBegin(3);
    wal.logAbort(3);

    const { winners, losers } = recovery.analyse(wal.readAll());
    expect([...winners]).toEqual([1]);
    expect([...losers].sort()).toEqual([2, 3]);
  });

  test('redoes a committed transaction whose page never reached disk', () => {
    const empty = new Page(pageId, PAGE_SIZE).serialize();
    wal.logBegin(1);
    wal.logUpdate(1, pageId, empty, imageWith('committed work', 1));
    wal.logCommit(1);

    expect(currentText()).toBeNull();
    const report = recovery.recover();

    expect(report.redone).toBe(1);
    expect(report.undone).toBe(0);
    expect(currentText()).toBe('committed work');
  });

  test('undoes a transaction that was stolen to disk but never committed', () => {
    const original = imageWith('original', 1);
    storage.writePageImage(pageId, original);

    wal.logBegin(1);
    wal.logUpdate(1, pageId, original, imageWith('uncommitted', 2));
    storage.writePageImage(pageId, imageWith('uncommitted', 2)); // the steal
    expect(currentText()).toBe('uncommitted');

    const report = recovery.recover();
    expect(report.undone).toBe(1);
    expect(currentText()).toBe('original');
  });

  test('undoes several writes by one transaction back to the oldest image', () => {
    const original = imageWith('v0', 1);
    storage.writePageImage(pageId, original);

    wal.logBegin(1);
    wal.logUpdate(1, pageId, original, imageWith('v1', 2));
    wal.logUpdate(1, pageId, imageWith('v1', 2), imageWith('v2', 3));
    storage.writePageImage(pageId, imageWith('v2', 3));

    recovery.recover();
    expect(currentText()).toBe('v0');
  });

  test('keeps a winner and discards a loser touching the same page', () => {
    const empty = new Page(pageId, PAGE_SIZE).serialize();

    wal.logBegin(1);
    wal.logUpdate(1, pageId, empty, imageWith('kept', 1));
    wal.logCommit(1);

    wal.logBegin(2);
    wal.logUpdate(2, pageId, imageWith('kept', 1), imageWith('discarded', 2));

    const report = recovery.recover();
    expect(report.winners).toEqual([1]);
    expect(report.losers).toEqual([2]);
    expect(currentText()).toBe('kept');
  });

  test('writes an ABORT record for each loser so recovery is restartable', () => {
    wal.logBegin(1);
    wal.logUpdate(1, pageId, new Page(pageId, PAGE_SIZE).serialize(), imageWith('x', 1));
    recovery.recover();

    const aborts = wal.readAll().filter((r) => r.type === RECORD_TYPES.ABORT);
    expect(aborts.map((r) => r.txId)).toEqual([1]);
  });

  test('is idempotent: recovering twice gives the same state', () => {
    const empty = new Page(pageId, PAGE_SIZE).serialize();
    wal.logBegin(1);
    wal.logUpdate(1, pageId, empty, imageWith('stable', 1));
    wal.logCommit(1);

    recovery.recover();
    const afterFirst = currentText();
    recovery.recover();

    expect(currentText()).toBe(afterFirst);
  });

  test('a clean log leaves the database untouched', () => {
    const report = recovery.recover();
    expect(report).toMatchObject({ scanned: 0, redone: 0, undone: 0 });
  });

  test('extends the data file for a page the log mentions but the file lacks', () => {
    const farPage = 40;
    const page = new Page(farPage, PAGE_SIZE);
    page.rewriteRecords([{ recordId: 1, version: 1, payload: Buffer.from('late page') }]);

    wal.logBegin(1);
    wal.logUpdate(1, farPage, new Page(farPage, PAGE_SIZE).serialize(), page.serialize());
    wal.logCommit(1);

    recovery.recover();
    expect(storage.readPage(farPage).readRecord(1).payload.toString()).toBe('late page');
  });
});
