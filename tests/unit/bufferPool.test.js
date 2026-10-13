/**
 * Phase 4 - Buffer Pool and LRU tests.
 *
 * The properties worth asserting are the ones a wrong implementation would
 * silently break: eviction order, the pin invariant, and dirty write-back.
 */

'use strict';

const path = require('path');

const { LRUCache } = require('../../src/engine/buffer/LRUCache');
const { BufferPool, BufferPoolFullError } = require('../../src/engine/buffer/BufferPool');
const { StorageManager } = require('../../src/engine/storage/StorageManager');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

describe('LRUCache', () => {
  test('orders eviction least-recently-used first', () => {
    const lru = new LRUCache();
    lru.touch(1);
    lru.touch(2);
    lru.touch(3);

    expect(lru.evictionOrder()).toEqual([1, 2, 3]);
    expect(lru.usageOrder()).toEqual([3, 2, 1]);
  });

  test('re-touching a page makes it the most recently used', () => {
    const lru = new LRUCache();
    lru.touch(1);
    lru.touch(2);
    lru.touch(3);
    lru.touch(1);

    expect(lru.evictionOrder()).toEqual([2, 3, 1]);
  });

  test('removes pages and keeps the list consistent', () => {
    const lru = new LRUCache();
    [1, 2, 3].forEach((id) => lru.touch(id));

    lru.remove(2);
    expect(lru.size).toBe(2);
    expect(lru.evictionOrder()).toEqual([1, 3]);

    lru.remove(1);
    lru.remove(3);
    expect(lru.size).toBe(0);
    expect(lru.evictionOrder()).toEqual([]);
  });
});

describe('BufferPool', () => {
  let dataDir;
  let storage;
  let pool;
  let pageIds;

  beforeEach(() => {
    dataDir = makeDataDir();
    storage = new StorageManager({
      dataFile: path.join(dataDir, 'documents.dat'),
      pageSize: 4096,
      directoryPages: 4
    });
    storage.open();
    storage.createDocument(1);
    pageIds = [storage.getDocumentPages(1)[0]];
    for (let i = 0; i < 5; i += 1) pageIds.push(storage.allocatePage(1));

    pool = new BufferPool(storage, { frames: 3 });
  });

  afterEach(() => {
    storage.close();
    cleanup(dataDir);
  });

  test('counts hits and misses', () => {
    pool.fetchPage(pageIds[0]);
    pool.unpinPage(pageIds[0], false);
    pool.fetchPage(pageIds[0]);
    pool.unpinPage(pageIds[0], false);

    const stats = pool.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.hitRatio).toBe(0.5);
  });

  test('evicts the least recently used unpinned frame', () => {
    for (let i = 0; i < 3; i += 1) {
      pool.fetchPage(pageIds[i]);
      pool.unpinPage(pageIds[i], false);
    }
    // Re-touch the oldest so the middle one becomes the eviction candidate.
    pool.fetchPage(pageIds[0]);
    pool.unpinPage(pageIds[0], false);

    pool.fetchPage(pageIds[3]);
    pool.unpinPage(pageIds[3], false);

    expect(pool.pageTable.has(pageIds[1])).toBe(false);
    expect(pool.pageTable.has(pageIds[0])).toBe(true);
    expect(pool.getStats().evictions).toBe(1);
  });

  test('never evicts a pinned page', () => {
    for (let i = 0; i < 3; i += 1) pool.fetchPage(pageIds[i]); // left pinned
    expect(() => pool.fetchPage(pageIds[3])).toThrow(BufferPoolFullError);
  });

  test('writes a dirty page back before evicting it', () => {
    const page = pool.fetchPage(pageIds[0]);
    page.insertRecord(1, 'dirty payload', 1);
    pool.unpinPage(pageIds[0], true);

    for (let i = 1; i < 4; i += 1) {
      pool.fetchPage(pageIds[i]);
      pool.unpinPage(pageIds[i], false);
    }

    expect(pool.pageTable.has(pageIds[0])).toBe(false);
    expect(storage.readPage(pageIds[0]).readRecord(1).payload.toString()).toBe('dirty payload');
  });

  test('flushAll writes every dirty frame exactly once', () => {
    for (let i = 0; i < 2; i += 1) {
      const page = pool.fetchPage(pageIds[i]);
      page.insertRecord(1, `page-${i}`, 1);
      pool.unpinPage(pageIds[i], true);
    }

    expect(pool.flushAll()).toBe(2);
    expect(pool.flushAll()).toBe(0);
    expect(storage.readPage(pageIds[1]).readRecord(1).payload.toString()).toBe('page-1');
  });

  test('invalidate drops a frame without writing it back', () => {
    const page = pool.fetchPage(pageIds[0]);
    page.insertRecord(1, 'never persisted', 1);
    pool.unpinPage(pageIds[0], true);

    pool.invalidate(pageIds[0]);
    expect(pool.pageTable.has(pageIds[0])).toBe(false);
    expect(storage.readPage(pageIds[0]).recordCount).toBe(0);
  });
});
