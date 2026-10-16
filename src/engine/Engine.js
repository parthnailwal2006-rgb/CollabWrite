/**
 * CollabWrite - Academic Engine (composition root)
 *
 * This module wires the ten engine components into the pipeline
 * architecture.md section 4 describes, and owns the one piece of policy that
 * does not belong to any single component: how a document's text is laid out
 * across pages.
 *
 * DOCUMENT LAYOUT
 *   A document occupies a chain of pages, listed in the storage manager's page
 *   directory. Each page carries one CONTENT record holding a slice of the
 *   document text; the first page additionally carries a METADATA record.
 *
 *     page[0] : record 0 = metadata JSON {title, length, updatedAt}
 *               record 1 = text chunk 0
 *     page[n] : record 1 = text chunk n
 *
 *   The document text is the concatenation of the chunks in page order. The
 *   document version is the record header version of the metadata record, and
 *   it is bumped once per committed edit. Keeping the version in a record
 *   header rather than inventing a new page-header field is what lets the
 *   on-disk layout stay exactly as design.md section 3 specifies it.
 *
 * LOCKING POLICY FOR EDITS
 *   An edit transaction takes an exclusive lock on every page of the target
 *   document, acquired in ascending page order.
 *
 *   Taking every page matters because an insert near the start of a document
 *   shifts every later chunk, so an edit is rarely confined to one page.
 *   Acquiring in ascending order matters more: a total order over lock
 *   acquisition makes the edit path deadlock-free by construction, which is
 *   the standard prevention argument - a cycle in the wait-for graph would
 *   require some transaction to request a lower-numbered page while holding a
 *   higher-numbered one, and none ever does.
 *
 *   The deadlock detector is therefore not load-bearing for editing. It exists
 *   for the general transaction API, where a caller may lock several documents
 *   in any order, and that is the case scripts/demos/deadlock-demo.js
 *   exercises. Saying this plainly is better than pretending the common path
 *   is at risk: prevention where it is cheap, detection where it is not.
 *
 *   The cost is that two edits to the same document serialise. Edits to
 *   different documents run fully concurrently, bounded only by the worker
 *   pool. design.md section 17 records the trade-off.
 *
 * REQUEST PATH (architecture.md section 4)
 *   submitEdit -> Scheduler queue -> Worker -> TransactionManager
 *              -> LockManager / ConflictResolver / BufferPool / WAL
 *              -> commit -> MessageQueue -> CollaborationManager -> clients
 */

'use strict';

const { StorageManager } = require('./storage/StorageManager');
const { PAGE_HEADER_SIZE, RECORD_HEADER_SIZE } = require('./storage/Page');
const { BufferPool } = require('./buffer/BufferPool');
const { LockManager, LOCK_MODES } = require('./lock/LockManager');
const { DeadlockDetector } = require('./lock/DeadlockDetector');
const { WAL } = require('./recovery/WAL');
const { RecoveryManager } = require('./recovery/RecoveryManager');
const { TransactionManager } = require('./transaction/TransactionManager');
const { ConflictResolver } = require('./conflict/ConflictResolver');
const { Scheduler } = require('./scheduler/Scheduler');
const { MessageQueue } = require('./messaging/MessageQueue');
const { CollaborationManager } = require('./messaging/CollaborationManager');
const { IndexManager } = require('./index/IndexManager');
const { Metrics } = require('./metrics/Metrics');
const defaultConfig = require('../config/engine.config');
const { createLogger } = require('../config/logger');

const log = createLogger('Engine');

const METADATA_RECORD_ID = 0;
const CONTENT_RECORD_ID = 1;

class DocumentNotFound extends Error {
  constructor(docId) {
    super(`Document ${docId} not found`);
    this.name = 'DocumentNotFound';
    this.code = 'DOCUMENT_NOT_FOUND';
    this.docId = docId;
  }
}

class Engine {
  /**
   * @param {object} [config] - Overrides for src/config/engine.config.js.
   */
  constructor(config = {}) {
    this.config = {
      ...defaultConfig,
      ...config,
      storage: { ...defaultConfig.storage, ...(config.storage || {}) },
      bufferPool: { ...defaultConfig.bufferPool, ...(config.bufferPool || {}) },
      lock: { ...defaultConfig.lock, ...(config.lock || {}) },
      scheduler: { ...defaultConfig.scheduler, ...(config.scheduler || {}) },
      index: { ...defaultConfig.index, ...(config.index || {}) },
      recovery: { ...defaultConfig.recovery, ...(config.recovery || {}) },
      metrics: { ...defaultConfig.metrics, ...(config.metrics || {}) }
    };

    this.storage = new StorageManager(this.config.storage);
    this.bufferPool = new BufferPool(this.storage, this.config.bufferPool);
    this.wal = new WAL(this.config.recovery);
    this.lockManager = new LockManager({ timeoutMs: this.config.lock.timeoutMs });
    this.conflictResolver = new ConflictResolver();
    this.transactionManager = new TransactionManager({
      storage: this.storage,
      bufferPool: this.bufferPool,
      lockManager: this.lockManager,
      wal: this.wal,
      conflictResolver: this.conflictResolver
    });
    this.recoveryManager = new RecoveryManager({
      wal: this.wal,
      storage: this.storage,
      bufferPool: this.bufferPool
    });
    this.deadlockDetector = new DeadlockDetector(this.lockManager, {
      intervalMs: this.config.lock.deadlockIntervalMs,
      onVictim: (txId, cycle) => this.transactionManager.markDeadlockVictim(txId, cycle)
    });
    this.scheduler = new Scheduler(this.config.scheduler);
    this.messageQueue = new MessageQueue({ capacity: 4096 });
    this.collaborationManager = new CollaborationManager({ messageQueue: this.messageQueue });
    this.indexManager = new IndexManager(this.config.index);
    this.metrics = new Metrics(this.config.metrics);

    this.started = false;
    this.recoveryReport = null;
  }

  /**
   * Boots the engine: open files, run crash recovery, rebuild the index,
   * then start the scheduler and the deadlock sweep.
   *
   * Recovery runs before anything else is allowed to touch a page. That
   * ordering is the whole contract of a recovery manager.
   *
   * @returns {Promise<object>} The recovery report.
   */
  async start() {
    if (this.started) return this.recoveryReport;

    this.storage.open();
    this.wal.open();

    this.recoveryReport = this.recoveryManager.recover();
    this.metrics.record('recovery.durationMs', this.recoveryReport.durationMs, {
      redone: this.recoveryReport.redone,
      undone: this.recoveryReport.undone
    });

    this.indexManager.load();
    this.reindexAll();

    this.scheduler.start();
    this.deadlockDetector.start();
    this.started = true;

    log.info('Engine started', {
      documents: this.storage.listDocuments().length,
      recovery: this.recoveryReport
    });
    return this.recoveryReport;
  }

  /** Flushes everything and releases resources. */
  async stop() {
    if (!this.started) return;
    this.scheduler.stop();
    this.deadlockDetector.stop();
    this.collaborationManager.close();

    this.bufferPool.flushAll();
    this.indexManager.persist();
    this.storage.sync();
    this.storage.close();
    this.wal.close();
    this.lockManager.reset();
    this.started = false;
    log.info('Engine stopped');
  }

  /**
   * Simulates a crash: drop in-memory state without flushing anything.
   * Used by the recovery demo and the recovery tests.
   */
  simulateCrash() {
    this.scheduler.stop();
    this.deadlockDetector.stop();
    this.bufferPool.invalidateAll();
    this.storage.close();
    this.wal.close();
    this.started = false;
    log.warn('Simulated crash: in-memory state discarded without flushing');
  }

  // ---------------------------------------------------------------------
  // Page layout helpers
  // ---------------------------------------------------------------------

  /**
   * Bytes available for the text chunk on a page.
   * @param {number} pageIndex - Position of the page within the document.
   * @param {number} metadataLength - Serialized metadata size, page 0 only.
   * @returns {number}
   */
  chunkCapacity(pageIndex, metadataLength = 0) {
    const overhead = pageIndex === 0
      ? RECORD_HEADER_SIZE + metadataLength + RECORD_HEADER_SIZE
      : RECORD_HEADER_SIZE;
    return this.config.storage.pageSize - PAGE_HEADER_SIZE - overhead;
  }

  /**
   * Splits text into page-sized chunks.
   *
   * Chunking is done on bytes, not characters, because the page budget is in
   * bytes. A multi-byte character is never split: the slice point is walked
   * back to a UTF-8 boundary.
   *
   * @param {string} text
   * @param {number} metadataLength
   * @returns {Buffer[]} At least one chunk, possibly empty.
   */
  splitIntoChunks(text, metadataLength) {
    const bytes = Buffer.from(text, 'utf8');
    const chunks = [];
    let offset = 0;
    let pageIndex = 0;

    do {
      const capacity = this.chunkCapacity(pageIndex, metadataLength);
      let end = Math.min(bytes.length, offset + capacity);
      // Walk back off a continuation byte (10xxxxxx) so no character splits.
      while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      chunks.push(bytes.subarray(offset, end));
      offset = end;
      pageIndex += 1;
    } while (offset < bytes.length);

    return chunks;
  }

  /**
   * Reads a document's metadata record.
   * @param {import('./storage/Page').Page} page - The document's first page.
   * @returns {{version:number, metadata:object}}
   */
  static readMetadata(page) {
    const record = page.readRecord(METADATA_RECORD_ID);
    if (!record) return { version: 0, metadata: {} };
    let metadata = {};
    try {
      metadata = JSON.parse(record.payload.toString('utf8'));
    } catch {
      metadata = {};
    }
    return { version: record.version, metadata };
  }

  // ---------------------------------------------------------------------
  // Document operations
  // ---------------------------------------------------------------------

  /**
   * Creates an empty document.
   *
   * @param {object} params
   * @param {number} params.docId
   * @param {string} [params.title]
   * @param {number} [params.ownerId]
   * @returns {Promise<{docId:number, version:number, pages:number[]}>}
   */
  async createDocument({ docId, title = 'Untitled', ownerId = null }) {
    if (this.storage.hasDocument(docId)) {
      throw new Error(`Document ${docId} already exists`);
    }

    const firstPageId = this.storage.createDocument(docId);
    const metadata = { title, ownerId, length: 0, updatedAt: new Date().toISOString() };
    const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');

    const { transaction } = await this.transactionManager.runInTransaction(
      { docId, operation: 'createDocument' },
      async (tx) => {
        await this.transactionManager.write(tx, docId, firstPageId, (page) => {
          page.rewriteRecords([
            { recordId: METADATA_RECORD_ID, version: 1, payload: metadataBytes },
            { recordId: CONTENT_RECORD_ID, version: 1, payload: Buffer.alloc(0) }
          ]);
        });
      }
    );

    this.indexManager.indexDocument(docId, '');
    log.info('Document created', { docId, title, txId: transaction.txId });
    return { docId, version: 1, pages: this.storage.getDocumentPages(docId) };
  }

  /**
   * Reads a document's full text under shared locks.
   *
   * @param {number} docId
   * @returns {Promise<{docId:number, version:number, title:string, text:string, pages:number[]}>}
   */
  async readDocument(docId) {
    if (!this.storage.hasDocument(docId)) throw new DocumentNotFound(docId);

    const pages = this.storage.getDocumentPages(docId);
    const tx = this.transactionManager.begin({ docId, operation: 'readDocument' });
    try {
      let text = '';
      let version = 0;
      let title = 'Untitled';

      for (const pageId of pages) {
        await this.transactionManager.acquireLock(tx, docId, pageId, LOCK_MODES.SHARED);
        const page = this.bufferPool.fetchPage(pageId);
        try {
          if (pageId === pages[0]) {
            const meta = Engine.readMetadata(page);
            version = meta.version;
            title = meta.metadata.title || title;
          }
          const content = page.readRecord(CONTENT_RECORD_ID);
          if (content) text += content.payload.toString('utf8');
        } finally {
          this.bufferPool.unpinPage(pageId, false);
        }
      }

      await this.transactionManager.commit(tx);
      return { docId, version, title, text, pages };
    } catch (error) {
      await this.transactionManager.abort(tx, error.message);
      throw error;
    }
  }

  /**
   * Submits an edit through the scheduler. This is the entry point the HTTP
   * and WebSocket layers call; everything below it is engine internals.
   *
   * @param {object} request
   * @param {number} request.docId
   * @param {object} request.operation - {type:'insert'|'delete', position, content?, length?}
   * @param {number} [request.baseVersion] - Document version the client edited
   *        against. Omitting it skips the optimistic check (last write wins).
   * @param {number} [request.userId]
   * @param {string} [request.username]
   * @param {boolean} [request.priority]
   * @returns {Promise<{docId:number, version:number, text:string, transaction:object}>}
   */
  submitEdit({ docId, operation, baseVersion, userId = null, username = null, priority = false }) {
    return this.scheduler.submit(
      { docId, operation: `edit:${operation && operation.type}`, priority, payload: operation },
      async () => this.metrics.time(
        'edit.latencyMs',
        () => this.executeEdit({ docId, operation, baseVersion, userId, username }),
        { docId }
      )
    );
  }

  /**
   * The transactional body of an edit. Runs on a worker.
   *
   * @param {object} request
   * @returns {Promise<object>}
   */
  async executeEdit({ docId, operation, baseVersion, userId, username }) {
    if (!this.storage.hasDocument(docId)) throw new DocumentNotFound(docId);

    const tx = this.transactionManager.begin({ docId, userId, operation: 'edit' });
    try {
      // 1. Growing phase: lock every page of the document, ascending.
      let pages = this.storage.getDocumentPages(docId).sort((a, b) => a - b);
      for (const pageId of pages) {
        await this.transactionManager.acquireLock(tx, docId, pageId, LOCK_MODES.EXCLUSIVE);
      }

      // 2. Read the current state now that it cannot change underneath us.
      const firstPage = this.bufferPool.fetchPage(pages[0]);
      let currentVersion;
      let metadata;
      try {
        const meta = Engine.readMetadata(firstPage);
        currentVersion = meta.version;
        metadata = meta.metadata;
      } finally {
        this.bufferPool.unpinPage(pages[0], false);
      }

      // 3. Optimistic check: did the document move since the client read it?
      if (baseVersion !== undefined && baseVersion !== null) {
        this.conflictResolver.assertNoConflict({
          txId: tx.txId,
          pageId: pages[0],
          expectedVersion: baseVersion,
          actualVersion: currentVersion
        });
      }

      let text = '';
      for (const pageId of pages) {
        const page = this.bufferPool.fetchPage(pageId);
        try {
          const content = page.readRecord(CONTENT_RECORD_ID);
          if (content) text += content.payload.toString('utf8');
        } finally {
          this.bufferPool.unpinPage(pageId, false);
        }
      }

      // 4. Apply the operation and re-chunk.
      const newText = ConflictResolver.applyOperation(text, operation);
      const newVersion = currentVersion + 1;
      const newMetadata = {
        ...metadata,
        length: Buffer.byteLength(newText, 'utf8'),
        updatedAt: new Date().toISOString()
      };
      const metadataBytes = Buffer.from(JSON.stringify(newMetadata), 'utf8');
      const chunks = this.splitIntoChunks(newText, metadataBytes.length);

      // 5. Grow the page chain if the text no longer fits. Newly allocated
      //    pages are locked immediately, still in ascending order because
      //    allocation always appends at the end of the file.
      while (chunks.length > pages.length) {
        const pageId = this.storage.allocatePage(docId);
        await this.transactionManager.acquireLock(tx, docId, pageId, LOCK_MODES.EXCLUSIVE);
        pages.push(pageId);
      }
      pages = pages.sort((a, b) => a - b);

      // 6. Write every page. Pages beyond the chunk count are emptied rather
      //    than freed; reclaiming pages would need a free-space map, which
      //    design.md does not call for.
      for (let i = 0; i < pages.length; i += 1) {
        const pageId = pages[i];
        const chunk = i < chunks.length ? chunks[i] : Buffer.alloc(0);
        await this.transactionManager.write(tx, docId, pageId, (page) => {
          const records = [];
          if (i === 0) {
            records.push({ recordId: METADATA_RECORD_ID, version: newVersion, payload: metadataBytes });
          }
          records.push({ recordId: CONTENT_RECORD_ID, version: newVersion, payload: chunk });
          page.rewriteRecords(records);
        });
      }

      // 7. Shrinking phase.
      const summary = await this.transactionManager.commit(tx);

      // 8. Post-commit side effects: index and broadcast. Both happen after
      //    the commit because neither may resurrect an aborted edit.
      this.indexManager.indexDocument(docId, newText);
      this.messageQueue.publish({
        docId,
        type: 'edit',
        payload: {
          docId,
          version: newVersion,
          operation,
          userId,
          username,
          txId: tx.txId
        }
      });

      this.metrics.record('transaction.lockWaitMs', summary.lockWaitMs, { docId, txId: tx.txId });
      return { docId, version: newVersion, text: newText, transaction: summary };
    } catch (error) {
      await this.transactionManager.abort(tx, error.message);
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  /**
   * Keyword search.
   * @param {string} keyword
   * @param {object} [options]
   * @param {boolean} [options.useIndex] - false forces the O(N) baseline.
   * @returns {Promise<{keyword:string, docIds:number[], usedIndex:boolean, latencyMs:number}>}
   */
  async search(keyword, { useIndex = true } = {}) {
    const startedAt = process.hrtime.bigint();
    const docIds = useIndex
      ? this.indexManager.search(keyword)
      : this.indexManager.fullScan(keyword, await this.loadAllDocuments());
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    this.metrics.record('search.latencyMs', Number(latencyMs.toFixed(4)), { keyword, useIndex });
    return { keyword, docIds, usedIndex: useIndex, latencyMs: Number(latencyMs.toFixed(4)) };
  }

  /**
   * Reads every document's text. Only the full-scan baseline and the index
   * rebuild need this; nothing on the hot path does.
   * @returns {Promise<Array<{docId:number, text:string}>>}
   */
  async loadAllDocuments() {
    const documents = [];
    for (const docId of this.storage.listDocuments()) {
      documents.push({ docId, text: this.readDocumentTextUnlocked(docId) });
    }
    return documents;
  }

  /**
   * Reads a document's text straight from the pages, with no transaction.
   *
   * Only safe at start-up, before the scheduler accepts work, and for the
   * benchmark baseline. Callers that need isolation use readDocument().
   *
   * @param {number} docId
   * @returns {string}
   */
  readDocumentTextUnlocked(docId) {
    let text = '';
    for (const pageId of this.storage.getDocumentPages(docId)) {
      const page = this.storage.readPage(pageId);
      const content = page.readRecord(CONTENT_RECORD_ID);
      if (content) text += content.payload.toString('utf8');
    }
    return text;
  }

  /**
   * Rebuilds the index from the data files. Runs at start-up because the
   * index is a derived structure: after recovery rolled transactions back the
   * persisted index may describe text that no longer exists.
   * @returns {number} Documents indexed.
   */
  reindexAll() {
    let count = 0;
    for (const docId of this.storage.listDocuments()) {
      this.indexManager.indexDocument(docId, this.readDocumentTextUnlocked(docId));
      count += 1;
    }
    return count;
  }

  /**
   * Runs the indexed-versus-full-scan comparison.
   * @param {string} keyword
   * @param {number} [iterations]
   * @returns {Promise<object>}
   */
  async benchmarkSearch(keyword, iterations = 50) {
    return this.indexManager.benchmark(keyword, await this.loadAllDocuments(), iterations);
  }

  // ---------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------

  /** @returns {object} Live statistics from every component. */
  getStats() {
    return {
      started: this.started,
      documents: this.storage.listDocuments().length,
      storage: { pages: this.storage.pageCount, pageSize: this.config.storage.pageSize },
      bufferPool: this.bufferPool.getStats(),
      transactions: this.transactionManager.getStats(),
      locks: this.lockManager.getStats(),
      lockTable: this.lockManager.snapshot(),
      deadlock: this.deadlockDetector.getStats(),
      scheduler: this.scheduler.getMetrics(),
      messageQueue: this.messageQueue.getStats(),
      collaboration: this.collaborationManager.getStats(),
      index: this.indexManager.getStats(),
      conflicts: this.conflictResolver.getStats(),
      recovery: this.recoveryReport,
      metrics: this.metrics.summaryAll()
    };
  }
}

module.exports = {
  Engine,
  DocumentNotFound,
  METADATA_RECORD_ID,
  CONTENT_RECORD_ID
};
