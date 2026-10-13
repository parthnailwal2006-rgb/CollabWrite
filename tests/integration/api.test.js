/**
 * Phase 2 and 12 - HTTP API integration tests.
 *
 * Driven through supertest against the in-memory support store, so the suite
 * runs without PostgreSQL while exercising the same controllers, middleware
 * and engine that production uses.
 */

'use strict';

const request = require('supertest');

const { createApp } = require('../../src/server/app');
const { InMemoryStore } = require('../../src/server/stores/InMemoryStore');
const { makeDataDir, startEngine, cleanup } = require('../helpers/engineHarness');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_1234567890';

describe('HTTP API', () => {
  let dataDir;
  let engine;
  let store;
  let app;

  /** Registers a user and returns their token and id. */
  const register = async (username, role = null) => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ username, email: `${username}@example.edu`, password: 'correct horse battery' })
      .expect(201);

    if (role) {
      // Elevating happens in the store, then a fresh login mints a token
      // carrying the new role.
      const user = await store.findUserByUsername(username);
      user.role = role;
      store.users.get(user.id).role = role;
      store.usersByUsername.get(username).role = role;

      const login = await request(app)
        .post('/api/auth/login')
        .send({ username, password: 'correct horse battery' })
        .expect(200);
      return { token: login.body.token, id: login.body.user.id };
    }
    return { token: response.body.token, id: response.body.user.id };
  };

  const createDocument = async (token, title = 'Test Doc') => {
    const response = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title })
      .expect(201);
    return response.body.document;
  };

  beforeEach(async () => {
    dataDir = makeDataDir();
    engine = await startEngine(dataDir);
    store = new InMemoryStore();
    app = createApp({ store, engine });
  });

  afterEach(async () => {
    await engine.stop();
    cleanup(dataDir);
  });

  describe('health', () => {
    test('reports engine readiness', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body.status).toBe('ok');
    });

    test('404s an unknown route', async () => {
      const response = await request(app).get('/api/nope').expect(404);
      expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    });
  });

  describe('authentication', () => {
    test('registers a user and returns a token', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({ username: 'ada', email: 'ada@example.edu', password: 'analytical engine' })
        .expect(201);

      expect(response.body.user).toMatchObject({ username: 'ada', role: 'user' });
      expect(response.body.token).toEqual(expect.any(String));
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    test('rejects a weak password and a bad username', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ username: 'ada', email: 'ada@example.edu', password: 'short' })
        .expect(400);

      await request(app)
        .post('/api/auth/register')
        .send({ username: 'a', email: 'a@example.edu', password: 'long enough password' })
        .expect(400);
    });

    test('rejects a duplicate username', async () => {
      await register('ada');
      const response = await request(app)
        .post('/api/auth/register')
        .send({ username: 'ada', email: 'other@example.edu', password: 'correct horse battery' })
        .expect(409);
      expect(response.body.error.code).toBe('USERNAME_TAKEN');
    });

    test('logs in and rejects a wrong password identically to an unknown user', async () => {
      await register('ada');

      await request(app).post('/api/auth/login')
        .send({ username: 'ada', password: 'correct horse battery' }).expect(200);

      const wrong = await request(app).post('/api/auth/login')
        .send({ username: 'ada', password: 'wrong' }).expect(401);
      const missing = await request(app).post('/api/auth/login')
        .send({ username: 'nobody', password: 'wrong' }).expect(401);

      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(missing.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    test('requires a bearer token on protected routes', async () => {
      await request(app).get('/api/documents').expect(401);
      await request(app).get('/api/documents').set('Authorization', 'Bearer nonsense').expect(401);
    });
  });

  describe('documents', () => {
    test('creates a document in both the store and the engine', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token, 'Lab Report');

      expect(document).toMatchObject({ title: 'Lab Report', role: 'owner', version: 1, text: '' });
      expect(engine.storage.hasDocument(document.id)).toBe(true);
    });

    test('lists only documents the caller may see', async () => {
      const ada = await register('ada');
      const linus = await register('linus');
      await createDocument(ada.token, 'Ada Doc');

      const response = await request(app).get('/api/documents')
        .set('Authorization', `Bearer ${linus.token}`).expect(200);
      expect(response.body.documents).toEqual([]);
    });

    test('404s a document that does not exist and 403s one without access', async () => {
      const ada = await register('ada');
      const linus = await register('linus');
      const document = await createDocument(ada.token);

      await request(app).get('/api/documents/9999')
        .set('Authorization', `Bearer ${ada.token}`).expect(404);
      await request(app).get(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${linus.token}`).expect(403);
    });

    test('renames and soft-deletes', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token);

      const renamed = await request(app).patch(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${token}`).send({ title: 'Renamed' }).expect(200);
      expect(renamed.body.document.title).toBe('Renamed');

      await request(app).delete(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${token}`).expect(204);
      await request(app).get(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${token}`).expect(404);
    });
  });

  describe('permissions', () => {
    test('an editor may edit and a viewer may not', async () => {
      const ada = await register('ada');
      const editor = await register('editor');
      const viewer = await register('viewer');
      const document = await createDocument(ada.token);

      await request(app).put(`/api/documents/${document.id}/permissions`)
        .set('Authorization', `Bearer ${ada.token}`)
        .send({ userId: editor.id, role: 'editor' }).expect(200);
      await request(app).put(`/api/documents/${document.id}/permissions`)
        .set('Authorization', `Bearer ${ada.token}`)
        .send({ userId: viewer.id, role: 'viewer' }).expect(200);

      await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${editor.token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'editor text' } })
        .expect(200);

      const denied = await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'nope' } })
        .expect(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');

      // The viewer can still read.
      await request(app).get(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${viewer.token}`).expect(200);
    });

    test('only the owner may share or revoke', async () => {
      const ada = await register('ada');
      const editor = await register('editor');
      const document = await createDocument(ada.token);

      await request(app).put(`/api/documents/${document.id}/permissions`)
        .set('Authorization', `Bearer ${ada.token}`)
        .send({ userId: editor.id, role: 'editor' }).expect(200);

      await request(app).put(`/api/documents/${document.id}/permissions`)
        .set('Authorization', `Bearer ${editor.token}`)
        .send({ userId: editor.id, role: 'owner' }).expect(403);

      await request(app).delete(`/api/documents/${document.id}/permissions/${editor.id}`)
        .set('Authorization', `Bearer ${ada.token}`).expect(204);
    });

    test('refuses to revoke the owner', async () => {
      const ada = await register('ada');
      const document = await createDocument(ada.token);

      const response = await request(app)
        .delete(`/api/documents/${document.id}/permissions/${ada.id}`)
        .set('Authorization', `Bearer ${ada.token}`).expect(400);
      expect(response.body.error.code).toBe('CANNOT_REVOKE_OWNER');
    });
  });

  describe('editing', () => {
    test('applies an edit and returns the new version', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token);

      const response = await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'hello' }, baseVersion: 1 })
        .expect(200);

      expect(response.body).toMatchObject({ version: 2, text: 'hello' });
      expect(response.body.transaction.state).toBe('COMMITTED');
    });

    test('returns 409 with the current version on a stale edit', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token);

      await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'first' }, baseVersion: 1 })
        .expect(200);

      const conflict = await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'stale' }, baseVersion: 1 })
        .expect(409);

      expect(conflict.body.error).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 2,
        retryable: true
      });
    });

    test('validates the operation shape', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token);
      const url = `/api/documents/${document.id}/edit`;

      for (const operation of [
        undefined,
        { type: 'format', position: 0 },
        { type: 'insert', position: -1, content: 'x' },
        { type: 'insert', position: 0, content: '' },
        { type: 'delete', position: 0, length: 0 }
      ]) {
        const response = await request(app).post(url)
          .set('Authorization', `Bearer ${token}`).send({ operation });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_OPERATION');
      }
    });

    test('concurrent HTTP edits all commit without a lost update', async () => {
      const { token } = await register('ada');
      const document = await createDocument(token);

      const responses = await Promise.all(['AAA', 'BBB', 'CCC'].map((content) =>
        request(app).post(`/api/documents/${document.id}/edit`)
          .set('Authorization', `Bearer ${token}`)
          .send({ operation: { type: 'insert', position: 0, content } })));

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      const read = await request(app).get(`/api/documents/${document.id}`)
        .set('Authorization', `Bearer ${token}`).expect(200);
      expect(read.body.document.text).toHaveLength(9);
    });
  });

  describe('search', () => {
    test('finds a document by keyword and hides inaccessible ones', async () => {
      const ada = await register('ada');
      const linus = await register('linus');
      const document = await createDocument(ada.token);

      await request(app).post(`/api/documents/${document.id}/edit`)
        .set('Authorization', `Bearer ${ada.token}`)
        .send({ operation: { type: 'insert', position: 0, content: 'deadlock detection explained' } })
        .expect(200);

      const found = await request(app).get('/api/search?q=deadlock')
        .set('Authorization', `Bearer ${ada.token}`).expect(200);
      expect(found.body.matched).toEqual([document.id]);

      const hidden = await request(app).get('/api/search?q=deadlock')
        .set('Authorization', `Bearer ${linus.token}`).expect(200);
      expect(hidden.body.matched).toEqual([]);
    });

    test('requires a query parameter', async () => {
      const { token } = await register('ada');
      await request(app).get('/api/search').set('Authorization', `Bearer ${token}`).expect(400);
    });
  });

  describe('admin', () => {
    test('refuses a non-admin and serves engine stats to an admin', async () => {
      const user = await register('plain');
      const admin = await register('root', 'admin');

      await request(app).get('/api/admin/stats')
        .set('Authorization', `Bearer ${user.token}`).expect(403);

      const response = await request(app).get('/api/admin/stats')
        .set('Authorization', `Bearer ${admin.token}`).expect(200);
      expect(response.body.stats).toHaveProperty('bufferPool');
      expect(response.body.stats).toHaveProperty('lockTable');
      expect(response.body.stats).toHaveProperty('scheduler');
    });

    test('switches the scheduling policy', async () => {
      const admin = await register('root', 'admin');

      const response = await request(app).post('/api/admin/scheduler/policy')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ policy: 'ROUND_ROBIN' }).expect(200);
      expect(response.body.policy).toBe('ROUND_ROBIN');

      await request(app).post('/api/admin/scheduler/policy')
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ policy: 'SJF' }).expect(400);
    });

    test('records an audit trail', async () => {
      const admin = await register('root', 'admin');
      await createDocument(admin.token, 'Audited');

      const response = await request(app).get('/api/admin/audit')
        .set('Authorization', `Bearer ${admin.token}`).expect(200);
      expect(response.body.audit.map((row) => row.action)).toContain('document.create');
    });
  });
});
