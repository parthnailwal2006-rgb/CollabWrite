/**
 * CollabWrite - Authentication Controller (Phase 2)
 *
 * Registration and login against the PostgreSQL support store. Passwords are
 * stored only as bcrypt hashes, as rules.md section 12 requires; the plaintext
 * never leaves this function and is never logged.
 *
 * This is the one part of the system where PostgreSQL does real work, and it
 * is labelled PostgreSQL support rather than presented as an academic module.
 */

'use strict';

const bcrypt = require('bcrypt');

const { HttpError, signToken } = require('../middleware/auth');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,50}$/;

/**
 * @param {object} deps
 * @param {object} deps.store
 * @returns {{register:Function, login:Function, profile:Function}}
 */
function createAuthController({ store }) {
  return {
    /** POST /api/auth/register */
    async register(req, res) {
      const { username, email, password } = req.body || {};

      if (!USERNAME_PATTERN.test(String(username || ''))) {
        throw new HttpError(400, 'Username must be 3-50 characters of letters, digits, dot, dash or underscore', 'INVALID_USERNAME');
      }
      if (!email || !String(email).includes('@')) {
        throw new HttpError(400, 'A valid email address is required', 'INVALID_EMAIL');
      }
      if (!password || String(password).length < 8) {
        throw new HttpError(400, 'Password must be at least 8 characters', 'WEAK_PASSWORD');
      }

      const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
      let user;
      try {
        user = await store.createUser({ username, email, passwordHash });
      } catch (error) {
        if (error.code === 'USERNAME_TAKEN') {
          throw new HttpError(409, error.message, 'USERNAME_TAKEN');
        }
        throw error;
      }

      await store.recordAudit({ userId: user.id, documentId: null, action: 'user.register' });
      res.status(201).json({
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
        token: signToken(user)
      });
    },

    /** POST /api/auth/login */
    async login(req, res) {
      const { username, password } = req.body || {};
      const user = await store.findUserByUsername(String(username || ''));

      // Compare against a dummy hash when the user is unknown so that the
      // response time does not reveal which usernames exist.
      const hash = user ? user.passwordHash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
      const matches = await bcrypt.compare(String(password || ''), hash);

      if (!user || !matches) {
        throw new HttpError(401, 'Invalid username or password', 'INVALID_CREDENTIALS');
      }

      await store.recordAudit({ userId: user.id, documentId: null, action: 'user.login' });
      res.json({
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
        token: signToken(user)
      });
    },

    /** GET /api/auth/me */
    async profile(req, res) {
      const user = await store.findUserById(req.user.id);
      if (!user) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
      res.json({ user: { id: user.id, username: user.username, email: user.email, role: user.role } });
    }
  };
}

module.exports = { createAuthController };
