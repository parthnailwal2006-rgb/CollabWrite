/**
 * CollabWrite - Message Queue (Phase 8)
 *
 * CONCEPT
 *   Producer-consumer with a bounded buffer is the textbook synchronisation
 *   problem, and it is exactly the shape of the broadcast path: workers
 *   produce committed edit events, the collaboration manager consumes them and
 *   pushes them to clients. Putting a queue in between means a worker never
 *   blocks on a slow socket - it commits, enqueues and moves to the next
 *   transaction.
 *
 * WHY NOT JUST CALL SOCKET.IO FROM THE WORKER
 *   rules.md section 2 forbids presenting Socket.IO's own routing as our
 *   message-passing layer. The queue below is the message-passing layer:
 *   it owns the ordering guarantee, the capacity bound and the delivery
 *   bookkeeping. Socket.IO is only the transport the consumer happens to use.
 *
 * ORDERING GUARANTEE
 *   FIFO per document. Events carry a docId and a per-document sequence
 *   number; the consumer drains in insertion order, so two edits to the same
 *   document can never be delivered out of order. No ordering is promised
 *   across different documents, and none is needed.
 *
 * BACKPRESSURE
 *   The queue has a capacity. publish() on a full queue rejects rather than
 *   growing without bound, which is the honest behaviour for a fixed-size
 *   buffer and makes the failure visible instead of turning it into a memory
 *   leak.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('MessageQueue');

class QueueFullError extends Error {
  constructor(capacity) {
    super(`Message queue is full (capacity ${capacity})`);
    this.name = 'QueueFullError';
  }
}

class MessageQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] - Maximum buffered events.
   */
  constructor({ capacity = 1024 } = {}) {
    this.capacity = capacity;
    /** @type {Array<object>} */
    this.buffer = [];
    /** @type {Map<number|string, number>} docId -> last sequence number issued. */
    this.sequences = new Map();
    /** @type {Array<(event:object) => void>} */
    this.consumers = [];
    this.draining = false;
    this.stats = { published: 0, delivered: 0, dropped: 0 };
  }

  get length() {
    return this.buffer.length;
  }

  /**
   * Registers a consumer. Every consumer sees every event, in order.
   * @param {(event:object) => void|Promise<void>} consumer
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(consumer) {
    this.consumers.push(consumer);
    return () => {
      const index = this.consumers.indexOf(consumer);
      if (index !== -1) this.consumers.splice(index, 1);
    };
  }

  /**
   * Enqueues a committed edit event.
   *
   * @param {object} event
   * @param {number|string} event.docId
   * @param {string} event.type - 'edit', 'presence', 'conflict', ...
   * @param {object} [event.payload]
   * @returns {{sequence:number, docId:number|string}}
   * @throws {QueueFullError}
   */
  publish(event) {
    if (this.buffer.length >= this.capacity) {
      this.stats.dropped += 1;
      throw new QueueFullError(this.capacity);
    }

    const sequence = (this.sequences.get(event.docId) || 0) + 1;
    this.sequences.set(event.docId, sequence);

    const envelope = {
      ...event,
      sequence,
      publishedAt: new Date().toISOString()
    };
    this.buffer.push(envelope);
    this.stats.published += 1;

    this.scheduleDrain();
    return { sequence, docId: event.docId };
  }

  /**
   * Removes and returns the next event, or null when empty. Exposed so a test
   * can drive the queue by hand instead of relying on the async drain.
   * @returns {object|null}
   */
  consume() {
    return this.buffer.shift() || null;
  }

  /**
   * Schedules an asynchronous drain. Deferring to the microtask queue keeps
   * publish() non-blocking for the worker that called it.
   */
  scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      this.draining = false;
      this.drain();
    });
  }

  /**
   * Delivers every buffered event to every consumer, in order.
   * @returns {number} Events delivered.
   */
  drain() {
    let delivered = 0;
    while (this.buffer.length > 0) {
      const event = this.buffer.shift();
      for (const consumer of this.consumers) {
        try {
          consumer(event);
        } catch (error) {
          log.error('Consumer threw while handling an event', {
            docId: event.docId,
            sequence: event.sequence,
            message: error.message
          });
        }
      }
      this.stats.delivered += 1;
      delivered += 1;
    }
    return delivered;
  }

  /** @returns {object} Publication and delivery counters. */
  getStats() {
    return { ...this.stats, buffered: this.buffer.length, capacity: this.capacity };
  }

  /** Discards buffered events and sequence state. */
  reset() {
    this.buffer = [];
    this.sequences.clear();
    this.stats = { published: 0, delivered: 0, dropped: 0 };
  }
}

module.exports = { MessageQueue, QueueFullError };
