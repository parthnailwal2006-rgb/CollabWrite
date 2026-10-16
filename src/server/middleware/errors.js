/**
 * CollabWrite - Error Translation Middleware
 *
 * Maps engine errors onto the HTTP contract in design.md section 14:
 *
 *   DocumentNotFound        -> 404 DOCUMENT_NOT_FOUND
 *   Permission failure      -> 403 FORBIDDEN
 *   ConflictError           -> 409 VERSION_CONFLICT  (client should rebase)
 *   Deadlock victim abort   -> 409 DEADLOCK          (client should retry)
 *   LockTimeoutError        -> 503 LOCK_TIMEOUT      (engine is saturated)
 *   anything else           -> 500 INTERNAL_ERROR
 *
 * A conflict response carries the current version so the client can rebase
 * without an extra round trip, which is what makes abort-and-retry usable in
 * place of operational transformation.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('HTTP');

const ERROR_MAP = {
  HttpError: null, // carries its own status
  DocumentNotFound: { status: 404, code: 'DOCUMENT_NOT_FOUND' },
  DocumentNotFoundError: { status: 404, code: 'DOCUMENT_NOT_FOUND' },
  ConflictError: { status: 409, code: 'VERSION_CONFLICT' },
  LockTimeoutError: { status: 503, code: 'LOCK_TIMEOUT' },
  LockAbortedError: { status: 409, code: 'DEADLOCK' },
  TransactionAbortedError: { status: 409, code: 'TRANSACTION_ABORTED' },
  QueueFullError: { status: 503, code: 'QUEUE_FULL' },
  BufferPoolFullError: { status: 503, code: 'ENGINE_SATURATED' },
  PageCorruptionError: { status: 500, code: 'STORAGE_CORRUPTION' }
};

/** 404 handler for unmatched routes. */
function notFound(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` }
  });
}

/**
 * Central error handler.
 * @param {Error} error
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} _next
 */
/* eslint-disable-next-line no-unused-vars */
function errorHandler(error, req, res, _next) {
  const mapped = ERROR_MAP[error.name];
  const status = error.status || (mapped ? mapped.status : 500);
  const code = error.code || (mapped ? mapped.code : 'INTERNAL_ERROR');

  const body = {
    error: {
      code,
      message: status === 500 ? 'An internal engine error occurred' : error.message
    }
  };

  // A version conflict is actionable: tell the client what to rebase onto.
  if (code === 'VERSION_CONFLICT') {
    body.error.expectedVersion = error.expectedVersion;
    body.error.currentVersion = error.actualVersion;
    body.error.retryable = true;
  }
  if (code === 'DEADLOCK' || code === 'TRANSACTION_ABORTED' || code === 'LOCK_TIMEOUT') {
    body.error.retryable = true;
  }

  if (status >= 500) {
    log.error('Request failed', { method: req.method, url: req.originalUrl, message: error.message, stack: error.stack });
  } else {
    log.debug('Request rejected', { method: req.method, url: req.originalUrl, code, message: error.message });
  }

  res.status(status).json(body);
}

/**
 * Wraps an async controller so a rejected promise reaches errorHandler.
 * @param {Function} handler
 * @returns {Function}
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { notFound, errorHandler, asyncHandler };
