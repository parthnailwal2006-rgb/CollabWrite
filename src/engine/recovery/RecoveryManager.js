/**
 * CollabWrite - Recovery Manager (Phase 11)
 *
 * CONCEPT
 *   After a crash the data file may contain anything: pages from committed
 *   transactions that never reached disk, and pages from uncommitted ones that
 *   were stolen out of the buffer pool and did. Recovery restores the single
 *   correct state implied by the log.
 *
 * ALGORITHM - three passes over the WAL
 *   1. ANALYSIS  Walk the log and classify every transaction.
 *                  winner : a COMMIT record exists   -> its work must survive
 *                  loser  : BEGIN with no COMMIT      -> its work must vanish
 *                An explicit ABORT also makes a transaction a loser, and its
 *                updates are undone just the same.
 *   2. REDO      Forward pass in LSN order. For each UPDATE belonging to a
 *                winner, write the after-image to its page. Replaying in LSN
 *                order makes the result identical to the original execution.
 *                REDO is idempotent: writing an after-image twice is harmless,
 *                which is what makes a crash during recovery survivable.
 *   3. UNDO      Backward pass from the end of the log. For each UPDATE
 *                belonging to a loser, write the before-image. Going backwards
 *                matters when one transaction wrote the same page repeatedly -
 *                the oldest before-image must be the one that lands last.
 *
 * WHY BOTH PASSES
 *   REDO is needed because COMMIT only forces the log, and a crash can fall
 *   between the COMMIT record and the page flush. UNDO is needed because the
 *   buffer pool steals: an uncommitted dirty page can be evicted to disk at
 *   any moment. See the policy note in TransactionManager.
 */

'use strict';

const { RECORD_TYPES } = require('./WAL');
const { createLogger } = require('../../config/logger');

const log = createLogger('RecoveryManager');

class RecoveryManager {
  /**
   * @param {object} deps
   * @param {import('./WAL').WAL} deps.wal
   * @param {import('../storage/StorageManager').StorageManager} deps.storage
   * @param {import('../buffer/BufferPool').BufferPool} [deps.bufferPool]
   */
  constructor({ wal, storage, bufferPool = null }) {
    this.wal = wal;
    this.storage = storage;
    this.bufferPool = bufferPool;
    this.lastReport = null;
  }

  /**
   * Pass 1. Classifies transactions found in the log.
   *
   * @param {Array<object>} records
   * @returns {{winners:Set<number>, losers:Set<number>, started:Set<number>}}
   */
  analyse(records) {
    const started = new Set();
    const committed = new Set();
    const aborted = new Set();

    for (const record of records) {
      switch (record.type) {
        case RECORD_TYPES.BEGIN:
          started.add(record.txId);
          break;
        case RECORD_TYPES.COMMIT:
          committed.add(record.txId);
          break;
        case RECORD_TYPES.ABORT:
          aborted.add(record.txId);
          break;
        default:
          break;
      }
    }

    const losers = new Set();
    for (const txId of started) {
      if (!committed.has(txId)) losers.add(txId);
    }
    return { winners: committed, losers, started };
  }

  /**
   * Pass 2. Re-applies the after-images of committed transactions.
   *
   * @param {Array<object>} records
   * @param {Set<number>} winners
   * @returns {number} Pages rewritten.
   */
  redo(records, winners) {
    let applied = 0;
    for (const record of records) {
      if (record.type !== RECORD_TYPES.UPDATE) continue;
      if (!winners.has(record.txId)) continue;
      if (!record.afterImage) continue;

      this.storage.ensureCapacity(record.pageId);
      this.storage.writePageImage(record.pageId, record.afterImage);
      if (this.bufferPool) this.bufferPool.invalidate(record.pageId);
      applied += 1;
    }
    return applied;
  }

  /**
   * Pass 3. Reverts the before-images of transactions that never committed,
   * walking the log backwards so the earliest image wins.
   *
   * @param {Array<object>} records
   * @param {Set<number>} losers
   * @returns {number} Pages rewritten.
   */
  undo(records, losers) {
    let reverted = 0;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (record.type !== RECORD_TYPES.UPDATE) continue;
      if (!losers.has(record.txId)) continue;
      if (!record.beforeImage) continue;

      this.storage.ensureCapacity(record.pageId);
      this.storage.writePageImage(record.pageId, record.beforeImage);
      if (this.bufferPool) this.bufferPool.invalidate(record.pageId);
      reverted += 1;
    }
    return reverted;
  }

  /**
   * Runs the full recovery routine. Safe to call on a clean start, where it
   * finds no losers and redoes already-present after-images.
   *
   * @returns {{scanned:number, winners:number[], losers:number[],
   *            redone:number, undone:number, durationMs:number}}
   */
  recover() {
    const startedAt = Date.now();
    const records = this.wal.readAll();

    const { winners, losers } = this.analyse(records);
    const redone = this.redo(records, winners);
    const undone = this.undo(records, losers);

    // Each loser gets an ABORT record so a second crash during recovery does
    // not have to redo the same UNDO work from scratch.
    for (const txId of losers) {
      this.wal.logAbort(txId);
    }
    if (records.length > 0) this.storage.sync();

    const report = {
      scanned: records.length,
      winners: [...winners].sort((a, b) => a - b),
      losers: [...losers].sort((a, b) => a - b),
      redone,
      undone,
      durationMs: Date.now() - startedAt
    };
    this.lastReport = report;

    if (records.length > 0) {
      log.info('Recovery complete', report);
    }
    return report;
  }

  /**
   * Writes a checkpoint record. A checkpoint marks a point at which every
   * dirty page has been flushed, so recovery may ignore everything before it.
   * Truncating the log at that point is listed as a future improvement in
   * design.md section 12 and is not performed here.
   *
   * @returns {string} The checkpoint LSN.
   */
  checkpoint() {
    if (this.bufferPool) this.bufferPool.flushAll();
    this.storage.sync();
    return this.wal.logCheckpoint().toString();
  }
}

module.exports = { RecoveryManager };
