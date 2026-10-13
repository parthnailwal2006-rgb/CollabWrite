/**
 * CollabWrite - Authentication and Authorisation Middleware
 *
 * rules.md section 12 requires a validated JWT on every request and role
 * enforcement before any engine call. Both checks run here so that no
 * controller can forget them.
 *
 * The permission check deliberately happens before the request reaches the
 * scheduler: an unauthorised edit should never occupy a worker or take a lock.
 */

'use strict';

const jwt = require('jsonwebtoken');

const { ROLES } = require('../stores/InMemoryStore');

/** Roles that may modify a document. */
const WRITE_ROLES = new Set([ROLES.OWNER, ROLES.EDITOR]);

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [code]
   */
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** @returns {string} The configured JWT signing secret. */
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return secret;
}

/**
 * Issues an access token.
 * @param {{id:number, username:string, role:string}} user
 * @returns {string}
 */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    jwtSecret(),
    { expiresIn: process.env.JWT_EXPIRATION || '15m' }
  );
}

/**
 * Verifies a bearer token.
 * @param {string} token
 * @returns {{sub:number, username:string, role:string}}
 */
function verifyToken(token) {
  return jwt.verify(token, jwtSecret());
}

/**
 * Express middleware that rejects a request without a valid bearer token.
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {Function} next
 */
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    next(new HttpError(401, 'Missing or malformed Authorization header', 'UNAUTHENTICATED'));
    return;
  }
  try {
    const claims = verifyToken(token);
    req.user = { id: claims.sub, username: claims.username, role: claims.role };
    next();
  } catch (error) {
    next(new HttpError(401, `Invalid token: ${error.message}`, 'UNAUTHENTICATED'));
  }
}

/**
 * Builds middleware that checks the caller's role on the document named by
 * the route parameter.
 *
 * @param {object} deps
 * @param {object} deps.store - The support store.
 * @param {boolean} [deps.write] - Require an editing role rather than read.
 * @param {string} [deps.param] - Route parameter holding the document id.
 * @returns {Function} Express middleware.
 */
function requireDocumentAccess({ store, write = false, param = 'id' }) {
  return async (req, _res, next) => {
    try {
      const documentId = Number(req.params[param] ?? req.body.docId);
      if (!Number.isInteger(documentId)) {
        throw new HttpError(400, 'A numeric document id is required', 'INVALID_DOCUMENT_ID');
      }

      const document = await store.findDocumentById(documentId);
      if (!document) throw new HttpError(404, `Document ${documentId} not found`, 'DOCUMENT_NOT_FOUND');

      const role = await store.getPermission(documentId, req.user.id);
      if (!role) throw new HttpError(403, 'You do not have access to this document', 'FORBIDDEN');
      if (write && !WRITE_ROLES.has(role)) {
        throw new HttpError(403, `Role '${role}' may not modify this document`, 'FORBIDDEN');
      }

      req.document = document;
      req.documentRole = role;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Restricts a route to document owners, used for sharing and deletion.
 * @returns {Function}
 */
function requireOwner() {
  return (req, _res, next) => {
    if (req.documentRole !== ROLES.OWNER) {
      next(new HttpError(403, 'Only the document owner may perform this action', 'FORBIDDEN'));
      return;
    }
    next();
  };
}

module.exports = {
  HttpError,
  signToken,
  verifyToken,
  requireAuth,
  requireDocumentAccess,
  requireOwner,
  WRITE_ROLES
};
