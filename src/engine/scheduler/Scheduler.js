/**
 * CollabWrite - Request Scheduler (Phase 7)
 *
 * CONCEPT
 *   Every edit request enters the engine here. The scheduler is the queue
 *   between arrival and execution, and the policy it applies decides which
 *   waiting request runs next. This is the OS CPU-scheduling problem with
 *   transactions in place of processes and workers in place of cores.
 *
 * POLICIES (design.md section 8)
 *   FIFO         One queue, served in arrival order. Simple and starvation-
 *                free, but a burst aimed at one document delays everything
 *                queued behind it (convoy effect).
 *   ROUND_ROBIN  One sub-queue per document, served by rotating through the
 *                documents. A burst on one document can no longer monopolise
 *                the workers, so mean waiting time for the other documents
 *                drops sharply. This is the comparison phases.md milestone 12
 *                asks for.
 *   Priority is supported as a flag within whichever policy is active: a
 *   request marked priority jumps ahead of non-priority requests in its queue.
 *
 * METRICS
 *   Each task records enqueuedAt, startedAt and finishedAt, giving:
 *     waiting time    = startedAt  - enqueuedAt
 *     turnaround time = finishedAt - enqueuedAt
 *   which are the two numbers an OS scheduling comparison is judged on.
 *
 * DISPATCH
 *   dispatch() is called whenever work arrives or a worker frees up. It pairs
 *   idle workers with queued tasks until one side runs out. Task execution is
 *   asynchronous; the worker stays BUSY for the whole transaction, including
 *   any time it spends blocked on a lock.
 */

'use strict';

const { WorkerPool } = require('./WorkerPool');
const { createLogger } = require('../../config/logger');

const log = createLogger('Scheduler');

const POLICIES = { FIFO: 'FIFO', ROUND_ROBIN: 'ROUND_ROBIN' };

class Scheduler {
  /**
   * @param {object} [options]
   * @param {'FIFO'|'ROUND_ROBIN'} [options.policy]
   * @param {number} [options.workers]
   * @param {WorkerPool} [options.workerPool] - Injectable for tests.
   */
  constructor({ policy = POLICIES.FIFO, workers = 4, workerPool = null } = {}) {
    if (!POLICIES[policy]) throw new Error(`Unknown scheduling policy: ${policy}`);
    this.policy = policy;
    this.workerPool = workerPool || new WorkerPool(workers);

    /** FIFO queue. @type {Array<object>} */
    this.queue = [];
    /** Round-robin sub-queues. @type {Map<string|number, Array<object>>} */
    this.documentQueues = new Map();
    /** Rotation order for round-robin. @type {Array<string|number>} */
    this.rotation = [];
    this.rotationIndex = 0;

    this.nextTaskId = 1;
    this.running = false;
    /** @type {Array<object>} Completed task records, for the metrics report. */
    this.completed = [];
    this.stats = { submitted: 0, dispatched: 0, succeeded: 0, failed: 0 };
  }

  /** @returns {number} Tasks waiting across every queue. */
  get queueLength() {
    if (this.policy === POLICIES.FIFO) return this.queue.length;
    let total = 0;
    for (const queue of this.documentQueues.values()) total += queue.length;
    return total;
  }

  /** Allows the scheduling demo to compare policies on one engine. */
  setPolicy(policy) {
    if (!POLICIES[policy]) throw new Error(`Unknown scheduling policy: ${policy}`);
    if (this.queueLength > 0) throw new Error('Cannot change policy while tasks are queued');
    this.policy = policy;
  }

  start() {
    this.running = true;
    this.dispatch();
  }

  /** Stops dispatching. Tasks already running continue to completion. */
  stop() {
    this.running = false;
  }

  /**
   * Submits a unit of work and resolves when it has been executed.
   *
   * @param {object} request
   * @param {number|string} request.docId - Used as the round-robin queue key.
   * @param {string} [request.operation] - Label for logs and metrics.
   * @param {boolean} [request.priority] - Jump ahead of normal requests.
   * @param {object} [request.payload]
   * @param {(task:object) => Promise<any>} execute - The work itself.
   * @returns {Promise<any>} Whatever `execute` resolves to.
   */
  submit({ docId, operation = 'edit', priority = false, payload = null }, execute) {
    return new Promise((resolve, reject) => {
      const task = {
        taskId: this.nextTaskId,
        docId,
        operation,
        priority,
        payload,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        workerId: null
      };
      this.nextTaskId += 1;
      this.stats.submitted += 1;
      this.enqueue(task);

      log.debug('Task submitted', { taskId: task.taskId, docId, operation, priority });
      if (this.running) this.dispatch();
    });
  }

  /** @param {object} task */
  enqueue(task) {
    if (this.policy === POLICIES.FIFO) {
      insertByPriority(this.queue, task);
      return;
    }
    let queue = this.documentQueues.get(task.docId);
    if (!queue) {
      queue = [];
      this.documentQueues.set(task.docId, queue);
      this.rotation.push(task.docId);
    }
    insertByPriority(queue, task);
  }

  /**
   * Removes and returns the next task according to the active policy.
   * @returns {object|null}
   */
  dequeue() {
    if (this.policy === POLICIES.FIFO) {
      return this.queue.shift() || null;
    }

    // Round-robin: advance through the document rotation until a non-empty
    // sub-queue is found, taking one task from it before moving on.
    for (let attempt = 0; attempt < this.rotation.length; attempt += 1) {
      const docId = this.rotation[this.rotationIndex % this.rotation.length];
      this.rotationIndex = (this.rotationIndex + 1) % Math.max(1, this.rotation.length);

      const queue = this.documentQueues.get(docId);
      if (queue && queue.length > 0) return queue.shift();
    }
    return null;
  }

  /** Pairs idle workers with queued tasks until one side is exhausted. */
  dispatch() {
    if (!this.running) return;

    while (this.queueLength > 0) {
      const worker = this.workerPool.acquire();
      if (!worker) return;

      // acquire() only reserves a cursor position; the worker is not marked
      // BUSY until run() assigns a task, so bailing out here leaks nothing.
      const task = this.dequeue();
      if (!task) return;
      this.run(worker, task);
    }
  }

  /**
   * Executes one task on one worker and releases the worker afterwards.
   * @param {import('./WorkerPool').Worker} worker
   * @param {object} task
   */
  run(worker, task) {
    task.startedAt = Date.now();
    task.workerId = worker.id;
    worker.assign(task);
    this.stats.dispatched += 1;

    Promise.resolve()
      .then(() => task.execute(task))
      .then(
        (value) => this.finish(worker, task, null, value),
        (error) => this.finish(worker, task, error, null)
      );
  }

  /**
   * Records completion, frees the worker and pulls the next task in.
   * @param {import('./WorkerPool').Worker} worker
   * @param {object} task
   * @param {Error|null} error
   * @param {any} value
   */
  finish(worker, task, error, value) {
    task.finishedAt = Date.now();
    this.completed.push({
      taskId: task.taskId,
      docId: task.docId,
      operation: task.operation,
      priority: task.priority,
      workerId: task.workerId,
      waitingMs: task.startedAt - task.enqueuedAt,
      serviceMs: task.finishedAt - task.startedAt,
      turnaroundMs: task.finishedAt - task.enqueuedAt,
      failed: Boolean(error)
    });

    if (error) {
      this.stats.failed += 1;
      task.reject(error);
    } else {
      this.stats.succeeded += 1;
      task.resolve(value);
    }

    this.workerPool.release(worker);
    this.dispatch();
  }

  /**
   * @returns {{policy:string, submitted:number, dispatched:number,
   *            succeeded:number, failed:number, queueLength:number,
   *            averageWaitingMs:number, averageTurnaroundMs:number,
   *            maxWaitingMs:number, workers:object[]}}
   */
  getMetrics() {
    const count = this.completed.length;
    const sum = (key) => this.completed.reduce((total, task) => total + task[key], 0);
    return {
      policy: this.policy,
      ...this.stats,
      queueLength: this.queueLength,
      completed: count,
      averageWaitingMs: count === 0 ? 0 : Number((sum('waitingMs') / count).toFixed(2)),
      averageTurnaroundMs: count === 0 ? 0 : Number((sum('turnaroundMs') / count).toFixed(2)),
      maxWaitingMs: count === 0 ? 0 : Math.max(...this.completed.map((t) => t.waitingMs)),
      workers: this.workerPool.snapshot()
    };
  }

  /** Clears completed-task history between benchmark runs. */
  resetMetrics() {
    this.completed = [];
    this.stats = { submitted: 0, dispatched: 0, succeeded: 0, failed: 0 };
  }
}

/**
 * Inserts a task into a queue, placing priority tasks ahead of normal ones
 * while preserving arrival order within each class.
 *
 * @param {Array<object>} queue
 * @param {object} task
 */
function insertByPriority(queue, task) {
  if (!task.priority) {
    queue.push(task);
    return;
  }
  let position = queue.length;
  while (position > 0 && !queue[position - 1].priority) position -= 1;
  queue.splice(position, 0, task);
}

module.exports = { Scheduler, POLICIES };
