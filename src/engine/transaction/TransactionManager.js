/**
 * CollabWrite - Transaction Manager (Phase 5)
 *
 * CONCEPT
 *   This module ties the other engine components into the ACID guarantees:
 *     Atomicity   - UNDO from the WAL before-images on ABORT.
 *     Consistency - every write goes through the conflict resolver.
 *     Isolation   - strict two-phase locking via the LockManager.
 *     Durability  - WAL COMMIT record is fsync'd before the commit returns.
 *
 * BUFFER MANAGEMENT POLICY
 *   The engine is STEAL / FORCE:
 *     steal  - the buffer pool may evict (and therefore write) a page belonging
 *              to a transaction that has not committed, so ABORT must be able
 *              to undo changes that already reached disk.
 *     force  - COMMIT flushes every page the transaction dirtied before it
 *              returns, so a committed transaction's data is on disk.
 *   Steal is why UNDO exists; force is why REDO is short. Both halves are
 *   still implemented because a crash can land between the COMMIT record and
 *   the flush.
 *
 * LIFECYCLE (design.md section 5)
 *   BEGIN  -> WAL BEGIN, transaction becomes ACTIVE.
 *   READ   -> S lock, fetch through buffer pool, remember the page version.
 *   WRITE  -> X lock, capture before-image, WAL UPDATE, then mutate the page.
 *             The log record is written first; that ordering is the whole
 *             point of write-ahead logging.
 *   COMMIT -> WAL COMMIT (fsync), flush dirty pages, release all locks.
 *   ABORT  -> restore before-images in reverse order, WAL ABORT, release locks.
 */

'use strict';

const { LockManager, LOCK_MODES } = require('../lock/LockManager');
const { Transaction, TX_STATES } = require('./Transaction');
const { createLogger } = require('../../config/logger');

const log = createLogger('TransactionManager');

class TransactionAbortedError extends Error {
  constructor(txId, reason, code = 'TRANSACTION_ABORTED') {
    super(`Transaction ${txId} aborted: ${reason}`);
    this.name = 'TransactionAbortedError';
    this.txId = txId;
    this.reason = reason;
    this.code = code;
  }
}

class TransactionManager {
  /**
   * @param {object} deps
   * @param {import('../storage/StorageManager').StorageManager} deps.storage
   * @param {import('../buffer/BufferPool').BufferPool} deps.bufferPool
   * @param {import('../lock/LockManager').LockManager} deps.lockManager
   * @param {import('../recovery/WAL').WAL} deps.wal
   * @param {import('../conflict/ConflictResolver').ConflictResolver} [deps.conflictResolver]
   */
  constructor({ storage, bufferPool, lockManager, wal, conflictResolver = null }) {
    this.storage = storage;
    this.bufferPool = bufferPool;
    this.lockManager = lockManager;
    this.wal = wal;
    this.conflictResolver = conflictResolver;

    this.nextTxId = 1;
    /** @type {Map<number, Transaction>} */
    this.active = new Map();
    this.stats = { begun: 0, committed: 0, aborted: 0, totalCommitMs: 0 };
    /** Transactions marked for abort by the deadlock detector. */
    this.deadlockVictims = new Set();
  }

  /**
   * Starts a transaction and writes its BEGIN record.
   * @param {object} [context] - userId, docId and similar caller metadata.
   * @returns {Transaction}
   */
  begin(context = {}) {
    const tx = new Transaction(this.nextTxId, context);
    this.nextTxId += 1;
    tx.startLSN = this.wal.logBegin(tx.txId);
    this.active.set(tx.txId, tx);
    this.stats.begun += 1;
    log.debug('Transaction began', { txId: tx.txId, context });
    return tx;
  }

  /** @param {number} txId @returns {Transaction|undefined} */
  get(txId) {
    return this.active.get(txId);
  }

  /**
   * Throws if the transaction was aborted underneath the caller, for example
   * by the deadlock detector while it waited for a lock.
   * @param {Transaction} tx
   */
  assertActive(tx) {
    if (this.deadlockVictims.has(tx.txId)) {
      this.deadlockVictims.delete(tx.txId);
      throw new TransactionAbortedError(tx.txId, 'selected as deadlock victim', 'DEADLOCK');
    }
    if (!tx.isActive) {
      throw new TransactionAbortedError(tx.txId, `transaction is ${tx.state}`, 'NOT_ACTIVE');
    }
  }

  /**
   * Acquires a lock on behalf of a transaction and records it for release.
   *
   * @param {Transaction} tx
   * @param {number} docId
   * @param {number} pageId
   * @param {'S'|'X'} mode
   */
  async acquireLock(tx, docId, pageId, mode) {
    this.assertActive(tx);
    const resourceId = LockManager.resourceId(docId, pageId);
    const result = await this.lockManager.acquire(tx.txId, resourceId, mode);
    tx.lockWaitMs += result.waitedMs;
    tx.recordLock(resourceId);
    this.assertActive(tx);
    return resourceId;
  }

  /**
   * Reads a page under a shared lock and remembers its version for the later
   * optimistic check.
   *
   * @param {Transaction} tx
   * @param {number} docId
   * @param {number} pageId
   * @returns {Promise<{pageId:number, version:number, records:Array<object>}>}
   */
  async read(tx, docId, pageId) {
    await this.acquireLock(tx, docId, pageId, LOCK_MODES.SHARED);

    const page = this.bufferPool.fetchPage(pageId);
    try {
      const version = TransactionManager.pageVersion(page);
      tx.recordRead(pageId, version);
      return {
        pageId,
        version,
        records: page.listRecords()
      };
    } finally {
      this.bufferPool.unpinPage(pageId, false);
    }
  }

  /**
   * Modifies a page under an exclusive lock.
   *
   * Order of operations is the write-ahead rule in code form:
   *   lock -> fetch -> capture before-image -> compute after-image
   *        -> WAL UPDATE -> install after-image -> unpin dirty
   *
   * @param {Transaction} tx
   * @param {number} docId
   * @param {number} pageId
   * @param {(page: import('../storage/Page').Page) => void} mutator
   *        Applies the change to a scratch copy of the page.
   * @param {object} [options]
   * @param {number} [options.expectedVersion] - Enables the optimistic check.
   * @returns {Promise<{pageId:number, version:number, lsn:string}>}
   */
  async write(tx, docId, pageId, mutator, { expectedVersion } = {}) {
    await this.acquireLock(tx, docId, pageId, LOCK_MODES.EXCLUSIVE);

    const page = this.bufferPool.fetchPage(pageId);
    let dirty = false;
    try {
      const beforeImage = page.serialize();
      const currentVersion = TransactionManager.pageVersion(page);
      tx.recordRead(pageId, currentVersion);

      if (this.conflictResolver && expectedVersion !== undefined) {
        // The lock is held at this point, so the version cannot change while
        // the check runs. A mismatch means somebody else committed between
        // the client reading and this transaction locking.
        this.conflictResolver.assertNoConflict({
          txId: tx.txId,
          pageId,
          expectedVersion,
          actualVersion: currentVersion
        });
      }

      mutator(page);
      dirty = true;

      const afterImage = page.serialize();
      const lsn = this.wal.logUpdate(tx.txId, pageId, beforeImage, afterImage);
      tx.recordWrite(pageId, beforeImage);

      return { pageId, version: TransactionManager.pageVersion(page), lsn: lsn.toString() };
    } finally {
      this.bufferPool.unpinPage(pageId, dirty);
    }
  }

  /**
   * Commits a transaction: durable log record first, then page flush, then
   * the shrinking phase of 2PL.
   *
   * @param {Transaction} tx
   * @returns {Promise<object>} The transaction summary.
   */
  async commit(tx) {
    this.assertActive(tx);

    tx.endLSN = this.wal.logCommit(tx.txId);
    for (const pageId of tx.modifiedPages) {
      this.bufferPool.flushPage(pageId);
    }
    if (tx.modifiedPages.length > 0) this.storage.sync();

    tx.state = TX_STATES.COMMITTED;
    tx.finishedAt = Date.now();
    this.lockManager.releaseAll(tx.txId, 'committed');
    this.active.delete(tx.txId);

    this.stats.committed += 1;
    this.stats.totalCommitMs += tx.durationMs;
    log.debug('Transaction committed', { txId: tx.txId, pages: tx.modifiedPages.length });
    return tx.toJSON();
  }

  /**
   * Aborts a transaction, undoing its writes in reverse order.
   *
   * Because the pool may already have stolen (flushed) a dirty page, the
   * before-image is written through to disk and the frame is invalidated so
   * the next reader sees the restored image.
   *
   * @param {Transaction} tx
   * @param {string} [reason]
   * @returns {Promise<object>} The transaction summary.
   */
  async abort(tx, reason = 'aborted by caller') {
    if (tx.state === TX_STATES.ABORTED) return tx.toJSON();

    for (let i = tx.undoLog.length - 1; i >= 0; i -= 1) {
      const { pageId, beforeImage } = tx.undoLog[i];
      this.bufferPool.invalidate(pageId);
      this.storage.writePageImage(pageId, beforeImage);
    }
    if (tx.undoLog.length > 0) this.storage.sync();

    tx.endLSN = this.wal.logAbort(tx.txId);
    tx.state = TX_STATES.ABORTED;
    tx.abortReason = reason;
    tx.finishedAt = Date.now();

    this.lockManager.releaseAll(tx.txId, reason);
    this.active.delete(tx.txId);
    this.deadlockVictims.delete(tx.txId);

    this.stats.aborted += 1;
    log.debug('Transaction aborted', { txId: tx.txId, reason });
    return tx.toJSON();
  }

  /**
   * Marks a transaction as a deadlock victim. The lock manager rejects its
   * pending request, and the next assertActive call turns that into an abort.
   * Called from the DeadlockDetector sweep.
   *
   * @param {number} txId
   * @param {number[]} cycle - The deadlock cycle, for logging.
   */
  markDeadlockVictim(txId, cycle) {
    const tx = this.active.get(txId);
    if (!tx) return;
    this.deadlockVictims.add(txId);
    log.warn('Marking deadlock victim', { txId, cycle });
    this.lockManager.releaseAll(txId, 'deadlock victim');
  }

  /**
   * Runs a unit of work inside a transaction, committing on success and
   * aborting on any thrown error.
   *
   * @param {object} context
   * @param {(tx: Transaction) => Promise<any>} work
   * @returns {Promise<{result:any, transaction:object}>}
   */
  async runInTransaction(context, work) {
    const tx = this.begin(context);
    try {
      const result = await work(tx);
      const summary = await this.commit(tx);
      return { result, transaction: summary };
    } catch (error) {
      await this.abort(tx, error.message);
      throw error;
    }
  }

  /**
   * A page's version is the highest record version it carries. An empty page
   * has version 0. Keeping the version in the record header rather than the
   * page header avoids changing the on-disk page layout fixed by design.md
   * section 3.
   *
   * @param {import('../storage/Page').Page} page
   * @returns {number}
   */
  static pageVersion(page) {
    let version = 0;
    for (const record of page.listRecords()) {
      if (record.version > version) version = record.version;
    }
    return version;
  }

  /** @returns {object} Counters plus the mean commit latency. */
  getStats() {
    return {
      ...this.stats,
      active: this.active.size,
      averageCommitMs: this.stats.committed === 0
        ? 0
        : Number((this.stats.totalCommitMs / this.stats.committed).toFixed(2))
    };
  }
}

module.exports = { TransactionManager, TransactionAbortedError, TX_STATES };
