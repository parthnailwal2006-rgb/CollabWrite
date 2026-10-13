/**
 * Demo 7 - Buffer Pool and Page Replacement (phases.md Phase 4)
 *
 * Shows the LRU page cache doing its job: a working set that fits in the pool
 * is served almost entirely from memory, while a scan larger than the pool
 * evicts on nearly every access. The second case is the classic pathological
 * pattern for LRU, and seeing the hit ratio collapse is the point.
 */

'use strict';

const { withEngine, section, step, table, runDemo } = require('./harness');

const FRAMES = 4;

async function main() {
  const { engine, dispose } = await withEngine({ bufferPool: { frames: FRAMES } });

  try {
    section('Setup');
    const body = 'page filler text '.repeat(260);
    await engine.createDocument({ docId: 1, title: 'Large Document' });
    await engine.submitEdit({ docId: 1, operation: { type: 'insert', position: 0, content: body.repeat(8) } });

    const pages = engine.storage.getDocumentPages(1);
    step(`Buffer pool holds ${FRAMES} frames; the document occupies ${pages.length} pages.`);

    // --------------------------------------------------------------------
    section(`Case A - working set of ${Math.min(2, pages.length)} pages (fits in the pool)`);
    engine.bufferPool.invalidateAll();
    engine.bufferPool.resetStats();

    const hotPages = pages.slice(0, Math.min(2, pages.length));
    for (let round = 0; round < 10; round += 1) {
      for (const pageId of hotPages) {
        engine.bufferPool.fetchPage(pageId);
        engine.bufferPool.unpinPage(pageId, false);
      }
    }
    const fitting = engine.bufferPool.getStats();
    table([{
      accesses: fitting.hits + fitting.misses,
      hits: fitting.hits,
      misses: fitting.misses,
      evictions: fitting.evictions,
      hitRatio: fitting.hitRatio
    }]);
    step('Every page after the first touch is already resident, so misses stay flat.');

    // --------------------------------------------------------------------
    if (pages.length > FRAMES) {
      section(`Case B - repeated scan of all ${pages.length} pages (exceeds the pool)`);
      engine.bufferPool.invalidateAll();
      engine.bufferPool.resetStats();

      for (let round = 0; round < 6; round += 1) {
        for (const pageId of pages) {
          engine.bufferPool.fetchPage(pageId);
          engine.bufferPool.unpinPage(pageId, false);
        }
      }
      const thrashing = engine.bufferPool.getStats();
      table([{
        accesses: thrashing.hits + thrashing.misses,
        hits: thrashing.hits,
        misses: thrashing.misses,
        evictions: thrashing.evictions,
        hitRatio: thrashing.hitRatio
      }]);
      step('A cyclic scan larger than the pool evicts exactly the page needed next.');
      step('This is the known worst case for LRU, not a bug in the implementation.');
    } else {
      step('Document did not grow beyond the pool size; skipping the thrashing case.');
    }

    // --------------------------------------------------------------------
    section('Pin semantics');
    engine.bufferPool.invalidateAll();
    engine.bufferPool.resetStats();

    const pinned = pages.slice(0, Math.min(FRAMES, pages.length));
    for (const pageId of pinned) engine.bufferPool.fetchPage(pageId); // left pinned
    step(`Pinned ${pinned.length} page(s); pin counts: ${pinned.map((p) => engine.bufferPool.pinCount(p)).join(', ')}`);

    if (pages.length > FRAMES) {
      try {
        engine.bufferPool.fetchPage(pages[FRAMES]);
        throw new Error('A pinned page was evicted, which breaks the pin invariant');
      } catch (error) {
        if (error.name !== 'BufferPoolFullError') throw error;
        step(`Fetching one more page failed with ${error.name}, as it must: pinned pages are never evicted.`);
      }
    }
    for (const pageId of pinned) engine.bufferPool.unpinPage(pageId, false);

    section('Dirty page write-back');
    engine.bufferPool.invalidateAll();
    const target = pages[0];
    const page = engine.bufferPool.fetchPage(target);
    const originalCount = page.recordCount;
    engine.bufferPool.unpinPage(target, true);

    step(`Page ${target} marked dirty (records: ${originalCount}); flushing ...`);
    step(`flushPage wrote the page: ${engine.bufferPool.flushPage(target)}`);
    step(`A second flush is a no-op: ${engine.bufferPool.flushPage(target)}`);
  } finally {
    await dispose();
  }
}

runDemo('DEMO 7 - BUFFER POOL AND LRU REPLACEMENT', main);
