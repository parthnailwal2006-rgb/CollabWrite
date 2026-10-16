/**
 * Phase 10 - B+-Tree and Index Manager tests.
 *
 * The B+-Tree is tested by property rather than by example: after every
 * randomised insert and delete sequence the structural invariants must still
 * hold and the contents must still match a plain Map. A tree that claims
 * O(log N) lookups has to prove it stays balanced.
 */

'use strict';

const path = require('path');

const { BPlusTree } = require('../../src/engine/index/BPlusTree');
const { IndexManager } = require('../../src/engine/index/IndexManager');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

/** Deterministic PRNG so a failure is reproducible from its seed. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('BPlusTree', () => {
  test('rejects a fanout below three', () => {
    expect(() => new BPlusTree(2)).toThrow(/at least 3/);
  });

  test('stores several documents under one keyword', () => {
    const tree = new BPlusTree(4);
    tree.insert('alpha', 1);
    tree.insert('alpha', 2);

    expect(tree.search('alpha').sort()).toEqual([1, 2]);
    expect(tree.size).toBe(1);
  });

  test('returns an empty list for a missing key', () => {
    expect(new BPlusTree(4).search('nothing')).toEqual([]);
  });

  test('grows in height rather than in width', () => {
    const tree = new BPlusTree(4);
    for (let i = 0; i < 500; i += 1) tree.insert(`key${String(i).padStart(4, '0')}`, i);

    expect(tree.validate().valid).toBe(true);
    expect(tree.height).toBeGreaterThan(1);
    // log base 2 of 500 is about 9; anything near 500 would mean a list.
    expect(tree.height).toBeLessThan(12);
  });

  test('keeps leaves chained in ascending key order', () => {
    const tree = new BPlusTree(3);
    const keys = ['delta', 'alpha', 'echo', 'bravo', 'charlie'];
    keys.forEach((key, i) => tree.insert(key, i));

    expect(tree.entries().map((e) => e.key)).toEqual([...keys].sort());
  });

  test('range scans the leaf chain inclusively', () => {
    const tree = new BPlusTree(4);
    for (let i = 0; i < 50; i += 1) tree.insert(`k${String(i).padStart(2, '0')}`, i);

    expect(tree.rangeScan('k10', 'k13').map((e) => e.key)).toEqual(['k10', 'k11', 'k12', 'k13']);
  });

  test('removes one document without dropping the keyword', () => {
    const tree = new BPlusTree(4);
    tree.insert('shared', 1);
    tree.insert('shared', 2);

    expect(tree.delete('shared', 1)).toBe(true);
    expect(tree.search('shared')).toEqual([2]);
    expect(tree.size).toBe(1);

    expect(tree.delete('shared', 2)).toBe(true);
    expect(tree.search('shared')).toEqual([]);
    expect(tree.size).toBe(0);
  });

  test('reports false when deleting something absent', () => {
    const tree = new BPlusTree(4);
    tree.insert('present', 1);

    expect(tree.delete('absent', 1)).toBe(false);
    expect(tree.delete('present', 99)).toBe(false);
  });

  test('shrinks back to a single leaf when emptied', () => {
    const tree = new BPlusTree(3);
    for (let i = 0; i < 40; i += 1) tree.insert(`key${i}`, i);
    for (let i = 0; i < 40; i += 1) tree.delete(`key${i}`, i);

    expect(tree.size).toBe(0);
    expect(tree.height).toBe(1);
    expect(tree.validate().valid).toBe(true);
  });

  describe.each([3, 4, 5, 8])('property test at fanout %i', (fanout) => {
    test('stays balanced and consistent under randomised churn', () => {
      for (let trial = 0; trial < 15; trial += 1) {
        const random = seededRandom(trial * 7919 + fanout);
        const tree = new BPlusTree(fanout);
        const model = new Map();

        for (let i = 0; i < 300; i += 1) {
          const key = `k${String(Math.floor(random() * 120)).padStart(3, '0')}`;
          const docId = Math.floor(random() * 40);
          tree.insert(key, docId);
          if (!model.has(key)) model.set(key, new Set());
          model.get(key).add(docId);
        }

        expect(tree.validate()).toEqual({ valid: true, errors: [] });

        for (const key of [...model.keys()]) {
          if (random() > 0.6) continue;
          for (const docId of [...model.get(key)]) {
            tree.delete(key, docId);
            model.get(key).delete(docId);
          }
          if (model.get(key).size === 0) model.delete(key);
          expect(tree.validate().valid).toBe(true);
        }

        expect(tree.size).toBe(model.size);
        for (const [key, docIds] of model) {
          expect(tree.search(key).sort((a, b) => a - b)).toEqual([...docIds].sort((a, b) => a - b));
        }

        const keys = tree.entries().map((e) => e.key);
        expect(keys).toEqual([...keys].sort());
      }
    });
  });
});

describe('IndexManager', () => {
  let dataDir;
  let index;

  beforeEach(() => {
    dataDir = makeDataDir();
    index = new IndexManager({ indexFile: path.join(dataDir, 'index.dat'), order: 4 });
  });

  afterEach(() => cleanup(dataDir));

  test('tokenizes by folding case and dropping stop words and single characters', () => {
    const tokens = IndexManager.tokenize('The Quick brown fox, a FOX! x');
    expect([...tokens].sort()).toEqual(['brown', 'fox', 'quick']);
  });

  test('indexes and finds a document', () => {
    index.indexDocument(1, 'operating systems and database concepts');
    index.indexDocument(2, 'database recovery and logging');

    expect(index.search('database')).toEqual([1, 2]);
    expect(index.search('logging')).toEqual([2]);
    expect(index.search('absent')).toEqual([]);
  });

  test('is case insensitive on lookup', () => {
    index.indexDocument(1, 'Concurrency Control');
    expect(index.search('CONCURRENCY')).toEqual([1]);
  });

  test('re-indexing removes keywords that are no longer present', () => {
    index.indexDocument(1, 'deadlock detection');
    expect(index.search('deadlock')).toEqual([1]);

    index.indexDocument(1, 'buffer replacement');
    expect(index.search('deadlock')).toEqual([]);
    expect(index.search('buffer')).toEqual([1]);
  });

  test('removing a document drops all of its postings', () => {
    index.indexDocument(1, 'alpha bravo');
    index.indexDocument(2, 'alpha charlie');

    index.removeDocument(1);
    expect(index.search('alpha')).toEqual([2]);
    expect(index.search('bravo')).toEqual([]);
  });

  test('prefix search uses the leaf chain', () => {
    index.indexDocument(1, 'transaction');
    index.indexDocument(2, 'transactional');
    index.indexDocument(3, 'translate');
    index.indexDocument(4, 'buffer');

    expect(index.searchPrefix('transac')).toEqual([1, 2]);
    expect(index.searchPrefix('trans')).toEqual([1, 2, 3]);
  });

  test('full scan returns the same answer as the index', () => {
    const documents = [
      { docId: 1, text: 'write ahead logging' },
      { docId: 2, text: 'two phase locking' },
      { docId: 3, text: 'logging and recovery' }
    ];
    documents.forEach((doc) => index.indexDocument(doc.docId, doc.text));

    expect(index.fullScan('logging', documents)).toEqual(index.search('logging'));
  });

  test('beats the full scan by at least 2x over 100 documents', () => {
    const documents = [];
    for (let docId = 1; docId <= 120; docId += 1) {
      const text = `document ${docId} discusses concurrency control scheduling buffer management `
        + `and indexing with filler text ${'lorem ipsum dolor sit amet '.repeat(8)}`
        + (docId === 77 ? ' rarekeyword' : '');
      documents.push({ docId, text });
      index.indexDocument(docId, text);
    }

    const result = index.benchmark('rarekeyword', documents, 30);
    expect(result.resultsMatch).toBe(true);
    expect(result.speedup).toBeGreaterThan(2);
  });

  test('round-trips through index.dat', () => {
    index.indexDocument(1, 'persistence of the inverted index');
    index.indexDocument(2, 'index persistence check');
    const written = index.persist();

    const reloaded = new IndexManager({ indexFile: path.join(dataDir, 'index.dat'), order: 4 });
    expect(reloaded.load()).toBe(written);
    expect(reloaded.search('persistence')).toEqual([1, 2]);
    expect(reloaded.search('inverted')).toEqual([1]);
    expect(reloaded.tree.validate().valid).toBe(true);
  });

  test('loading a missing file is a no-op', () => {
    expect(index.load()).toBe(0);
  });
});
