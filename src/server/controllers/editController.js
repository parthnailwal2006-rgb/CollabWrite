/**
 * CollabWrite - Edit and Search Controllers (Phases 7, 9 and 10)
 *
 * The edit endpoint is the narrow waist of the whole system: it validates the
 * operation, then hands it to the scheduler and waits for the transaction to
 * finish. Everything interesting - queueing, locking, version checking,
 * logging, broadcasting - happens inside the engine, which is exactly the
 * separation architecture.md section 1 asks for.
 */

'use strict';

const { HttpError } = require('../middleware/auth');

const MAX_INSERT_LENGTH = 64 * 1024;

/**
 * Validates an edit operation from an untrusted client.
 *
 * @param {any} operation
 * @returns {{type:'insert'|'delete', position:number, content?:string, length?:number}}
 * @throws {HttpError}
 */
function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') {
    throw new HttpError(400, 'An operation object is required', 'INVALID_OPERATION');
  }

  const position = Number(operation.position);
  if (!Number.isInteger(position) || position < 0) {
    throw new HttpError(400, 'operation.position must be a non-negative integer', 'INVALID_OPERATION');
  }

  if (operation.type === 'insert') {
    const content = String(operation.content ?? '');
    if (content.length === 0) {
      throw new HttpError(400, 'An insert needs non-empty content', 'INVALID_OPERATION');
    }
    if (content.length > MAX_INSERT_LENGTH) {
      throw new HttpError(413, `Insert exceeds the ${MAX_INSERT_LENGTH} character limit`, 'OPERATION_TOO_LARGE');
    }
    return { type: 'insert', position, content };
  }

  if (operation.type === 'delete') {
    const length = Number(operation.length);
    if (!Number.isInteger(length) || length <= 0) {
      throw new HttpError(400, 'A delete needs a positive integer length', 'INVALID_OPERATION');
    }
    return { type: 'delete', position, length };
  }

  throw new HttpError(400, "operation.type must be 'insert' or 'delete'", 'INVALID_OPERATION');
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {import('../../engine/Engine').Engine} deps.engine
 */
function createEditController({ store, engine }) {
  return {
    /** POST /api/documents/:id/edit */
    async edit(req, res) {
      const operation = validateOperation(req.body && req.body.operation);
      const rawVersion = req.body && req.body.baseVersion;
      const baseVersion = rawVersion === undefined || rawVersion === null
        ? undefined
        : Number(rawVersion);

      if (baseVersion !== undefined && !Number.isInteger(baseVersion)) {
        throw new HttpError(400, 'baseVersion must be an integer', 'INVALID_VERSION');
      }

      const result = await engine.submitEdit({
        docId: req.document.id,
        operation,
        baseVersion,
        userId: req.user.id,
        username: req.user.username
      });

      await store.touchDocument(req.document.id);
      res.json({
        docId: result.docId,
        version: result.version,
        text: result.text,
        transaction: result.transaction
      });
    },

    /** GET /api/search?q=&index=false */
    async search(req, res) {
      const keyword = String((req.query && req.query.q) || '').trim();
      if (!keyword) throw new HttpError(400, 'Query parameter q is required', 'MISSING_QUERY');

      const useIndex = req.query.index !== 'false';
      const result = await engine.search(keyword, { useIndex });

      // Filter to documents the caller may actually see. Doing this after the
      // engine lookup keeps the index free of permission state, which would
      // otherwise have to be re-indexed on every share.
      const accessible = await store.listDocumentsForUser(req.user.id);
      const allowed = new Set(accessible.map((doc) => doc.id));
      const documents = accessible.filter((doc) => result.docIds.includes(doc.id));

      res.json({
        keyword: result.keyword,
        usedIndex: result.usedIndex,
        latencyMs: result.latencyMs,
        matched: result.docIds.filter((id) => allowed.has(id)),
        documents
      });
    },

    /** GET /api/search/benchmark?q= */
    async benchmark(req, res) {
      const keyword = String((req.query && req.query.q) || '').trim();
      if (!keyword) throw new HttpError(400, 'Query parameter q is required', 'MISSING_QUERY');

      const iterations = Math.min(500, Math.max(1, Number(req.query.iterations) || 50));
      res.json({ benchmark: await engine.benchmarkSearch(keyword, iterations) });
    }
  };
}

module.exports = { createEditController, validateOperation };
