/**
 * CollabWrite - Lock Manager (Phase 6)
 *
 * CONCEPT
 *   Two-phase locking is what makes concurrent transactions serialisable. Each
 *   transaction has a growing phase in which it only acquires locks and a
 *   shrinking phase, entered at COMMIT or ABORT, in which it only releases
 *   them. Because no lock is released before the last one is taken, the
 *   resulting schedule is conflict-serialisable.
 *
 * DATA STRUCTURES (design.md section 6)
 *   lockTable : Map<resourceId, LockInfo>
 *   LockInfo  : { holders: Map<txId, 'S'|'X'>, waitQueue: LockRequest[] }
 *   LockRequest : { txId, mode, resolve, reject, enqueuedAt, timer }
 *
 * COMPATIBILITY MATRIX
 *            held S   held X
 *   want S     yes      no
 *   want X      no      no
 *
 * ALGORITHM - acquire(txId, resourceId, mode)
 *   1. Already held at an equal or stronger mode -> grant immediately.
 *   2. Holding S and asking for X while being the only holder -> upgrade.
 *   3. Compatible with every holder AND nobody is already queued -> grant.
 *      The second condition is deliberate: letting a compatible request jump a
 *      queue of waiting writers would starve them.
 *   4. Otherwise enqueue and return a pending promise.
 *
 * ALGORITHM - release
 *   Remove the holder, then walk the queue from the front granting requests
 *   while they remain compatible, stopping at the first that is not. FIFO
 *   order is preserved, so every waiter eventually runs.
 *
 * DEADLOCK
 *   This module does not resolve deadlocks; it only exposes the wait-for edges
 *   that DeadlockDetector needs. Separating detection from the lock table
 *   keeps each piece small enough to test on its own.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('LockManager');

const LOCK_MODES = { SHARED: 'S', EXCLUSIVE: 'X' };

class LockTimeoutError extends Error {
  constructor(txId, resourceId, timeoutMs) {
    super(`Transaction ${txId} timed out after ${timeoutMs}ms waiting for ${resourceId}`);
    this.name = 'LockTimeoutError';
    this.txId = txId;
    this.resourceId = resourceId;
  }
}

class LockAbortedError extends Error {
  constructor(txId, resourceId, reason) {
    super(`Lock request by transaction ${txId} on ${resourceId} was aborted: ${reason}`);
    this.name = 'LockAbortedError';
    this.txId = txId;
    this.resourceId = resourceId;
    this.reason = reason;
  }
}

/**
 * @param {'S'|'X'} requested
 * @param {'S'|'X'} held
 * @returns {boolean} True when the two modes may be held simultaneously.
 */
function isCompatible(requested, held) {
  return requested === LOCK_MODES.SHARED && held === LOCK_MODES.SHARED;
}

class LockManager {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] - Per-request timeout; 0 disables it.
   */
  constructor({ timeoutMs = 0 } = {}) {
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, {holders: Map<number,'S'|'X'>, waitQueue: Array<object>}>} */
    this.lockTable = new Map();
    this.stats = { granted: 0, waited: 0, timeouts: 0, totalWaitMs: 0 };
  }

  /**
   * Builds the resource identifier used as the lock table key. Locking is at
   * page granularity, which matches the buffer pool and keeps the lock table
   * small enough to print during a demo.
   *
   * @param {number} docId
   * @param {number} pageId
   * @returns {string}
   */
  static resourceId(docId, pageId) {
    return `doc:${docId}/page:${pageId}`;
  }

  getOrCreate(resourceId) {
    let info = this.lockTable.get(resourceId);
    if (!info) {
      info = { holders: new Map(), waitQueue: [] };
      this.lockTable.set(resourceId, info);
    }
    return info;
  }

  /**
   * Requests a lock, resolving once it is granted.
   *
   * @param {number} txId
   * @param {string} resourceId
   * @param {'S'|'X'} mode
   * @returns {Promise<{granted:boolean, waitedMs:number, upgraded:boolean}>}
   * @throws {LockTimeoutError|LockAbortedError} via promise rejection.
   */
  acquire(txId, resourceId, mode) {
    const info = this.getOrCreate(resourceId);
    const held = info.holders.get(txId);

    // 1. Already held at an equal or stronger mode.
    if (held === mode || held === LOCK_MODES.EXCLUSIVE) {
      this.stats.granted += 1;
      return Promise.resolve({ granted: true, waitedMs: 0, upgraded: false });
    }

    // 2. S -> X upgrade while sole holder.
    if (held === LOCK_MODES.SHARED && mode === LOCK_MODES.EXCLUSIVE && info.holders.size === 1) {
      info.holders.set(txId, LOCK_MODES.EXCLUSIVE);
      this.stats.granted += 1;
      log.debug('Lock upgraded', { txId, resourceId });
      return Promise.resolve({ granted: true, waitedMs: 0, upgraded: true });
    }

    // 3. Compatible with all holders and no queue ahead of us.
    if (this.canGrant(info, txId, mode)) {
      info.holders.set(txId, mode);
      this.stats.granted += 1;
      return Promise.resolve({ granted: true, waitedMs: 0, upgraded: false });
    }

    // 4. Wait.
    this.stats.waited += 1;
    return new Promise((resolve, reject) => {
      const request = {
        txId,
        mode,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timer: null
      };
      if (this.timeoutMs > 0) {
        request.timer = setTimeout(() => {
          this.cancelRequest(resourceId, request, new LockTimeoutError(txId, resourceId, this.timeoutMs));
          this.stats.timeouts += 1;
        }, this.timeoutMs);
        if (typeof request.timer.unref === 'function') request.timer.unref();
      }
      info.waitQueue.push(request);
      log.debug('Lock request queued', { txId, resourceId, mode, queueLength: info.waitQueue.length });
    });
  }

  /**
   * @param {object} info - Lock table entry.
   * @param {number} txId
   * @param {'S'|'X'} mode
   * @returns {boolean} True when the request can be granted right now.
   */
  canGrant(info, txId, mode) {
    if (info.waitQueue.some((r) => r.txId !== txId)) return false;
    for (const [holderTx, holderMode] of info.holders) {
      if (holderTx === txId) continue;
      if (!isCompatible(mode, holderMode)) return false;
    }
    return true;
  }

  /**
   * Releases one lock held by a transaction and wakes eligible waiters.
   * @param {number} txId
   * @param {string} resourceId
   */
  release(txId, resourceId) {
    const info = this.lockTable.get(resourceId);
    if (!info) return;
    info.holders.delete(txId);
    this.drain(resourceId, info);
  }

  /**
   * Releases every lock held by a transaction and cancels its pending
   * requests. This is the shrinking phase of 2PL and runs exactly once, at
   * COMMIT or ABORT.
   *
   * @param {number} txId
   * @param {string} [reason] - Supplied when the transaction is being aborted.
   */
  releaseAll(txId, reason = 'transaction finished') {
    for (const [resourceId, info] of this.lockTable) {
      const pending = info.waitQueue.filter((r) => r.txId === txId);
      for (const request of pending) {
        this.cancelRequest(resourceId, request, new LockAbortedError(txId, resourceId, reason));
      }
      if (info.holders.delete(txId)) {
        this.drain(resourceId, info);
      }
    }
    this.pruneEmpty();
  }

  /**
   * Grants queued requests from the front while they remain compatible.
   * @param {string} resourceId
   * @param {object} info
   */
  drain(resourceId, info) {
    while (info.waitQueue.length > 0) {
      const next = info.waitQueue[0];
      const held = info.holders.get(next.txId);
      const upgradable =
        held === LOCK_MODES.SHARED &&
        next.mode === LOCK_MODES.EXCLUSIVE &&
        info.holders.size === 1;

      let grantable = upgradable;
      if (!grantable) {
        grantable = true;
        for (const [holderTx, holderMode] of info.holders) {
          if (holderTx === next.txId) continue;
          if (!isCompatible(next.mode, holderMode)) {
            grantable = false;
            break;
          }
        }
      }
      if (!grantable) break;

      info.waitQueue.shift();
      if (next.timer) clearTimeout(next.timer);
      info.holders.set(next.txId, next.mode);

      const waitedMs = Date.now() - next.enqueuedAt;
      this.stats.granted += 1;
      this.stats.totalWaitMs += waitedMs;
      next.resolve({ granted: true, waitedMs, upgraded: upgradable });
    }
  }

  /**
   * Removes a queued request and rejects its promise.
   * @param {string} resourceId
   * @param {object} request
   * @param {Error} error
   */
  cancelRequest(resourceId, request, error) {
    const info = this.lockTable.get(resourceId);
    if (!info) return;
    const position = info.waitQueue.indexOf(request);
    if (position === -1) return;
    info.waitQueue.splice(position, 1);
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
    this.drain(resourceId, info);
  }

  /** Drops lock table entries with neither holders nor waiters. */
  pruneEmpty() {
    for (const [resourceId, info] of this.lockTable) {
      if (info.holders.size === 0 && info.waitQueue.length === 0) {
        this.lockTable.delete(resourceId);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Introspection - consumed by DeadlockDetector, the demos and the admin API
  // ---------------------------------------------------------------------

  /**
   * Produces the edges of the wait-for graph: Ti -> Tj when Ti is queued for a
   * resource held by Tj in an incompatible mode.
   *
   * @returns {Array<{waiter:number, holder:number, resourceId:string, mode:string}>}
   */
  getWaitForEdges() {
    const edges = [];
    for (const [resourceId, info] of this.lockTable) {
      for (const request of info.waitQueue) {
        for (const [holderTx, holderMode] of info.holders) {
          if (holderTx === request.txId) continue;
          if (isCompatible(request.mode, holderMode)) continue;
          edges.push({ waiter: request.txId, holder: holderTx, resourceId, mode: request.mode });
        }
      }
    }
    return edges;
  }

  /** @param {number} txId @returns {string[]} Resources the transaction holds. */
  getLocksHeldBy(txId) {
    const held = [];
    for (const [resourceId, info] of this.lockTable) {
      if (info.holders.has(txId)) held.push(resourceId);
    }
    return held;
  }

  /** @returns {number[]} Transactions currently blocked on some resource. */
  getWaitingTransactions() {
    const waiting = new Set();
    for (const info of this.lockTable.values()) {
      for (const request of info.waitQueue) waiting.add(request.txId);
    }
    return [...waiting];
  }

  /**
   * Renders the lock table for the concurrency demo.
   * @returns {Array<{resourceId:string, holders:Array<{txId:number,mode:string}>, waiting:Array<{txId:number,mode:string}>}>}
   */
  snapshot() {
    return [...this.lockTable.entries()].map(([resourceId, info]) => ({
      resourceId,
      holders: [...info.holders.entries()].map(([txId, mode]) => ({ txId, mode })),
      waiting: info.waitQueue.map((r) => ({ txId: r.txId, mode: r.mode }))
    }));
  }

  /** @returns {object} Aggregate counters including mean wait time. */
  getStats() {
    return {
      ...this.stats,
      averageWaitMs: this.stats.waited === 0
        ? 0
        : Number((this.stats.totalWaitMs / this.stats.waited).toFixed(2))
    };
  }

  /** Rejects every waiter and clears the table. Used on shutdown. */
  reset() {
    for (const [resourceId, info] of this.lockTable) {
      for (const request of [...info.waitQueue]) {
        this.cancelRequest(resourceId, request, new LockAbortedError(request.txId, resourceId, 'lock manager reset'));
      }
    }
    this.lockTable.clear();
    this.stats = { granted: 0, waited: 0, timeouts: 0, totalWaitMs: 0 };
  }
}

module.exports = { LockManager, LOCK_MODES, LockTimeoutError, LockAbortedError, isCompatible };
