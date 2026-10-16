/**
 * CollabWrite - Conflict Resolver (Phase 9)
 *
 * CONCEPT
 *   Locking alone does not stop a client from submitting an edit computed
 *   against a stale copy of the document. The client reads version 7, types,
 *   and by the time its request reaches the engine another transaction has
 *   committed version 8. The lock is granted - nobody else holds it any more -
 *   but applying the edit at the old offsets would corrupt the text. The fix
 *   is an optimistic version check performed after the lock is held.
 *
 * SCOPE NOTE (design.md section 10)
 *   Full Operational Transformation is explicitly out of scope for this
 *   project. Concurrency correctness is provided by two-phase locking plus
 *   version checking: non-overlapping edits are merged, overlapping ones abort
 *   and the client retries against the fresh version. This is weaker than OT
 *   in user experience and strictly equivalent in correctness, which is the
 *   trade-off design.md section 17 records.
 *
 * ALGORITHM
 *   1. Version check : expectedVersion !== actualVersion -> conflict.
 *   2. Range check   : two edits whose affected character ranges are disjoint
 *                      can both be applied; the later one has its offset
 *                      shifted by the length delta of the earlier one.
 *   3. Otherwise     : abort with a 409-shaped error carrying the current
 *                      version so the client can rebase and retry.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('ConflictResolver');

class ConflictError extends Error {
  /**
   * @param {object} details
   * @param {number} details.txId
   * @param {number} details.pageId
   * @param {number} details.expectedVersion
   * @param {number} details.actualVersion
   */
  constructor({ txId, pageId, expectedVersion, actualVersion }) {
    super(
      `Version conflict on page ${pageId}: transaction ${txId} expected version ` +
      `${expectedVersion} but the page is at version ${actualVersion}`
    );
    this.name = 'ConflictError';
    this.code = 'VERSION_CONFLICT';
    this.txId = txId;
    this.pageId = pageId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Computes the character range an operation affects.
 *
 * An insert occupies a single point before application, so its range is
 * [position, position). A delete covers the characters it removes.
 *
 * @param {{type:'insert'|'delete', position:number, content?:string, length?:number}} op
 * @returns {{start:number, end:number, delta:number}}
 */
function operationRange(op) {
  const start = Math.max(0, op.position || 0);
  if (op.type === 'insert') {
    const length = (op.content || '').length;
    return { start, end: start, delta: length };
  }
  if (op.type === 'delete') {
    const length = Math.max(0, op.length || 0);
    return { start, end: start + length, delta: -length };
  }
  return { start, end: start, delta: 0 };
}

class ConflictResolver {
  constructor() {
    this.stats = { checks: 0, conflicts: 0, merges: 0 };
  }

  /**
   * Throws when the page moved on since the client read it.
   *
   * @param {object} details
   * @param {number} details.txId
   * @param {number} details.pageId
   * @param {number} details.expectedVersion
   * @param {number} details.actualVersion
   * @throws {ConflictError}
   */
  assertNoConflict({ txId, pageId, expectedVersion, actualVersion }) {
    this.stats.checks += 1;
    if (expectedVersion === actualVersion) return;

    this.stats.conflicts += 1;
    log.info('Version conflict rejected a write', { txId, pageId, expectedVersion, actualVersion });
    throw new ConflictError({ txId, pageId, expectedVersion, actualVersion });
  }

  /**
   * @param {object} opA
   * @param {object} opB
   * @returns {boolean} True when the two operations touch the same characters.
   */
  overlaps(opA, opB) {
    const a = operationRange(opA);
    const b = operationRange(opB);

    // Two inserts collide only when they target the exact same offset, where
    // the resulting order would otherwise be arbitrary.
    if (opA.type === 'insert' && opB.type === 'insert') return a.start === b.start;

    // An insert strictly inside the span a delete removes is ambiguous: the
    // inserted text would land in characters that are disappearing.
    if (opA.type === 'insert') return a.start > b.start && a.start < b.end;
    if (opB.type === 'insert') return b.start > a.start && b.start < a.end;

    return a.start < b.end && b.start < a.end;
  }

  /**
   * Applies a single operation to a string.
   *
   * @param {string} text
   * @param {{type:string, position:number, content?:string, length?:number}} op
   * @returns {string}
   */
  static applyOperation(text, op) {
    const base = text || '';
    if (!op || !op.type) return base;

    if (op.type === 'insert') {
      const position = Math.max(0, Math.min(op.position || 0, base.length));
      return base.slice(0, position) + (op.content || '') + base.slice(position);
    }
    if (op.type === 'delete') {
      const position = Math.max(0, Math.min(op.position || 0, base.length));
      const length = Math.max(0, op.length || 0);
      return base.slice(0, position) + base.slice(position + length);
    }
    return base;
  }

  /**
   * Attempts to apply a second operation on top of a first one.
   *
   * When the ranges are disjoint the later operation is shifted by the length
   * delta the earlier one introduced ahead of it, and both survive. When they
   * overlap the merge is refused and the caller aborts the transaction.
   *
   * @param {string} baseText - Text both operations were computed against.
   * @param {object} committedOp - The operation that already won.
   * @param {object} incomingOp - The operation being merged in.
   * @returns {{merged:boolean, text?:string, shiftedOp?:object, reason?:string}}
   */
  merge(baseText, committedOp, incomingOp) {
    if (this.overlaps(committedOp, incomingOp)) {
      return { merged: false, reason: 'operations affect overlapping character ranges' };
    }

    const committed = operationRange(committedOp);
    const incoming = operationRange(incomingOp);
    const shift = incoming.start >= committed.end ? committed.delta : 0;
    const shiftedOp = { ...incomingOp, position: Math.max(0, incoming.start + shift) };

    const afterFirst = ConflictResolver.applyOperation(baseText, committedOp);
    const text = ConflictResolver.applyOperation(afterFirst, shiftedOp);

    this.stats.merges += 1;
    return { merged: true, text, shiftedOp };
  }

  /** @returns {object} Check, conflict and merge counters. */
  getStats() {
    return { ...this.stats };
  }
}

module.exports = { ConflictResolver, ConflictError, operationRange };
