/**
 * CollabWrite - Academic Engine Configuration
 *
 * Central tuning parameters for the educational OS/DBMS engine. Every value
 * here is referenced by design.md so that a reader can map a constant in the
 * code back to the design decision that produced it.
 */

'use strict';

const path = require('path');

const DATA_DIR = process.env.ENGINE_DATA_DIR
  ? path.resolve(process.env.ENGINE_DATA_DIR)
  : path.resolve(__dirname, '..', '..', 'data');

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  /** Root directory holding documents.dat, wal.log and index.dat. */
  dataDir: DATA_DIR,

  storage: {
    /** design.md section 3: fixed 4 KiB pages. */
    pageSize: 4096,
    /**
     * design.md section 3 places the page directory "at the beginning of
     * documents.dat". We reserve the first N pages for it so the directory can
     * grow beyond a single page without changing the file layout.
     */
    directoryPages: 4,
    dataFile: path.join(DATA_DIR, 'documents.dat')
  },

  bufferPool: {
    /** design.md section 4: default pool of 8 frames (~32 KiB). */
    frames: intFromEnv('ENGINE_BUFFER_FRAMES', 8)
  },

  lock: {
    /** design.md section 7: optional per-request timeout. 0 disables it. */
    timeoutMs: intFromEnv('LOCK_TIMEOUT_MS', 5000),
    /** Periodic wait-for graph sweep. */
    deadlockIntervalMs: intFromEnv('DEADLOCK_CHECK_INTERVAL_MS', 250)
  },

  scheduler: {
    /** 'FIFO' | 'ROUND_ROBIN' - design.md section 8. */
    policy: process.env.SCHEDULER_POLICY || 'FIFO',
    workers: intFromEnv('ENGINE_WORKERS', 4)
  },

  index: {
    /** Maximum keys per B+-Tree node before a split. */
    order: intFromEnv('ENGINE_INDEX_ORDER', 4),
    indexFile: path.join(DATA_DIR, 'index.dat')
  },

  recovery: {
    walFile: path.join(DATA_DIR, 'wal.log'),
    /** fsync the WAL on COMMIT. Disabled in tests for speed. */
    syncOnCommit: process.env.WAL_SYNC_ON_COMMIT !== 'false'
  },

  metrics: {
    file: path.join(DATA_DIR, 'metrics.log'),
    enabled: process.env.ENABLE_METRICS !== 'false'
  }
};
