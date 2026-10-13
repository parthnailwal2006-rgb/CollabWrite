/**
 * CollabWrite - PostgreSQL Support Store
 *
 * THE POSTGRESQL BOUNDARY (rules.md section 8, architecture.md section 7)
 *   PostgreSQL holds support data only:
 *     - user accounts and authentication metadata
 *     - document metadata (title, owner) and the permission table
 *     - administrative audit logs
 *
 *   It holds no document content, no versions, no locks and no index. Those
 *   belong to the Academic Engine, which implements them over its own files.
 *   Nothing in this file may be presented as the project's transaction
 *   manager, lock manager or index: it is a credential and metadata store,
 *   and every query below is a plain CRUD statement for exactly that purpose.
 */

'use strict';

const { Pool } = require('pg');

const { ROLES } = require('./InMemoryStore');
const { createLogger } = require('../../config/logger');

const log = createLogger('PostgresStore');

class PostgresStore {
  /**
   * @param {object} [config] - Overrides for the DB_* environment variables.
   */
  constructor(config = {}) {
    this.config = {
      host: config.host || process.env.DB_HOST || 'localhost',
      port: Number(config.port || process.env.DB_PORT || 5432),
      database: config.database || process.env.DB_NAME || 'collabwrite',
      user: config.user || process.env.DB_USER || 'collabuser',
      password: config.password || process.env.DB_PASSWORD || 'collabpassword',
      min: Number(config.min || process.env.DB_POOL_MIN || 2),
      max: Number(config.max || process.env.DB_POOL_MAX || 20),
      ssl: (config.ssl ?? process.env.DB_SSL) === 'true' ? { rejectUnauthorized: false } : false
    };
    this.pool = null;
  }

  /** Opens the connection pool and verifies connectivity. */
  async init() {
    if (this.pool) return this;
    this.pool = new Pool(this.config);
    this.pool.on('error', (error) => log.error('Idle client error', { message: error.message }));
    await this.pool.query('SELECT 1');
    log.info('PostgreSQL connected', { host: this.config.host, database: this.config.database });
    return this;
  }

  async close() {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }

  /**
   * @param {string} text
   * @param {Array<any>} [params]
   * @returns {Promise<import('pg').QueryResult>}
   */
  async query(text, params = []) {
    if (!this.pool) throw new Error('PostgresStore is not initialised; call init() first');
    return this.pool.query(text, params);
  }

  // ------------------------------------------------------------------ users

  async createUser({ username, email, passwordHash, role = 'user' }) {
    try {
      const { rows } = await this.query(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, email, role, created_at`,
        [username, email, passwordHash, role]
      );
      return PostgresStore.mapUser({ ...rows[0], password_hash: passwordHash });
    } catch (error) {
      if (error.code === '23505') {
        const conflict = new Error(`Username or email is already taken`);
        conflict.code = 'USERNAME_TAKEN';
        throw conflict;
      }
      throw error;
    }
  }

  async findUserByUsername(username) {
    const { rows } = await this.query(
      `SELECT id, username, email, password_hash, role, created_at
       FROM users WHERE username = $1 AND is_active = TRUE`,
      [username]
    );
    return rows[0] ? PostgresStore.mapUser(rows[0]) : null;
  }

  async findUserById(id) {
    const { rows } = await this.query(
      `SELECT id, username, email, password_hash, role, created_at
       FROM users WHERE id = $1 AND is_active = TRUE`,
      [id]
    );
    return rows[0] ? PostgresStore.mapUser(rows[0]) : null;
  }

  // -------------------------------------------------------------- documents

  async createDocument({ title, ownerId }) {
    const { rows } = await this.query(
      `INSERT INTO documents (title, owner_id)
       VALUES ($1, $2)
       RETURNING id, title, owner_id, created_at, updated_at, is_deleted`,
      [title, ownerId]
    );
    const document = PostgresStore.mapDocument(rows[0]);
    await this.setPermission(document.id, ownerId, ROLES.OWNER);
    return document;
  }

  async findDocumentById(id) {
    const { rows } = await this.query(
      `SELECT id, title, owner_id, created_at, updated_at, is_deleted
       FROM documents WHERE id = $1 AND is_deleted = FALSE`,
      [id]
    );
    return rows[0] ? PostgresStore.mapDocument(rows[0]) : null;
  }

  async listDocumentsForUser(userId) {
    const { rows } = await this.query(
      `SELECT d.id, d.title, d.owner_id, d.created_at, d.updated_at, d.is_deleted, p.role
       FROM documents d
       JOIN document_permissions p ON p.document_id = d.id
       WHERE p.user_id = $1 AND d.is_deleted = FALSE
       ORDER BY d.updated_at DESC`,
      [userId]
    );
    return rows.map((row) => ({ ...PostgresStore.mapDocument(row), role: row.role }));
  }

  async renameDocument(id, title) {
    const { rows } = await this.query(
      `UPDATE documents SET title = $2, updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING id, title, owner_id, created_at, updated_at, is_deleted`,
      [id, title]
    );
    return rows[0] ? PostgresStore.mapDocument(rows[0]) : null;
  }

  async softDeleteDocument(id) {
    const { rowCount } = await this.query(
      `UPDATE documents SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    return rowCount > 0;
  }

  async touchDocument(id) {
    await this.query(`UPDATE documents SET updated_at = NOW() WHERE id = $1`, [id]);
  }

  // ------------------------------------------------------------ permissions

  async setPermission(documentId, userId, role) {
    const { rows } = await this.query(
      `INSERT INTO document_permissions (document_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING document_id, user_id, role`,
      [documentId, userId, role]
    );
    return { documentId: rows[0].document_id, userId: rows[0].user_id, role: rows[0].role };
  }

  async getPermission(documentId, userId) {
    const { rows } = await this.query(
      `SELECT role FROM document_permissions WHERE document_id = $1 AND user_id = $2`,
      [documentId, userId]
    );
    return rows[0] ? rows[0].role : null;
  }

  async listPermissions(documentId) {
    const { rows } = await this.query(
      `SELECT document_id, user_id, role FROM document_permissions WHERE document_id = $1`,
      [documentId]
    );
    return rows.map((row) => ({ documentId: row.document_id, userId: row.user_id, role: row.role }));
  }

  async revokePermission(documentId, userId) {
    const { rowCount } = await this.query(
      `DELETE FROM document_permissions WHERE document_id = $1 AND user_id = $2`,
      [documentId, userId]
    );
    return rowCount > 0;
  }

  // ------------------------------------------------------------- audit logs

  async recordAudit({ userId, documentId, action, details = {} }) {
    const { rows } = await this.query(
      `INSERT INTO audit_logs (user_id, document_id, action, details)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, document_id, action, details, timestamp`,
      [userId, documentId, action, JSON.stringify(details)]
    );
    return rows[0];
  }

  async listAudit({ limit = 100 } = {}) {
    const { rows } = await this.query(
      `SELECT id, user_id, document_id, action, details, timestamp
       FROM audit_logs ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  // ---------------------------------------------------------------- mappers

  static mapUser(row) {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: row.created_at
    };
  }

  static mapDocument(row) {
    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isDeleted: row.is_deleted
    };
  }
}

module.exports = { PostgresStore };
