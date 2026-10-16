/**
 * CollabWrite - Transaction (Phase 5)
 *
 * CONCEPT
 *   A transaction is the unit of atomicity. Everything it does either becomes
 *   visible together at COMMIT or disappears together at ABORT. This object is
 *   the in-memory bookkeeping for one such unit; it is deliberately passive,
 *   with all state changes driven by the TransactionManager.
 *
 * DATA STRUCTURES (design.md section 5)
 *   txId           monotonically increasing integer
 *   state          ACTIVE | COMMITTED | ABORTED
 *   startLSN       LSN of this transaction's BEGIN record
 *   modifiedPages  pageIds written, in write order (UNDO walks it backwards)
 *   locksHeld      resource identifiers, for the shrinking phase of 2PL
 *   readVersions   pageId -> version observed at read time, used by the
 *                  optimistic check in ConflictResolver
 */

'use strict';

const TX_STATES = {
  ACTIVE: 'ACTIVE',
  COMMITTED: 'COMMITTED',
  ABORTED: 'ABORTED'
};

class Transaction {
  /**
   * @param {number} txId
   * @param {object} [context] - Caller metadata (userId, docId) for auditing.
   */
  constructor(txId, context = {}) {
    this.txId = txId;
    this.state = TX_STATES.ACTIVE;
    this.context = context;
    this.startLSN = null;
    this.endLSN = null;
    /** @type {number[]} */
    this.modifiedPages = [];
    /** @type {string[]} */
    this.locksHeld = [];
    /** @type {Map<number, number>} */
    this.readVersions = new Map();
    /** @type {Array<{pageId:number, beforeImage:Buffer}>} */
    this.undoLog = [];
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.lockWaitMs = 0;
    this.abortReason = null;
  }

  get isActive() {
    return this.state === TX_STATES.ACTIVE;
  }

  /** @param {string} resourceId */
  recordLock(resourceId) {
    if (!this.locksHeld.includes(resourceId)) this.locksHeld.push(resourceId);
  }

  /**
   * Remembers the version a page had when this transaction first saw it.
   * Only the first observation is kept - that is the value the optimistic
   * check must compare against.
   *
   * @param {number} pageId
   * @param {number} version
   */
  recordRead(pageId, version) {
    if (!this.readVersions.has(pageId)) this.readVersions.set(pageId, version);
  }

  /**
   * @param {number} pageId
   * @param {Buffer} beforeImage - Page image captured before the first write.
   */
  recordWrite(pageId, beforeImage) {
    if (!this.modifiedPages.includes(pageId)) this.modifiedPages.push(pageId);
    this.undoLog.push({ pageId, beforeImage });
  }

  /** @returns {number} Wall-clock duration so far, in milliseconds. */
  get durationMs() {
    return (this.finishedAt || Date.now()) - this.startedAt;
  }

  /** @returns {object} Plain summary for logs, metrics and the demo scripts. */
  toJSON() {
    return {
      txId: this.txId,
      state: this.state,
      startLSN: this.startLSN === null ? null : this.startLSN.toString(),
      endLSN: this.endLSN === null ? null : this.endLSN.toString(),
      modifiedPages: [...this.modifiedPages],
      locksHeld: [...this.locksHeld],
      durationMs: this.durationMs,
      lockWaitMs: this.lockWaitMs,
      abortReason: this.abortReason
    };
  }
}

module.exports = { Transaction, TX_STATES };
