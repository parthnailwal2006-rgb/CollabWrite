/**
 * Phase 8 - Real-time collaboration integration test.
 *
 * phases.md milestone 8 is "a real-time edit from one browser appears
 * instantly in another". This test is that milestone, with two authenticated
 * Socket.IO clients standing in for the browsers. It is the only place the
 * whole path is exercised at once: socket -> scheduler -> transaction ->
 * message queue -> collaboration manager -> socket.
 */

'use strict';

const http = require('http');

const { io: createClient } = require('socket.io-client');
const request = require('supertest');

const { createApp } = require('../../src/server/app');
const { attachSocketServer } = require('../../src/server/realtime/socket');
const { InMemoryStore } = require('../../src/server/stores/InMemoryStore');
const { makeDataDir, startEngine, cleanup } = require('../helpers/engineHarness');

jest.setTimeout(30000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_1234567890';

/** Resolves with the first payload of an event, or rejects on timeout. */
function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${event}'`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('real-time collaboration', () => {
  let dataDir;
  let engine;
  let store;
  let server;
  let io;
  let url;
  const sockets = [];

  /** Opens an authenticated client socket. */
  const connect = async (token) => {
    const socket = createClient(url, { auth: { token }, transports: ['websocket'] });
    sockets.push(socket);
    await once(socket, 'connect');
    return socket;
  };

  beforeAll(async () => {
    dataDir = makeDataDir();
    engine = await startEngine(dataDir);
    store = new InMemoryStore();

    const app = createApp({ store, engine });
    server = http.createServer(app);
    io = attachSocketServer(server, { store, engine });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    while (sockets.length) sockets.pop().close();
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await engine.stop();
    cleanup(dataDir);
  });

  /** Registers a user over HTTP and returns their token and id. */
  const register = async (username) => {
    const response = await request(server)
      .post('/api/auth/register')
      .send({ username, email: `${username}@example.edu`, password: 'correct horse battery' })
      .expect(201);
    return { token: response.body.token, id: response.body.user.id };
  };

  test('refuses a socket without a token', async () => {
    const socket = createClient(url, { transports: ['websocket'] });
    sockets.push(socket);

    const error = await once(socket, 'connect_error');
    expect(error.message).toMatch(/Authentication token is required/);
  });

  test('refuses a socket with a bad token', async () => {
    const socket = createClient(url, { auth: { token: 'nonsense' }, transports: ['websocket'] });
    sockets.push(socket);

    const error = await once(socket, 'connect_error');
    expect(error.message).toMatch(/Invalid token/);
  });

  test('refuses to join a document the user cannot access', async () => {
    const owner = await register('rt_owner_1');
    const stranger = await register('rt_stranger_1');

    const document = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Private' })
      .expect(201);

    const socket = await connect(stranger.token);
    socket.emit('document:join', { docId: document.body.document.id });

    expect(await once(socket, 'edit:error')).toMatchObject({ code: 'FORBIDDEN' });
  });

  test('an edit from one client reaches the other', async () => {
    const owner = await register('rt_owner_2');
    const collaborator = await register('rt_collab_2');

    const created = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Shared' })
      .expect(201);
    const docId = created.body.document.id;

    await request(server)
      .put(`/api/documents/${docId}/permissions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: collaborator.id, role: 'editor' })
      .expect(200);

    const alice = await connect(owner.token);
    alice.emit('document:join', { docId });
    await once(alice, 'document:joined');

    const bob = await connect(collaborator.token);
    bob.emit('document:join', { docId });
    await once(bob, 'document:joined');

    const received = once(bob, 'edit');
    alice.emit('edit', { docId, operation: { type: 'insert', position: 0, content: 'hello from alice' } });

    const event = await received;
    expect(event).toMatchObject({ docId, version: 2, userId: owner.id });
    expect(event.operation).toMatchObject({ type: 'insert', content: 'hello from alice' });
    expect(event.sequence).toBeGreaterThan(0);
  });

  test('edits to one document arrive in commit order', async () => {
    const owner = await register('rt_owner_3');
    const created = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Ordered' })
      .expect(201);
    const docId = created.body.document.id;

    const socket = await connect(owner.token);
    socket.emit('document:join', { docId });
    await once(socket, 'document:joined');

    const versions = [];
    const done = new Promise((resolve) => {
      socket.on('edit', (event) => {
        versions.push(event.version);
        if (versions.length === 4) resolve();
      });
    });

    for (let i = 0; i < 4; i += 1) {
      socket.emit('edit', { docId, operation: { type: 'insert', position: 0, content: `${i}` } });
    }
    await done;

    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(4);
  });

  test('a viewer is refused an edit over the socket', async () => {
    const owner = await register('rt_owner_4');
    const viewer = await register('rt_viewer_4');

    const created = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Read Only' })
      .expect(201);
    const docId = created.body.document.id;

    await request(server)
      .put(`/api/documents/${docId}/permissions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: viewer.id, role: 'viewer' })
      .expect(200);

    const socket = await connect(viewer.token);
    socket.emit('document:join', { docId });
    await once(socket, 'document:joined');

    socket.emit('edit', { docId, operation: { type: 'insert', position: 0, content: 'nope' } });
    expect(await once(socket, 'edit:error')).toMatchObject({ code: 'FORBIDDEN' });
  });

  test('a stale socket edit reports the current version so the client can rebase', async () => {
    const owner = await register('rt_owner_5');
    const created = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Conflicting' })
      .expect(201);
    const docId = created.body.document.id;

    await request(server)
      .post(`/api/documents/${docId}/edit`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ operation: { type: 'insert', position: 0, content: 'first' }, baseVersion: 1 })
      .expect(200);

    const socket = await connect(owner.token);
    socket.emit('document:join', { docId });
    await once(socket, 'document:joined');

    socket.emit('edit', { docId, operation: { type: 'insert', position: 0, content: 'stale' }, baseVersion: 1 });

    expect(await once(socket, 'edit:error')).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 2,
      retryable: true
    });
  });

  test('presence is broadcast when a collaborator joins', async () => {
    const owner = await register('rt_owner_6');
    const collaborator = await register('rt_collab_6');

    const created = await request(server)
      .post('/api/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'Presence' })
      .expect(201);
    const docId = created.body.document.id;

    await request(server)
      .put(`/api/documents/${docId}/permissions`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: collaborator.id, role: 'editor' })
      .expect(200);

    const alice = await connect(owner.token);
    alice.emit('document:join', { docId });
    await once(alice, 'document:joined');

    const presence = once(alice, 'presence');
    const bob = await connect(collaborator.token);
    bob.emit('document:join', { docId });

    const event = await presence;
    expect(event.action).toBe('join');
    expect(event.participants.map((p) => p.username)).toContain('rt_collab_6');
  });
});
