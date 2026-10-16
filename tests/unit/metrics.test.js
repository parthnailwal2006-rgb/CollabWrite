/**
 * design.md section 16 - Metrics recorder tests.
 *
 * The performance numbers in the final report come from here, so the
 * aggregation has to be right: a wrong mean would misrepresent the
 * evaluation rather than merely lose a feature.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { Metrics } = require('../../src/engine/metrics/Metrics');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

describe('Metrics', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = makeDataDir();
  });

  afterEach(() => cleanup(dataDir));

  test('records nothing when disabled', () => {
    const metrics = new Metrics({ enabled: false });
    metrics.record('edit.latencyMs', 5);

    expect(metrics.summary('edit.latencyMs')).toBeNull();
  });

  test('summarises a series', () => {
    const metrics = new Metrics({ enabled: true });
    [10, 20, 30, 40].forEach((value) => metrics.record('lock.waitMs', value));

    expect(metrics.summary('lock.waitMs')).toEqual({
      count: 4,
      min: 10,
      max: 40,
      mean: 25,
      p95: 40
    });
  });

  test('returns null for an unknown metric', () => {
    expect(new Metrics({ enabled: true }).summary('never.recorded')).toBeNull();
  });

  test('keeps only the most recent samples', () => {
    const metrics = new Metrics({ enabled: true, retain: 3 });
    [1, 2, 3, 4, 5].forEach((value) => metrics.record('m', value));

    expect(metrics.summary('m')).toMatchObject({ count: 3, min: 3, max: 5 });
  });

  test('appends JSON lines to metrics.log', () => {
    const file = path.join(dataDir, 'metrics.log');
    const metrics = new Metrics({ enabled: true, file });

    metrics.record('search.latencyMs', 1.5, { keyword: 'deadlock' });
    metrics.record('search.latencyMs', 2.5, { keyword: 'buffer' });

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ metric: 'search.latencyMs', value: 1.5, keyword: 'deadlock' });
  });

  test('time() records a duration even when the function throws', async () => {
    const metrics = new Metrics({ enabled: true });

    await expect(metrics.time('edit.latencyMs', async () => {
      throw new Error('failed work');
    })).rejects.toThrow('failed work');

    expect(metrics.summary('edit.latencyMs').count).toBe(1);
  });

  test('time() returns the wrapped value', async () => {
    const metrics = new Metrics({ enabled: true });
    await expect(metrics.time('m', async () => 'result')).resolves.toBe('result');
  });

  test('summaryAll covers every recorded name', () => {
    const metrics = new Metrics({ enabled: true });
    metrics.record('a', 1);
    metrics.record('b', 2);

    expect(Object.keys(metrics.summaryAll()).sort()).toEqual(['a', 'b']);
    metrics.reset();
    expect(metrics.summaryAll()).toEqual({});
  });

  test('a failing log write does not propagate', () => {
    // A directory cannot be appended to as a file.
    const metrics = new Metrics({ enabled: true, file: dataDir });
    expect(() => metrics.record('m', 1)).not.toThrow();
  });
});
