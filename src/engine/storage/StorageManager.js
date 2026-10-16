/**
 * CollabWrite - Storage Manager (Phase 3)
 *
 * CONCEPT
 *   The storage manager owns the only file descriptor into documents.dat. It
 *   turns a page identifier into a byte offset, performs the read or write,
 *   and knows nothing about transactions, locks or caching. Keeping it that
 *   narrow is what lets the buffer pool sit cleanly on top of it.
 *
 * DATA STRUCTURES
 *   Page Directory (design.md section 3) - maps docId to the ordered list of
 *   pageIds that hold the document. It lives in the first
 *   `config.storage.directoryPages` pages of documents.dat so the mapping is
 *   recovered by reading the head of the file:
 *
 *     uint32 entryCount
 *     repeated entryCount times:
 *       uint32 docId
 *       uint16 pageCount
 *       uint32 pageId * pageCount
 *
 * ALGORITHM
 *   readPage(id)  : seek to (id * pageSize), read pageSize bytes, verify CRC.
 *   writePage(p)  : serialize (recomputing CRC), seek, write.
 *   allocatePage  : extend the file by one page, append it to the directory.
 *
 * TRADE-OFF
 *   Synchronous fs calls are used deliberately. The buffer pool and WAL both
 *   need a strict happens-before ordering between writes, and synchronous I/O
 *   makes that ordering obvious in the code rather than hidden in a promise
 *   chain. The data volumes in this project are small enough that the blocking
 *   cost is irrelevant.
 */

'use strict';

const fs = require('fs');

const { Page } = require('./Page');
const { openReadWrite } = require('./openFile');
const { createLogger } = require('../../config/logger');

const log = createLogger('StorageManager');

class DocumentNotFoundError extends Error {
  constructor(docId) {
    super(`Document ${docId} does not exist in the page directory`);
    this.name = 'DocumentNotFoundError';
    this.docId = docId;
  }
}

class StorageManager {
  /**
   * @param {object} options
   * @param {string} options.dataFile - Path to documents.dat.
   * @param {number} options.pageSize - Fixed page size in bytes.
   * @param {number} options.directoryPages - Pages reserved for the page directory.
   */
  constructor({ dataFile, pageSize, directoryPages }) {
    this.dataFile = dataFile;
    this.pageSize = pageSize;
    this.directoryPages = directoryPages;
    this.fd = null;
    /** @type {Map<number, number[]>} docId -> pageIds */
    this.directory = new Map();
    this.opened = false;
  }

  /** @returns {number} Total pages currently in the file, directory included. */
  get pageCount() {
    if (!this.opened) return 0;
    return Math.floor(fs.fstatSync(this.fd).size / this.pageSize);
  }

  /** Opens (creating if needed) documents.dat and loads the page directory. */
  open() {
    if (this.opened) return;
    this.fd = openReadWrite(this.dataFile);
    this.opened = true;

    const size = fs.fstatSync(this.fd).size;
    if (size === 0) {
      // Reserve the directory region up front so page 0 of the data area never
      // collides with it.
      fs.ftruncateSync(this.fd, this.directoryPages * this.pageSize);
      this.flushDirectory();
    } else {
      this.loadDirectory();
    }
    log.info('Storage opened', { file: this.dataFile, pages: this.pageCount });
  }

  /** Closes the underlying file descriptor. */
  close() {
    if (!this.opened) return;
    fs.closeSync(this.fd);
    this.fd = null;
    this.opened = false;
  }

  assertOpen() {
    if (!this.opened) throw new Error('StorageManager is not open; call open() first');
  }

  // ---------------------------------------------------------------------
  // Page directory
  // ---------------------------------------------------------------------

  /** Reads the directory region and rebuilds the in-memory map. */
  loadDirectory() {
    const region = Buffer.alloc(this.directoryPages * this.pageSize);
    fs.readSync(this.fd, region, 0, region.length, 0);

    this.directory.clear();
    const entryCount = region.readUInt32LE(0);
    let offset = 4;
    for (let i = 0; i < entryCount; i += 1) {
      const docId = region.readUInt32LE(offset);
      const pageCount = region.readUInt16LE(offset + 4);
      offset += 6;
      const pageIds = [];
      for (let p = 0; p < pageCount; p += 1) {
        pageIds.push(region.readUInt32LE(offset));
        offset += 4;
      }
      this.directory.set(docId, pageIds);
    }
  }

  /** Serializes the in-memory directory back to the head of the file. */
  flushDirectory() {
    this.assertOpen();
    const region = Buffer.alloc(this.directoryPages * this.pageSize);
    region.writeUInt32LE(this.directory.size, 0);

    let offset = 4;
    for (const [docId, pageIds] of this.directory) {
      const needed = 6 + pageIds.length * 4;
      if (offset + needed > region.length) {
        throw new Error(
          `Page directory overflow: increase storage.directoryPages (currently ${this.directoryPages})`
        );
      }
      region.writeUInt32LE(docId, offset);
      region.writeUInt16LE(pageIds.length, offset + 4);
      offset += 6;
      for (const pageId of pageIds) {
        region.writeUInt32LE(pageId, offset);
        offset += 4;
      }
    }
    fs.writeSync(this.fd, region, 0, region.length, 0);
  }

  // ---------------------------------------------------------------------
  // Document and page lifecycle
  // ---------------------------------------------------------------------

  /**
   * Registers a document and gives it one empty page.
   * @param {number} docId
   * @returns {number} The first page identifier of the document.
   */
  createDocument(docId) {
    this.assertOpen();
    if (this.directory.has(docId)) {
      return this.directory.get(docId)[0];
    }
    this.directory.set(docId, []);
    const pageId = this.allocatePage(docId);
    log.debug('Document created', { docId, pageId });
    return pageId;
  }

  /** @param {number} docId @returns {boolean} */
  hasDocument(docId) {
    return this.directory.has(docId);
  }

  /** @returns {number[]} Every registered document identifier. */
  listDocuments() {
    return [...this.directory.keys()];
  }

  /**
   * @param {number} docId
   * @returns {number[]} Ordered page identifiers belonging to the document.
   * @throws {DocumentNotFoundError}
   */
  getDocumentPages(docId) {
    const pages = this.directory.get(docId);
    if (!pages) throw new DocumentNotFoundError(docId);
    return [...pages];
  }

  /**
   * Extends the file by one page and attaches it to a document.
   * @param {number} docId
   * @returns {number} The new page identifier.
   */
  allocatePage(docId) {
    this.assertOpen();
    if (!this.directory.has(docId)) throw new DocumentNotFoundError(docId);

    const pageId = this.pageCount;
    fs.ftruncateSync(this.fd, (pageId + 1) * this.pageSize);
    this.writePage(new Page(pageId, this.pageSize));

    this.directory.get(docId).push(pageId);
    this.flushDirectory();
    return pageId;
  }

  // ---------------------------------------------------------------------
  // Raw page I/O
  // ---------------------------------------------------------------------

  /**
   * Grows the file so that `pageId` is addressable. Recovery needs this when
   * the log mentions a page that was allocated just before the crash and
   * never made it into the file.
   *
   * @param {number} pageId
   */
  ensureCapacity(pageId) {
    this.assertOpen();
    const required = (pageId + 1) * this.pageSize;
    if (fs.fstatSync(this.fd).size < required) {
      fs.ftruncateSync(this.fd, required);
    }
  }

  /**
   * Reads a page and validates its checksum.
   * @param {number} pageId
   * @returns {Page}
   */
  readPage(pageId) {
    this.assertOpen();
    if (pageId < this.directoryPages) {
      throw new Error(`Page ${pageId} is inside the reserved directory region`);
    }
    const image = Buffer.alloc(this.pageSize);
    const read = fs.readSync(this.fd, image, 0, this.pageSize, pageId * this.pageSize);
    if (read !== this.pageSize) {
      throw new Error(`Short read on page ${pageId}: expected ${this.pageSize} bytes, got ${read}`);
    }
    return Page.deserialize(image, this.pageSize);
  }

  /**
   * Writes a page back to disk with a recomputed checksum.
   * @param {Page} page
   */
  writePage(page) {
    this.assertOpen();
    const image = page.serialize();
    fs.writeSync(this.fd, image, 0, image.length, page.pageId * this.pageSize);
    page.dirty = false;
  }

  /**
   * Overwrites a page from a raw image. Used by the recovery manager, which
   * replays WAL before- and after-images that are already full page buffers.
   * @param {number} pageId
   * @param {Buffer} image
   */
  writePageImage(pageId, image) {
    this.assertOpen();
    const page = Page.deserialize(image, this.pageSize);
    this.writePage(page);
  }

  /** Forces buffered file data to the physical device. */
  sync() {
    this.assertOpen();
    fs.fsyncSync(this.fd);
  }

  // ---------------------------------------------------------------------
  // Convenience helpers used by the engine and the index manager
  // ---------------------------------------------------------------------

  /**
   * Reads every record of a document in page order.
   * @param {number} docId
   * @returns {Array<{recordId:number, version:number, payload:Buffer, pageId:number}>}
   */
  readDocumentRecords(docId) {
    const records = [];
    for (const pageId of this.getDocumentPages(docId)) {
      const page = this.readPage(pageId);
      for (const record of page.listRecords()) {
        records.push({ ...record, pageId });
      }
    }
    return records;
  }
}

module.exports = { StorageManager, DocumentNotFoundError };
