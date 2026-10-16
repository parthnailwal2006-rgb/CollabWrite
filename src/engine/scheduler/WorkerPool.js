/**
 * CollabWrite - Worker Pool (Phase 7)
 *
 * CONCEPT
 *   A worker is an execution context that owns exactly one transaction at a
 *   time. The pool has a fixed size, so the number of transactions running
 *   concurrently is bounded by the number of workers rather than by the number
 *   of clients. That bound is what makes the lock table, the buffer pool and
 *   the scheduler queue observable: with unlimited concurrency there would be
 *   nothing to schedule.
 *
 * WHY NOT node:worker_threads
 *   rules.md section 9 requires that we model workers explicitly rather than
 *   leaning on a framework. It does not require OS threads, and real threads
 *   would actively hurt here: the lock table, buffer pool and WAL are shared
 *   in-process data structures. Moving tasks onto worker_threads would force
 *   every page and every lock decision through message passing to a single
 *   owning thread, which hides the mechanisms this project exists to show.
 *   Workers are therefore modelled as first-class objects with an explicit
 *   IDLE/BUSY state machine, an occupancy record and per-worker statistics -
 *   all the state an OS keeps for a thread - scheduled cooperatively on the
 *   event loop. design.md section 17 records this trade-off.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('WorkerPool');

const WORKER_STATES = { IDLE: 'IDLE', BUSY: 'BUSY' };

class Worker {
  /** @param {number} id */
  constructor(id) {
    this.id = id;
    this.state = WORKER_STATES.IDLE;
    this.currentTask = null;
    this.tasksProcessed = 0;
    this.busyMs = 0;
    this.startedAt = null;
  }

  get isIdle() {
    return this.state === WORKER_STATES.IDLE;
  }

  /** @param {object} task */
  assign(task) {
    this.state = WORKER_STATES.BUSY;
    this.currentTask = task;
    this.startedAt = Date.now();
  }

  release() {
    if (this.startedAt !== null) this.busyMs += Date.now() - this.startedAt;
    this.state = WORKER_STATES.IDLE;
    this.currentTask = null;
    this.startedAt = null;
    this.tasksProcessed += 1;
  }

  toJSON() {
    return {
      id: this.id,
      state: this.state,
      tasksProcessed: this.tasksProcessed,
      busyMs: this.busyMs,
      currentTaskId: this.currentTask ? this.currentTask.taskId : null
    };
  }
}

class WorkerPool {
  /**
   * @param {number} size - Number of workers.
   */
  constructor(size) {
    if (size < 1) throw new Error('Worker pool size must be at least 1');
    this.workers = Array.from({ length: size }, (_, i) => new Worker(i + 1));
    /** Cursor for circular (round-robin) worker selection. */
    this.cursor = 0;
    log.info('Worker pool created', { size });
  }

  get size() {
    return this.workers.length;
  }

  /** @returns {number} Workers currently IDLE. */
  get idleCount() {
    return this.workers.filter((w) => w.isIdle).length;
  }

  /**
   * Picks the next idle worker, scanning circularly from the cursor so that
   * work is spread evenly instead of always landing on worker 1.
   * @returns {Worker|null}
   */
  acquire() {
    for (let offset = 0; offset < this.workers.length; offset += 1) {
      const index = (this.cursor + offset) % this.workers.length;
      const worker = this.workers[index];
      if (worker.isIdle) {
        this.cursor = (index + 1) % this.workers.length;
        return worker;
      }
    }
    return null;
  }

  /** @param {Worker} worker */
  release(worker) {
    worker.release();
  }

  /** @returns {object[]} Per-worker snapshot for the scheduling demo. */
  snapshot() {
    return this.workers.map((w) => w.toJSON());
  }
}

module.exports = { WorkerPool, Worker, WORKER_STATES };
