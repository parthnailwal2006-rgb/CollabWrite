/**
 * CollabWrite - Admin and Observability Controller
 *
 * Exposes the engine's internal state for the evaluation demo: the lock
 * table, scheduler metrics, buffer-pool hit ratio, deadlock history and the
 * recovery report.
 *
 * rules.md section 12 forbids exposing engine internals to unauthenticated
 * users, so every route here is behind both authentication and the admin
 * role. The raw WAL is never served; only aggregate counts derived from it.
 */

'use strict';

const { HttpError } = require('../middleware/auth');

/**
 * Middleware restricting a route to users with the admin role.
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {Function} next
 */
function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') {
    next(new HttpError(403, 'Administrator role required', 'FORBIDDEN'));
    return;
  }
  next();
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {import('../../engine/Engine').Engine} deps.engine
 */
function createAdminController({ store, engine }) {
  return {
    /** GET /api/admin/stats */
    async stats(_req, res) {
      res.json({ stats: engine.getStats() });
    },

    /** GET /api/admin/locks */
    async locks(_req, res) {
      res.json({
        lockTable: engine.lockManager.snapshot(),
        waitForGraph: engine.lockManager.getWaitForEdges(),
        deadlocks: engine.deadlockDetector.getStats()
      });
    },

    /** GET /api/admin/scheduler */
    async scheduler(_req, res) {
      res.json({ scheduler: engine.scheduler.getMetrics() });
    },

    /** POST /api/admin/scheduler/policy */
    async setPolicy(req, res) {
      const policy = String((req.body && req.body.policy) || '').toUpperCase();
      try {
        engine.scheduler.setPolicy(policy);
      } catch (error) {
        throw new HttpError(400, error.message, 'INVALID_POLICY');
      }
      res.json({ policy: engine.scheduler.policy });
    },

    /** GET /api/admin/audit */
    async audit(req, res) {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      res.json({ audit: await store.listAudit({ limit }) });
    },

    /** POST /api/admin/checkpoint */
    async checkpoint(_req, res) {
      res.json({ lsn: engine.recoveryManager.checkpoint() });
    }
  };
}

module.exports = { createAdminController, requireAdmin };
