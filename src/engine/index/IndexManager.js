/**
 * CollabWrite - Index Manager (Phase 10)
 *
 * CONCEPT
 *   An inverted index maps each keyword to the set of documents containing
 *   it. Backing that map with a B+-Tree turns keyword search from a scan of
 *   every document into a single O(log N) descent, and the same structure
 *   answers prefix and range queries by walking the leaf chain.
 *
 * ALGORITHM
 *   indexDocument(docId, text)
 *     1. Remove the document from every keyword it was previously filed
 *        under, so a re-index never leaves stale postings behind.
 *     2. Tokenise the text, fold to lower case, drop stop words and tokens
 *        shorter than two characters.
 *     3. Insert keyword -> docId for each distinct token.
 *
 * PERSISTENCE (design.md section 11)
 *   index.dat stores the leaf level - the (keyword, docIds) postings - and the
 *   internal nodes are rebuilt by re-inserting on load. Internal nodes are a
 *   derived structure: they carry no information that the leaves do not
 *   already determine, so serialising them would mean persisting data that
 *   can only go stale. Load cost is O(N log N) rather than O(N), which for an
 *   index of this size is microseconds.
 *
 *   Format:
 *     uint32 entryCount
 *     repeated:
 *       uint16 keyLength, key bytes (utf8)
 *       uint32 docCount, uint32 docId * docCount
 *
 * BENCHMARK MODE
 *   fullScan() implements the O(N) baseline the index is measured against:
 *   read every document, tokenise it, test for the keyword. prd.md section 9
 *   requires the indexed path to be at least twice as fast over 100+
 *   documents; benchmark() produces that number.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { BPlusTree } = require('./BPlusTree');
const { createLogger } = require('../../config/logger');

const log = createLogger('IndexManager');

/** Words carried by nearly every document, so they discriminate nothing. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'this', 'but', 'or', 'not', 'they', 'you', 'we'
]);

class IndexManager {
  /**
   * @param {object} options
   * @param {string} options.indexFile - Path to index.dat.
   * @param {number} [options.order] - B+-Tree fanout.
   */
  constructor({ indexFile, order = 4 }) {
    this.indexFile = indexFile;
    this.tree = new BPlusTree(order);
    /** @type {Map<number, Set<string>>} docId -> keywords, for re-indexing. */
    this.documentKeywords = new Map();
    this.enabled = true;
    this.stats = { documentsIndexed: 0, lookups: 0, fullScans: 0 };
  }

  /**
   * Splits text into index keywords.
   * @param {string} text
   * @returns {Set<string>}
   */
  static tokenize(text) {
    const tokens = new Set();
    if (!text) return tokens;
    for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 2) continue;
      if (STOP_WORDS.has(raw)) continue;
      tokens.add(raw);
    }
    return tokens;
  }

  /**
   * Indexes or re-indexes a document.
   * @param {number} docId
   * @param {string} text
   * @returns {number} Keyword count for the document.
   */
  indexDocument(docId, text) {
    this.removeDocument(docId);

    const keywords = IndexManager.tokenize(text);
    for (const keyword of keywords) {
      this.tree.insert(keyword, docId);
    }
    this.documentKeywords.set(docId, keywords);
    this.stats.documentsIndexed += 1;
    return keywords.size;
  }

  /**
   * Drops every posting for a document.
   * @param {number} docId
   * @returns {number} Postings removed.
   */
  removeDocument(docId) {
    const previous = this.documentKeywords.get(docId);
    if (!previous) return 0;
    for (const keyword of previous) {
      this.tree.delete(keyword, docId);
    }
    this.documentKeywords.delete(docId);
    return previous.size;
  }

  /**
   * Indexed point lookup.
   * @param {string} keyword
   * @returns {number[]} Matching document ids, ascending.
   */
  search(keyword) {
    this.stats.lookups += 1;
    const key = String(keyword || '').toLowerCase();
    return this.tree.search(key).sort((a, b) => a - b);
  }

  /**
   * Indexed prefix search, implemented as a range scan over the leaf chain.
   * This is the operation a hash index could not serve.
   *
   * @param {string} prefix
   * @returns {number[]} Matching document ids, ascending.
   */
  searchPrefix(prefix) {
    this.stats.lookups += 1;
    const from = String(prefix || '').toLowerCase();
    if (!from) return [];
    // '￿' sorts after any character that can appear in a keyword, so
    // [from, from + '￿'] is exactly the set of keys beginning with from.
    const matches = this.tree.rangeScan(from, `${from}￿`);
    const docIds = new Set();
    for (const entry of matches) {
      for (const docId of entry.docIds) docIds.add(docId);
    }
    return [...docIds].sort((a, b) => a - b);
  }

  /**
   * The unindexed baseline: tokenise every document and test for the keyword.
   *
   * @param {string} keyword
   * @param {Array<{docId:number, text:string}>} documents
   * @returns {number[]} Matching document ids, ascending.
   */
  fullScan(keyword, documents) {
    this.stats.fullScans += 1;
    const key = String(keyword || '').toLowerCase();
    const matches = [];
    for (const doc of documents) {
      if (IndexManager.tokenize(doc.text).has(key)) matches.push(doc.docId);
    }
    return matches.sort((a, b) => a - b);
  }

  /**
   * Times the indexed path against the full scan.
   *
   * @param {string} keyword
   * @param {Array<{docId:number, text:string}>} documents
   * @param {number} [iterations] - Repeats, to lift the measurement above
   *        timer granularity.
   * @returns {{keyword:string, documents:number, iterations:number,
   *            indexedMs:number, fullScanMs:number, speedup:number,
   *            resultsMatch:boolean, treeHeight:number}}
   */
  benchmark(keyword, documents, iterations = 50) {
    let indexedResult = [];
    const indexStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) indexedResult = this.search(keyword);
    const indexedNs = Number(process.hrtime.bigint() - indexStart);

    let scanResult = [];
    const scanStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) scanResult = this.fullScan(keyword, documents);
    const scanNs = Number(process.hrtime.bigint() - scanStart);

    const indexedMs = indexedNs / 1e6;
    const fullScanMs = scanNs / 1e6;

    return {
      keyword,
      documents: documents.length,
      iterations,
      indexedMs: Number(indexedMs.toFixed(4)),
      fullScanMs: Number(fullScanMs.toFixed(4)),
      speedup: indexedMs === 0 ? Infinity : Number((fullScanMs / indexedMs).toFixed(2)),
      resultsMatch: JSON.stringify(indexedResult) === JSON.stringify(scanResult),
      treeHeight: this.tree.height
    };
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  /** Writes the leaf level to index.dat. */
  persist() {
    const entries = this.tree.entries();
    const chunks = [];

    const header = Buffer.alloc(4);
    header.writeUInt32LE(entries.length, 0);
    chunks.push(header);

    for (const entry of entries) {
      const key = Buffer.from(entry.key, 'utf8');
      const block = Buffer.alloc(2 + key.length + 4 + entry.docIds.length * 4);
      let offset = 0;
      block.writeUInt16LE(key.length, offset); offset += 2;
      key.copy(block, offset); offset += key.length;
      block.writeUInt32LE(entry.docIds.length, offset); offset += 4;
      for (const docId of entry.docIds) {
        block.writeUInt32LE(docId, offset);
        offset += 4;
      }
      chunks.push(block);
    }

    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    fs.writeFileSync(this.indexFile, Buffer.concat(chunks));
    log.debug('Index persisted', { entries: entries.length, file: this.indexFile });
    return entries.length;
  }

  /**
   * Rebuilds the tree from index.dat.
   * @returns {number} Entries loaded.
   */
  load() {
    if (!fs.existsSync(this.indexFile)) return 0;
    const data = fs.readFileSync(this.indexFile);
    if (data.length < 4) return 0;

    this.tree = new BPlusTree(this.tree.maxKeys);
    this.documentKeywords.clear();

    const entryCount = data.readUInt32LE(0);
    let offset = 4;
    for (let i = 0; i < entryCount; i += 1) {
      const keyLength = data.readUInt16LE(offset); offset += 2;
      const key = data.toString('utf8', offset, offset + keyLength); offset += keyLength;
      const docCount = data.readUInt32LE(offset); offset += 4;

      for (let d = 0; d < docCount; d += 1) {
        const docId = data.readUInt32LE(offset); offset += 4;
        this.tree.insert(key, docId);
        if (!this.documentKeywords.has(docId)) this.documentKeywords.set(docId, new Set());
        this.documentKeywords.get(docId).add(key);
      }
    }
    log.info('Index loaded', { entries: entryCount, documents: this.documentKeywords.size });
    return entryCount;
  }

  /**
   * @returns {{keywords:number, documents:number, height:number,
   *            lookups:number, fullScans:number, tree:object}}
   */
  getStats() {
    return {
      keywords: this.tree.size,
      documents: this.documentKeywords.size,
      height: this.tree.height,
      ...this.stats,
      tree: { ...this.tree.stats }
    };
  }
}

module.exports = { IndexManager, STOP_WORDS };
