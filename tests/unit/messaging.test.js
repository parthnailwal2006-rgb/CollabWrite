/**
 * Phase 8 - Message Queue and Collaboration Manager tests.
 *
 * The guarantee under test is FIFO ordering per document, plus the presence
 * bookkeeping the editor relies on.
 */

'use strict';

const { MessageQueue, QueueFullError } = require('../../src/engine/messaging/MessageQueue');
const { CollaborationManager } = require('../../src/engine/messaging/CollaborationManager');

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MessageQueue', () => {
  test('numbers events per document, independently', () => {
    const queue = new MessageQueue();

    expect(queue.publish({ docId: 1, type: 'edit' }).sequence).toBe(1);
    expect(queue.publish({ docId: 1, type: 'edit' }).sequence).toBe(2);
    expect(queue.publish({ docId: 2, type: 'edit' }).sequence).toBe(1);
  });

  test('delivers in publication order', async () => {
    const queue = new MessageQueue();
    const seen = [];
    queue.subscribe((event) => seen.push(event.payload.n));

    for (let n = 1; n <= 5; n += 1) queue.publish({ docId: 1, type: 'edit', payload: { n } });
    await flush();

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test('delivers every event to every consumer', async () => {
    const queue = new MessageQueue();
    const a = [];
    const b = [];
    queue.subscribe((e) => a.push(e.sequence));
    queue.subscribe((e) => b.push(e.sequence));

    queue.publish({ docId: 1, type: 'edit' });
    queue.publish({ docId: 1, type: 'edit' });
    await flush();

    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  test('unsubscribing stops delivery', async () => {
    const queue = new MessageQueue();
    const seen = [];
    const unsubscribe = queue.subscribe((e) => seen.push(e.sequence));

    queue.publish({ docId: 1, type: 'edit' });
    await flush();
    unsubscribe();
    queue.publish({ docId: 1, type: 'edit' });
    await flush();

    expect(seen).toEqual([1]);
  });

  test('one failing consumer does not stop the others', async () => {
    const queue = new MessageQueue();
    const seen = [];
    queue.subscribe(() => { throw new Error('consumer blew up'); });
    queue.subscribe((e) => seen.push(e.sequence));

    queue.publish({ docId: 1, type: 'edit' });
    await flush();

    expect(seen).toEqual([1]);
  });

  test('rejects a publish once capacity is reached', () => {
    const queue = new MessageQueue({ capacity: 2 });
    queue.publish({ docId: 1, type: 'edit' });
    queue.publish({ docId: 1, type: 'edit' });

    expect(() => queue.publish({ docId: 1, type: 'edit' })).toThrow(QueueFullError);
    expect(queue.getStats().dropped).toBe(1);
  });

  test('consume drains manually in order', () => {
    const queue = new MessageQueue();
    queue.publish({ docId: 1, type: 'edit', payload: { n: 1 } });
    queue.publish({ docId: 1, type: 'edit', payload: { n: 2 } });

    expect(queue.consume().payload.n).toBe(1);
    expect(queue.consume().payload.n).toBe(2);
    expect(queue.consume()).toBeNull();
  });
});

describe('CollaborationManager', () => {
  let queue;
  let transport;
  let manager;

  beforeEach(() => {
    queue = new MessageQueue();
    transport = { sent: [], broadcast(docId, event, payload) { this.sent.push({ docId, event, payload }); } };
    manager = new CollaborationManager({ messageQueue: queue, transport });
  });

  afterEach(() => manager.close());

  test('tracks participants per document', () => {
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 10 });
    manager.join({ sessionId: 's2', userId: 2, username: 'linus', docId: 10 });

    expect(manager.getParticipants(10).map((p) => p.username).sort()).toEqual(['ada', 'linus']);
    expect(manager.getParticipants(99)).toEqual([]);
  });

  test('leaving one document keeps the session on the others', () => {
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 10 });
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 11 });

    manager.leave('s1', 10);
    expect(manager.getParticipants(10)).toEqual([]);
    expect(manager.getParticipants(11)).toHaveLength(1);
  });

  test('disconnecting removes the session from every document', () => {
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 10 });
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 11 });

    manager.leave('s1');
    expect(manager.getStats().sessions).toBe(0);
    expect(manager.getParticipants(11)).toEqual([]);
  });

  test('forwards queued edits to the transport with their sequence', async () => {
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 10 });
    queue.publish({ docId: 10, type: 'edit', payload: { version: 4 } });
    await flush();

    const edit = transport.sent.find((m) => m.event === 'edit');
    expect(edit).toMatchObject({ docId: 10, event: 'edit' });
    expect(edit.payload).toMatchObject({ version: 4 });
    expect(edit.payload.sequence).toBeGreaterThan(0);
  });

  test('broadcasts presence on join and leave', async () => {
    manager.join({ sessionId: 's1', userId: 1, username: 'ada', docId: 10 });
    manager.leave('s1', 10);
    await flush();

    const actions = transport.sent
      .filter((m) => m.event === 'presence')
      .map((m) => m.payload.action);
    expect(actions).toEqual(['join', 'leave']);
  });
});
