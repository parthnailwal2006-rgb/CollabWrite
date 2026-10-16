/**
 * CollabWrite - In-Memory Support Store
 *
 * Implements the same interface as PostgresStore for users, document
 * metadata, permissions and audit logs. It exists so the API layer can be
 * tested, and the engine demonstrated, without a running PostgreSQL.
 *
 * This is support data only. Document content, versions, locking, indexing
 * and recovery are owned by the engine either way, so swapping this store for
 * PostgreSQL changes nothing about the academic mechanisms - which is the
 * point architecture.md section 7 makes about the PostgreSQL boundary.
 */

'use strict';

const ROLES = { OWNER: 'owner', EDITOR: 'editor', VIEWER: 'viewer' };

class InMemoryStore {
  constructor() {
    this.users = new Map();
    this.usersByUsername = new Map();
    this.documents = new Map();
    /** @type {Map<string, {documentId:number, userId:number, role:string}>} */
    this.permissions = new Map();
    this.auditLogs = [];
    this.nextUserId = 1;
    this.nextDocumentId = 1;
  }

  async init() {
    if (process.env.NODE_ENV !== 'test' && this.users.size === 0) {
      // Default bcrypt hash for 'password123'
      const hash = '$2b$10$wAjp5sJ9UEIk2yxivko9O.3.lBxW/TfDSe3RHRYy3USUjcpbhXJpW';
      await this.createUser({ username: 'ananya', email: 'ananya@collabwrite.dev', passwordHash: hash, role: 'admin' });
      await this.createUser({ username: 'rahul', email: 'rahul@collabwrite.dev', passwordHash: hash, role: 'user' });
      await this.createUser({ username: 'priya', email: 'priya@collabwrite.dev', passwordHash: hash, role: 'user' });
    }
    return this;
  }

  async close() {
    return undefined;
  }

  // ------------------------------------------------------------------ users

  /**
   * @param {{username:string, email:string, passwordHash:string, role?:string}} user
   * @returns {Promise<object>}
   */
  async createUser({ username, email, passwordHash, role = 'user' }) {
    if (this.usersByUsername.has(username)) {
      const error = new Error(`Username ${username} is already taken`);
      error.code = 'USERNAME_TAKEN';
      throw error;
    }
    const user = {
      id: this.nextUserId,
      username,
      email,
      passwordHash,
      role,
      createdAt: new Date().toISOString()
    };
    this.nextUserId += 1;
    this.users.set(user.id, user);
    this.usersByUsername.set(username, user);
    return { ...user };
  }

  async findUserByUsername(username) {
    const user = this.usersByUsername.get(username);
    return user ? { ...user } : null;
  }

  async findUserById(id) {
    const user = this.users.get(Number(id));
    return user ? { ...user } : null;
  }

  // -------------------------------------------------------------- documents

  /**
   * @param {{title:string, ownerId:number}} document
   * @returns {Promise<object>}
   */
  async createDocument({ title, ownerId }) {
    const document = {
      id: this.nextDocumentId,
      title,
      ownerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isDeleted: false
    };
    this.nextDocumentId += 1;
    this.documents.set(document.id, document);
    await this.setPermission(document.id, ownerId, ROLES.OWNER);
    return { ...document };
  }

  async findDocumentById(id) {
    const document = this.documents.get(Number(id));
    return document && !document.isDeleted ? { ...document } : null;
  }

  /**
   * @param {number} userId
   * @returns {Promise<object[]>} Documents the user owns or may access.
   */
  async listDocumentsForUser(userId) {
    const accessible = [];
    for (const document of this.documents.values()) {
      if (document.isDeleted) continue;
      const role = await this.getPermission(document.id, userId);
      if (role) accessible.push({ ...document, role });
    }
    return accessible.sort((a, b) => a.id - b.id);
  }

  async renameDocument(id, title) {
    const document = this.documents.get(Number(id));
    if (!document) return null;
    document.title = title;
    document.updatedAt = new Date().toISOString();
    return { ...document };
  }

  async softDeleteDocument(id) {
    const document = this.documents.get(Number(id));
    if (!document) return false;
    document.isDeleted = true;
    return true;
  }

  async touchDocument(id) {
    const document = this.documents.get(Number(id));
    if (document) document.updatedAt = new Date().toISOString();
  }

  // ------------------------------------------------------------ permissions

  static permissionKey(documentId, userId) {
    return `${documentId}:${userId}`;
  }

  async setPermission(documentId, userId, role) {
    const key = InMemoryStore.permissionKey(documentId, userId);
    this.permissions.set(key, { documentId: Number(documentId), userId: Number(userId), role });
    return { documentId: Number(documentId), userId: Number(userId), role };
  }

  /**
   * @param {number} documentId
   * @param {number} userId
   * @returns {Promise<string|null>} The role, or null when there is no access.
   */
  async getPermission(documentId, userId) {
    const entry = this.permissions.get(InMemoryStore.permissionKey(documentId, userId));
    return entry ? entry.role : null;
  }

  async listPermissions(documentId) {
    return [...this.permissions.values()].filter((p) => p.documentId === Number(documentId));
  }

  async revokePermission(documentId, userId) {
    return this.permissions.delete(InMemoryStore.permissionKey(documentId, userId));
  }

  // ------------------------------------------------------------- audit logs

  /**
   * @param {{userId:number|null, documentId:number|null, action:string, details?:object}} entry
   */
  async recordAudit({ userId, documentId, action, details = {} }) {
    const record = {
      id: this.auditLogs.length + 1,
      userId,
      documentId,
      action,
      details,
      timestamp: new Date().toISOString()
    };
    this.auditLogs.push(record);
    return record;
  }

  async listAudit({ limit = 100 } = {}) {
    return this.auditLogs.slice(-limit).reverse();
  }
}

module.exports = { InMemoryStore, ROLES };
