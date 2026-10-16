/**
 * Test harness: builds an engine over a throwaway data directory.
 *
 * Every suite gets its own directory so that documents.dat, wal.log and
 * index.dat from one test can never influence another. Recovery tests depend
 * on that isolation being real.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../../src/engine/Engine');

/** @returns {string} A fresh temporary directory. */
function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collabwrite-test-'));
}

/**
 * @param {string} dataDir
 * @param {object} [overrides]
 * @returns {object} An engine configuration pointing at dataDir.
 */
function engineConfig(dataDir, overrides = {}) {
  return {
    dataDir,
    storage: {
      pageSize: 4096,
      directoryPages: 4,
      dataFile: path.join(dataDir, 'documents.dat'),
      ...(overrides.storage || {})
    },
    bufferPool: { frames: 8, ...(overrides.bufferPool || {}) },
    lock: { timeoutMs: 2000, deadlockIntervalMs: 50, ...(overrides.lock || {}) },
    scheduler: { policy: 'FIFO', workers: 4, ...(overrides.scheduler || {}) },
    index: { order: 4, indexFile: path.join(dataDir, 'index.dat'), ...(overrides.index || {}) },
    recovery: {
      walFile: path.join(dataDir, 'wal.log'),
      // fsync on every commit makes the suite several times slower and proves
      // nothing the recovery tests do not already prove by simulating a crash.
      syncOnCommit: false,
      ...(overrides.recovery || {})
    },
    metrics: { enabled: false, file: path.join(dataDir, 'metrics.log'), ...(overrides.metrics || {}) }
  };
}

/**
 * Creates and starts an engine.
 * @param {string} dataDir
 * @param {object} [overrides]
 * @returns {Promise<Engine>}
 */
async function startEngine(dataDir, overrides = {}) {
  const engine = new Engine(engineConfig(dataDir, overrides));
  await engine.start();
  return engine;
}

/** @param {string} dataDir */
function cleanup(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/**
 * Keeps the event loop alive while a test waits on something that only
 * unref'd timers would wake. The deadlock detector's interval is unref'd so
 * that it never holds a production process open, which means a test waiting
 * purely on detection would otherwise see the process idle out.
 *
 * @returns {() => void} Call to release.
 */
function holdEventLoop() {
  const timer = setInterval(() => {}, 20);
  return () => clearInterval(timer);
}

module.exports = { makeDataDir, engineConfig, startEngine, cleanup, holdEventLoop };
