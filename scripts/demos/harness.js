/**
 * Shared harness for the evaluation demos (prd.md section 10).
 *
 * Each demo runs against a throwaway data directory so it can be re-run
 * during the viva without leaving state behind, and prints to a consistent
 * format so the examiner can follow along.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../../src/engine/Engine');

/**
 * Builds an engine over a fresh temporary directory.
 *
 * @param {object} [overrides] - Engine configuration overrides.
 * @returns {Promise<{engine: Engine, dataDir: string, dispose: Function}>}
 */
async function withEngine(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabwrite-demo-'));
  const engine = new Engine({
    dataDir,
    storage: {
      pageSize: 4096,
      directoryPages: 4,
      dataFile: path.join(dataDir, 'documents.dat'),
      ...(overrides.storage || {})
    },
    bufferPool: { frames: 8, ...(overrides.bufferPool || {}) },
    lock: { timeoutMs: 5000, deadlockIntervalMs: 100, ...(overrides.lock || {}) },
    scheduler: { policy: 'FIFO', workers: 4, ...(overrides.scheduler || {}) },
    index: { order: 4, indexFile: path.join(dataDir, 'index.dat'), ...(overrides.index || {}) },
    recovery: {
      walFile: path.join(dataDir, 'wal.log'),
      syncOnCommit: false,
      ...(overrides.recovery || {})
    },
    metrics: { enabled: true, file: path.join(dataDir, 'metrics.log'), ...(overrides.metrics || {}) }
  });

  await engine.start();
  return {
    engine,
    dataDir,
    async dispose() {
      if (engine.started) await engine.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

/** @param {string} title */
function heading(title) {
  const line = '='.repeat(74);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

/** @param {string} title */
function section(title) {
  console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 70 - title.length))}`);
}

/** @param {string} message */
function step(message) {
  console.log(`   ${message}`);
}

/**
 * Prints an array of flat objects as an aligned table.
 * @param {Array<object>} rows
 */
function table(rows) {
  if (!rows || rows.length === 0) {
    console.log('   (no rows)');
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) => Math.max(
    column.length,
    ...rows.map((row) => String(row[column] ?? '').length)
  ));

  const render = (cells) => `   ${cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ')}`;
  console.log(render(columns));
  console.log(render(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(render(columns.map((column) => row[column])));
}

/**
 * Keeps the event loop alive. The deadlock detector's interval is unref'd so
 * it never holds a server open; a demo waiting on detection needs something
 * that does.
 * @returns {() => void}
 */
function holdEventLoop() {
  const timer = setInterval(() => {}, 20);
  return () => clearInterval(timer);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a demo body, printing failures clearly and setting a non-zero exit
 * code so `npm run demo` fails loudly in CI.
 *
 * @param {string} title
 * @param {() => Promise<void>} body
 */
async function runDemo(title, body) {
  heading(title);
  try {
    await body();
    console.log(`\n   RESULT: ${title} completed successfully.\n`);
  } catch (error) {
    console.error(`\n   RESULT: ${title} FAILED - ${error.message}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

module.exports = { withEngine, heading, section, step, table, holdEventLoop, sleep, runDemo };
