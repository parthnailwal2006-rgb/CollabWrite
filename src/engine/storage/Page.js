/**
 * CollabWrite - Page (Phase 3, Storage Manager)
 *
 * CONCEPT
 *   A database does not read or write individual records from disk; it moves
 *   fixed-size pages. A page is the unit of I/O, the unit of caching in the
 *   buffer pool, and the unit of locking in this engine. Everything above this
 *   file therefore speaks in page identifiers rather than byte offsets.
 *
 * DATA STRUCTURES (design.md section 3)
 *   PageHeader   : uint32 pageId, uint32 checksum, uint8 dirtyFlag,
 *                  uint16 recordCount          -> 11 bytes
 *   RecordHeader : uint32 recordId, uint32 length, uint32 version
 *                  -> 12 bytes, followed by `length` payload bytes
 *
 *   Records are laid out contiguously after the page header. Because each
 *   record header carries its own length, the page can be walked sequentially
 *   without a slot directory - the simplest layout that still demonstrates
 *   record-level addressing.
 *
 * ALGORITHM
 *   Mutations operate on an in-memory Buffer. The checksum is recomputed only
 *   on serialize(), so a caller may perform several record operations and pay
 *   for a single checksum pass.
 */

'use strict';

const PAGE_HEADER_SIZE = 11;
const RECORD_HEADER_SIZE = 12;

const OFFSET_PAGE_ID = 0;
const OFFSET_CHECKSUM = 4;
const OFFSET_DIRTY = 8;
const OFFSET_RECORD_COUNT = 9;

/** Precomputed CRC-32 (IEEE 802.3) lookup table. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

/**
 * Computes a CRC-32 checksum over a buffer, optionally skipping a byte range.
 * The checksum field itself must be excluded or the result would depend on its
 * own value.
 *
 * @param {Buffer} buffer - Bytes to checksum.
 * @param {number} skipStart - First byte index to exclude.
 * @param {number} skipEnd - Index one past the last excluded byte.
 * @returns {number} Unsigned 32-bit checksum.
 */
function crc32(buffer, skipStart = -1, skipEnd = -1) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    if (i >= skipStart && i < skipEnd) continue;
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

class PageCorruptionError extends Error {
  constructor(pageId, expected, actual) {
    super(`Page ${pageId} failed checksum validation (expected ${expected}, got ${actual})`);
    this.name = 'PageCorruptionError';
    this.pageId = pageId;
  }
}

class PageFullError extends Error {
  constructor(pageId, needed, available) {
    super(`Page ${pageId} has ${available} free bytes but ${needed} were requested`);
    this.name = 'PageFullError';
    this.pageId = pageId;
  }
}

class Page {
  /**
   * @param {number} pageId - Identifier of this page within documents.dat.
   * @param {number} pageSize - Fixed page size in bytes.
   * @param {Buffer} [buffer] - Existing page image; a zeroed page is created when omitted.
   */
  constructor(pageId, pageSize, buffer) {
    this.pageSize = pageSize;
    this.buffer = buffer || Buffer.alloc(pageSize);
    if (this.buffer.length !== pageSize) {
      throw new Error(`Page image must be exactly ${pageSize} bytes, got ${this.buffer.length}`);
    }
    if (!buffer) {
      this.buffer.writeUInt32LE(pageId, OFFSET_PAGE_ID);
      this.buffer.writeUInt16LE(0, OFFSET_RECORD_COUNT);
    }
  }

  get pageId() {
    return this.buffer.readUInt32LE(OFFSET_PAGE_ID);
  }

  get recordCount() {
    return this.buffer.readUInt16LE(OFFSET_RECORD_COUNT);
  }

  get dirty() {
    return this.buffer.readUInt8(OFFSET_DIRTY) === 1;
  }

  set dirty(value) {
    this.buffer.writeUInt8(value ? 1 : 0, OFFSET_DIRTY);
  }

  /**
   * Walks the record area and returns the offset just past the final record.
   * @returns {number} Byte offset where the next record would start.
   */
  endOffset() {
    let offset = PAGE_HEADER_SIZE;
    for (let i = 0; i < this.recordCount; i += 1) {
      const length = this.buffer.readUInt32LE(offset + 4);
      offset += RECORD_HEADER_SIZE + length;
    }
    return offset;
  }

  /** @returns {number} Bytes still available for new records. */
  freeSpace() {
    return this.pageSize - this.endOffset();
  }

  /**
   * Appends a record to the page.
   *
   * @param {number} recordId - Caller-assigned record identifier.
   * @param {Buffer|string} payload - Record body.
   * @param {number} version - Document version at write time.
   * @returns {number} The record identifier that was written.
   * @throws {PageFullError} When the payload does not fit.
   */
  insertRecord(recordId, payload, version = 1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const needed = RECORD_HEADER_SIZE + body.length;
    const available = this.freeSpace();
    if (needed > available) {
      throw new PageFullError(this.pageId, needed, available);
    }

    const offset = this.endOffset();
    this.buffer.writeUInt32LE(recordId, offset);
    this.buffer.writeUInt32LE(body.length, offset + 4);
    this.buffer.writeUInt32LE(version, offset + 8);
    body.copy(this.buffer, offset + RECORD_HEADER_SIZE);

    this.buffer.writeUInt16LE(this.recordCount + 1, OFFSET_RECORD_COUNT);
    this.dirty = true;
    return recordId;
  }

  /**
   * Locates a record by identifier.
   * @param {number} recordId
   * @returns {{recordId:number, version:number, payload:Buffer, offset:number}|null}
   */
  readRecord(recordId) {
    let offset = PAGE_HEADER_SIZE;
    for (let i = 0; i < this.recordCount; i += 1) {
      const id = this.buffer.readUInt32LE(offset);
      const length = this.buffer.readUInt32LE(offset + 4);
      const version = this.buffer.readUInt32LE(offset + 8);
      if (id === recordId) {
        return {
          recordId: id,
          version,
          payload: Buffer.from(
            this.buffer.subarray(offset + RECORD_HEADER_SIZE, offset + RECORD_HEADER_SIZE + length)
          ),
          offset
        };
      }
      offset += RECORD_HEADER_SIZE + length;
    }
    return null;
  }

  /** @returns {Array<{recordId:number, version:number, payload:Buffer}>} Every record in order. */
  listRecords() {
    const records = [];
    let offset = PAGE_HEADER_SIZE;
    for (let i = 0; i < this.recordCount; i += 1) {
      const recordId = this.buffer.readUInt32LE(offset);
      const length = this.buffer.readUInt32LE(offset + 4);
      const version = this.buffer.readUInt32LE(offset + 8);
      records.push({
        recordId,
        version,
        payload: Buffer.from(
          this.buffer.subarray(offset + RECORD_HEADER_SIZE, offset + RECORD_HEADER_SIZE + length)
        )
      });
      offset += RECORD_HEADER_SIZE + length;
    }
    return records;
  }

  /**
   * Replaces a record payload. Variable-length updates are handled by
   * rewriting the record area, which keeps the layout compact at the cost of a
   * memmove - acceptable for 4 KiB pages and far easier to reason about than
   * tombstones plus compaction.
   *
   * @param {number} recordId
   * @param {Buffer|string} payload - Replacement body.
   * @param {number} version - New version stamp.
   * @returns {boolean} False when the record does not exist on this page.
   */
  updateRecord(recordId, payload, version) {
    const records = this.listRecords();
    const target = records.findIndex((r) => r.recordId === recordId);
    if (target === -1) return false;

    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    records[target] = { recordId, version, payload: body };
    this.rewriteRecords(records);
    return true;
  }

  /**
   * Removes a record and compacts the page.
   * @param {number} recordId
   * @returns {boolean} False when the record does not exist on this page.
   */
  deleteRecord(recordId) {
    const records = this.listRecords();
    const remaining = records.filter((r) => r.recordId !== recordId);
    if (remaining.length === records.length) return false;
    this.rewriteRecords(remaining);
    return true;
  }

  /**
   * Rewrites the record area from a record list, validating that it still fits.
   * @param {Array<{recordId:number, version:number, payload:Buffer}>} records
   */
  rewriteRecords(records) {
    const required = records.reduce((sum, r) => sum + RECORD_HEADER_SIZE + r.payload.length, 0);
    const capacity = this.pageSize - PAGE_HEADER_SIZE;
    if (required > capacity) {
      throw new PageFullError(this.pageId, required, capacity);
    }

    this.buffer.fill(0, PAGE_HEADER_SIZE);
    let offset = PAGE_HEADER_SIZE;
    for (const record of records) {
      this.buffer.writeUInt32LE(record.recordId, offset);
      this.buffer.writeUInt32LE(record.payload.length, offset + 4);
      this.buffer.writeUInt32LE(record.version, offset + 8);
      record.payload.copy(this.buffer, offset + RECORD_HEADER_SIZE);
      offset += RECORD_HEADER_SIZE + record.payload.length;
    }
    this.buffer.writeUInt16LE(records.length, OFFSET_RECORD_COUNT);
    this.dirty = true;
  }

  /**
   * Produces the on-disk image with a fresh checksum. The dirty flag is cleared
   * in the written image because a page that has just reached disk is clean.
   * @returns {Buffer} A copy safe to hand to the storage manager.
   */
  serialize() {
    const image = Buffer.from(this.buffer);
    image.writeUInt8(0, OFFSET_DIRTY);
    const checksum = crc32(image, OFFSET_CHECKSUM, OFFSET_CHECKSUM + 4);
    image.writeUInt32LE(checksum, OFFSET_CHECKSUM);
    return image;
  }

  /**
   * Reconstructs a page from an on-disk image and verifies its checksum.
   *
   * @param {Buffer} image - Raw page bytes.
   * @param {number} pageSize
   * @returns {Page}
   * @throws {PageCorruptionError} When the stored checksum does not match.
   */
  static deserialize(image, pageSize) {
    if (image.length !== pageSize) {
      throw new Error(`Page image must be exactly ${pageSize} bytes, got ${image.length}`);
    }
    const stored = image.readUInt32LE(OFFSET_CHECKSUM);
    const pageId = image.readUInt32LE(OFFSET_PAGE_ID);

    // A page that has never been written is all zeroes; treat it as empty
    // rather than corrupt so that freshly extended files load cleanly.
    const isBlank = stored === 0 && image.readUInt16LE(OFFSET_RECORD_COUNT) === 0;
    if (!isBlank) {
      const actual = crc32(image, OFFSET_CHECKSUM, OFFSET_CHECKSUM + 4);
      if (actual !== stored) {
        throw new PageCorruptionError(pageId, stored, actual);
      }
    }
    return new Page(pageId, pageSize, Buffer.from(image));
  }
}

module.exports = {
  Page,
  PageCorruptionError,
  PageFullError,
  crc32,
  PAGE_HEADER_SIZE,
  RECORD_HEADER_SIZE
};
