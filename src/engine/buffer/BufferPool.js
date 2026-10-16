/**
 * CollabWrite - Buffer Pool Manager (Phase 4)
 *
 * CONCEPT
 *   Every page the engine touches is read through the buffer pool, never
 *   directly from the storage manager. The pool caches a fixed number of
 *   frames in memory, tracks which of them are in use (pinned) and which have
 *   been modified (dirty), and evicts by LRU when a new frame is needed. This
 *   is the DBMS equivalent of an OS page cache with pin counts standing in for
 *   reference counts.
 *
 * DATA STRUCTURES (design.md section 4)
 *   pageTable : Map<pageId, BufferFrame>
 *   BufferFrame = { page, pinCount, dirty }
 *   lru       : LRUCache over resident pageIds
 *
 * ALGORITHM - fetchPage(pageId)
 *   1. Hit  : frame is resident -> pinCount += 1, touch LRU, return frame.
 *   2. Miss : pool is full -> walk LRU from the least-recently-used end for a
 *             frame with pinCount === 0; flush it if dirty, drop it.
 *   3.      : read the page through the storage manager, install the frame.
 *
 * INVARIANT
 *   A page with pinCount > 0 is never evicted. A transaction that holds a
 *   pinned frame therefore cannot have the page pulled out from under it.
 */

'use strict';

const { LRUCache } = require('./LRUCache');
const { createLogger } = require('../../config/logger');

const log = createLogger('BufferPool');

class BufferPoolFullError extends Error {
  constructor(frames) {
    super(`All ${frames} buffer frames are pinned; no page can be evicted`);
    this.name = 'BufferPoolFullError';
  }
}

class BufferPool {
  /**
   * @param {import('../storage/StorageManager').StorageManager} storageManager
   * @param {object} options
   * @param {number} options.frames - Number of resident frames.
   */
  constructor(storageManager, { frames }) {
    this.storage = storageManager;
    this.capacity = frames;
    /** @type {Map<number, {page: object, pinCount: number, dirty: boolean}>} */
    this.pageTable = new Map();
    this.lru = new LRUCache();
    this.stats = { hits: 0, misses: 0, evictions: 0, flushes: 0 };
  }

  /** @returns {number} Frames currently holding a page. */
  get size() {
    return this.pageTable.size;
  }

  /**
   * Pins a page in memory, loading it from disk on a miss.
   *
   * @param {number} pageId
   * @returns {import('../storage/Page').Page} The cached page, now pinned.
   * @throws {BufferPoolFullError} When every frame is pinned.
   */
  fetchPage(pageId) {
    const resident = this.pageTable.get(pageId);
    if (resident) {
      resident.pinCount += 1;
      this.lru.touch(pageId);
      this.stats.hits += 1;
      return resident.page;
    }

    this.stats.misses += 1;
    if (this.pageTable.size >= this.capacity) {
      this.evictOne();
    }

    const page = this.storage.readPage(pageId);
    this.pageTable.set(pageId, { page, pinCount: 1, dirty: false });
    this.lru.touch(pageId);
    return page;
  }

  /**
   * Releases one pin on a page and records whether it was modified.
   *
   * @param {number} pageId
   * @param {boolean} isDirty - True when the caller changed the page contents.
   */
  unpinPage(pageId, isDirty = false) {
    const frame = this.pageTable.get(pageId);
    if (!frame) return;
    if (isDirty) frame.dirty = true;
    frame.pinCount = Math.max(0, frame.pinCount - 1);
  }

  /** @param {number} pageId @returns {boolean} */
  isDirty(pageId) {
    const frame = this.pageTable.get(pageId);
    return Boolean(frame && frame.dirty);
  }

  /** @param {number} pageId @returns {number} */
  pinCount(pageId) {
    const frame = this.pageTable.get(pageId);
    return frame ? frame.pinCount : 0;
  }

  /**
   * Writes a dirty page back to the storage manager and clears its flag.
   * @param {number} pageId
   * @returns {boolean} True when a write actually happened.
   */
  flushPage(pageId) {
    const frame = this.pageTable.get(pageId);
    if (!frame || !frame.dirty) return false;
    this.storage.writePage(frame.page);
    frame.dirty = false;
    this.stats.flushes += 1;
    return true;
  }

  /**
   * Flushes every dirty frame. Called on COMMIT and on clean shutdown.
   * @returns {number} Number of pages written.
   */
  flushAll() {
    let written = 0;
    for (const pageId of this.pageTable.keys()) {
      if (this.flushPage(pageId)) written += 1;
    }
    return written;
  }

  /**
   * Evicts the least recently used unpinned frame, flushing it if dirty.
   * @returns {number} The evicted page identifier.
   * @throws {BufferPoolFullError}
   */
  evictOne() {
    for (const candidate of this.lru.evictionOrder()) {
      const frame = this.pageTable.get(candidate);
      if (!frame || frame.pinCount > 0) continue;

      if (frame.dirty) this.flushPage(candidate);
      this.pageTable.delete(candidate);
      this.lru.remove(candidate);
      this.stats.evictions += 1;
      log.debug('Evicted page', { pageId: candidate });
      return candidate;
    }
    throw new BufferPoolFullError(this.capacity);
  }

  /**
   * Drops a page from the pool without writing it back. The recovery manager
   * uses this after rewriting pages underneath the pool so that the next fetch
   * sees the on-disk image.
   * @param {number} pageId
   */
  invalidate(pageId) {
    this.pageTable.delete(pageId);
    this.lru.remove(pageId);
  }

  /** Drops every frame without flushing. Used when simulating a crash. */
  invalidateAll() {
    this.pageTable.clear();
    this.lru.clear();
  }

  /**
   * @returns {{hits:number, misses:number, evictions:number, flushes:number,
   *            hitRatio:number, resident:number, capacity:number}}
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRatio: total === 0 ? 0 : Number((this.stats.hits / total).toFixed(4)),
      resident: this.pageTable.size,
      capacity: this.capacity
    };
  }

  resetStats() {
    this.stats = { hits: 0, misses: 0, evictions: 0, flushes: 0 };
  }
}

module.exports = { BufferPool, BufferPoolFullError };
