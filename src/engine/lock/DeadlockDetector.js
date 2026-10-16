/**
 * CollabWrite - Deadlock Detector (Phase 6)
 *
 * CONCEPT
 *   Deadlock is the OS condition in which a set of transactions each hold a
 *   resource another member of the set is waiting for, so none can proceed.
 *   This engine takes the detect-and-recover approach rather than prevention:
 *   transactions lock freely, a background sweep looks for a cycle, and one
 *   victim is aborted to break it.
 *
 * DATA STRUCTURE - Wait-For Graph (design.md section 7)
 *   Nodes are active transactions. A directed edge Ti -> Tj exists when Ti is
 *   queued for a lock currently held by Tj in an incompatible mode. A cycle in
 *   this graph is precisely a deadlock.
 *
 * ALGORITHM - Tarjan's strongly connected components
 *   A single depth-first pass assigns each node an index and a low-link value.
 *   When a node's low-link equals its index it is the root of an SCC, which is
 *   popped off the stack. Any SCC containing more than one node is a cycle,
 *   and therefore a deadlock. Tarjan runs in O(V + E) and finds every cycle in
 *   one pass, which beats repeating a DFS per node.
 *
 * VICTIM SELECTION
 *   Abort the transaction holding the fewest locks, breaking ties by the
 *   highest (youngest) transaction id. Rolling back the smallest holder throws
 *   away the least completed work, and preferring the youngest transaction
 *   avoids starving a long-running one that keeps losing.
 */

'use strict';

const { createLogger } = require('../../config/logger');

const log = createLogger('DeadlockDetector');

class DeadlockDetector {
  /**
   * @param {import('./LockManager').LockManager} lockManager
   * @param {object} [options]
   * @param {number} [options.intervalMs] - Sweep period; 0 means manual only.
   * @param {(victimTxId:number, cycle:number[]) => void} [options.onVictim]
   */
  constructor(lockManager, { intervalMs = 0, onVictim = null } = {}) {
    this.lockManager = lockManager;
    this.intervalMs = intervalMs;
    this.onVictim = onVictim;
    this.timer = null;
    this.stats = { sweeps: 0, deadlocksDetected: 0, victimsAborted: 0 };
    this.history = [];
  }

  /**
   * Builds the wait-for graph as an adjacency map.
   * @returns {Map<number, Set<number>>}
   */
  buildWaitForGraph() {
    const graph = new Map();
    const ensure = (txId) => {
      if (!graph.has(txId)) graph.set(txId, new Set());
      return graph.get(txId);
    };
    for (const edge of this.lockManager.getWaitForEdges()) {
      ensure(edge.waiter).add(edge.holder);
      ensure(edge.holder);
    }
    return graph;
  }

  /**
   * Finds every cycle using Tarjan's strongly connected components algorithm.
   *
   * @param {Map<number, Set<number>>} [graph] - Defaults to the live graph.
   * @returns {number[][]} One array of transaction ids per deadlock cycle.
   */
  findCycles(graph = this.buildWaitForGraph()) {
    let nextIndex = 0;
    const index = new Map();
    const lowLink = new Map();
    const onStack = new Set();
    const stack = [];
    const cycles = [];

    const strongConnect = (node) => {
      index.set(node, nextIndex);
      lowLink.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);

      for (const neighbour of graph.get(node) || []) {
        if (!index.has(neighbour)) {
          strongConnect(neighbour);
          lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(neighbour)));
        } else if (onStack.has(neighbour)) {
          lowLink.set(node, Math.min(lowLink.get(node), index.get(neighbour)));
        }
      }

      if (lowLink.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);

        // An SCC of one node is a deadlock only if it waits on itself, which
        // the lock manager never produces (a transaction is not blocked by a
        // lock it already holds).
        if (component.length > 1) {
          cycles.push(component.sort((a, b) => a - b));
        }
      }
    };

    for (const node of graph.keys()) {
      if (!index.has(node)) strongConnect(node);
    }
    return cycles;
  }

  /**
   * Chooses which transaction in a cycle to abort.
   * @param {number[]} cycle
   * @returns {number} The victim transaction id.
   */
  selectVictim(cycle) {
    let victim = cycle[0];
    let fewest = this.lockManager.getLocksHeldBy(victim).length;

    for (const txId of cycle.slice(1)) {
      const held = this.lockManager.getLocksHeldBy(txId).length;
      if (held < fewest || (held === fewest && txId > victim)) {
        victim = txId;
        fewest = held;
      }
    }
    return victim;
  }

  /**
   * Runs one detection sweep and notifies the owner of each victim.
   *
   * @returns {Array<{cycle:number[], victim:number}>} Deadlocks found.
   */
  detect() {
    this.stats.sweeps += 1;
    const cycles = this.findCycles();
    if (cycles.length === 0) return [];

    const resolved = [];
    for (const cycle of cycles) {
      const victim = this.selectVictim(cycle);
      this.stats.deadlocksDetected += 1;
      this.history.push({ cycle, victim, detectedAt: new Date().toISOString() });
      log.warn('Deadlock detected', { cycle, victim });

      if (this.onVictim) {
        this.stats.victimsAborted += 1;
        this.onVictim(victim, cycle);
      }
      resolved.push({ cycle, victim });
    }
    return resolved;
  }

  /** Starts the periodic sweep. */
  start() {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.detect();
      } catch (error) {
        log.error('Deadlock sweep failed', { message: error.message });
      }
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.info('Deadlock detector started', { intervalMs: this.intervalMs });
  }

  /** Stops the periodic sweep. */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {object} Sweep and victim counters. */
  getStats() {
    return { ...this.stats, history: [...this.history] };
  }
}

module.exports = { DeadlockDetector };
