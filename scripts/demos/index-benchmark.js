/**
 * Demo 5 - Indexing Comparison (prd.md section 10, item 5)
 *
 * Builds a corpus of documents, then answers the same keyword query twice:
 * once through the B+-Tree, once by scanning every document. prd.md section 9
 * sets the bar at a 2x speed-up over 100 or more documents.
 *
 * The comparison is only honest if both paths return the same answer, so the
 * benchmark asserts that too.
 */

'use strict';

const { withEngine, section, step, table, runDemo } = require('./harness');

const CORPUS_SIZE = 150;
const TOPICS = [
  'scheduling policies and worker dispatch',
  'buffer pool replacement and page faults',
  'two phase locking and serialisability',
  'write ahead logging and crash recovery',
  'balanced tree indexing and range scans'
];

async function main() {
  const { engine, dispose } = await withEngine({ index: { order: 8 } });

  try {
    section(`Building a corpus of ${CORPUS_SIZE} documents`);
    for (let docId = 1; docId <= CORPUS_SIZE; docId += 1) {
      const topic = TOPICS[docId % TOPICS.length];
      const filler = `entry ${docId} covering ${topic} with supporting discussion `.repeat(4);
      const body = docId === 101 ? `${filler} semaphoreinversion` : filler;

      await engine.createDocument({ docId, title: `Note ${docId}` });
      await engine.submitEdit({ docId, operation: { type: 'insert', position: 0, content: body } });
    }

    const indexStats = engine.indexManager.getStats();
    table([{
      documents: indexStats.documents,
      distinctKeywords: indexStats.keywords,
      treeHeight: indexStats.height,
      nodeSplits: indexStats.tree.splits
    }]);
    step(`A tree of height ${indexStats.height} reaches any keyword in ${indexStats.height} node visits,`);
    step(`whereas a full scan must read all ${CORPUS_SIZE} documents.`);

    section('Benchmark: indexed lookup versus full scan');
    const rows = [];
    for (const keyword of ['semaphoreinversion', 'recovery', 'indexing', 'scheduling']) {
      const result = await engine.benchmarkSearch(keyword, 50);
      rows.push({
        keyword: result.keyword,
        matches: engine.indexManager.search(keyword).length,
        indexedMs: result.indexedMs,
        fullScanMs: result.fullScanMs,
        speedup: `${result.speedup}x`,
        sameAnswer: result.resultsMatch
      });
    }
    table(rows);

    section('Verification');
    const rare = rows[0];
    step(`Rare keyword speed-up: ${rare.speedup} over ${CORPUS_SIZE} documents (target: above 2x).`);
    step(`Both paths agree on every keyword: ${rows.every((row) => row.sameAnswer)}`);

    if (!rows.every((row) => row.sameAnswer)) {
      throw new Error('The index and the full scan disagree, so the comparison is meaningless');
    }
    if (Number.parseFloat(rare.speedup) <= 2) {
      throw new Error(`Index speed-up ${rare.speedup} did not meet the 2x target`);
    }

    section('Prefix search, which a hash index could not serve');
    table([
      { query: 'recov*', matches: engine.indexManager.searchPrefix('recov').length },
      { query: 'sched*', matches: engine.indexManager.searchPrefix('sched').length },
      { query: 'index*', matches: engine.indexManager.searchPrefix('index').length }
    ]);
  } finally {
    await dispose();
  }
}

runDemo('DEMO 5 - B+-TREE INDEX VERSUS FULL SCAN', main);
