/**
 * CollabWrite - Metrics Recorder (design.md section 16)
 *
 * Collects the six numbers the evaluation plan is judged on:
 *   request waiting time, transaction completion time, lock wait time,
 *   buffer-pool hits versus misses, recovery time, and search latency.
 *
 * Samples are appended to metrics.log as JSON lines so the final report can
 * plot them without parsing prose, and kept in memory so the admin endpoint
 * can summarise them live.
 */

'use strict';

const fs = require('fs');
const path = require('path');

class Metrics {
  /**
   * @param {object} [options]
   * @param {string} [options.file] - metrics.log path.
   * @param {boolean} [options.enabled]
   * @param {number} [options.retain] - Samples kept in memory per name.
   */
  constructor({ file = null, enabled = true, retain = 500 } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.retain = retain;
    /** @type {Map<string, number[]>} */
    this.samples = new Map();
  }

  /**
   * Records one measurement.
   * @param {string} name - For example 'edit.latencyMs'.
   * @param {number} value
   * @param {object} [context] - Extra fields written to the log line.
   */
  record(name, value, context = {}) {
    if (!this.enabled) return;

    let series = this.samples.get(name);
    if (!series) {
      series = [];
      this.samples.set(name, series);
    }
    series.push(value);
    if (series.length > this.retain) series.shift();

    if (!this.file) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), metric: name, value, ...context })}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line);
    } catch {
      // Metrics must never take the engine down; a failed append is dropped.
    }
  }

  /**
   * Times an async function and records how long it took.
   * @param {string} name
   * @param {() => Promise<any>} fn
   * @param {object} [context]
   * @returns {Promise<any>}
   */
  async time(name, fn, context = {}) {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.record(name, Date.now() - startedAt, context);
    }
  }

  /**
   * @param {string} name
   * @returns {{count:number, min:number, max:number, mean:number, p95:number}|null}
   */
  summary(name) {
    const series = this.samples.get(name);
    if (!series || series.length === 0) return null;

    const sorted = [...series].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Number((sum / sorted.length).toFixed(3)),
      p95: sorted[p95Index]
    };
  }

  /** @returns {object} A summary per recorded metric name. */
  summaryAll() {
    const result = {};
    for (const name of this.samples.keys()) {
      result[name] = this.summary(name);
    }
    return result;
  }

  reset() {
    this.samples.clear();
  }
}

module.exports = { Metrics };
