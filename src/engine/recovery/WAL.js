/**
 * CollabWrite - Write-Ahead Log (Phase 11)
 *
 * CONCEPT
 *   The write-ahead rule states that a log record describing a change must
 *   reach stable storage before the changed page does. If the process dies at
 *   any instant, the log alone is enough to decide what happened: a
 *   transaction whose COMMIT record is present must be redone, and one without
 *   it must be undone. Durability (the D in ACID) is purchased here, not in
 *   the data file.
 *
 * RECORD FORMAT (design.md section 12)
 *   uint32 payloadLength   bytes that follow this field
 *   uint64 lsn             monotonically increasing log sequence number
 *   uint8  type            1 BEGIN, 2 UPDATE, 3 COMMIT, 4 ABORT, 5 CHECKPOINT
 *   uint32 txId
 *   uint32 pageId          0 for records that do not name a page
 *   uint32 beforeLength
 *   uint32 afterLength
 *   bytes  beforeImage     full page image prior to the change (UNDO source)
 *   bytes  afterImage      full page image after the change   (REDO source)
 *
 *   Full page before- and after-images are stored rather than byte deltas.
 *   This costs disk space but makes REDO and UNDO single buffer writes, which
 *   keeps the recovery algorithm short enough to read and verify by hand.
 *
 * ALGORITHM
 *   append : serialize, write at the current end of file, advance the LSN.
 *            COMMIT records are additionally fsync'd so that the operating
 *            system cannot hold them in a write-back cache across a crash.
 *   scan   : read sequentially; a truncated trailing record is treated as a
 *            torn write from the crash and is discarded.
 */

'use strict';

const fs = require('fs');

const { openReadWrite } = require('../storage/openFile');
const { createLogger } = require('../../config/logger');

const log = createLogger('WAL');

const RECORD_TYPES = {
  BEGIN: 1,
  UPDATE: 2,
  COMMIT: 3,
  ABORT: 4,
  CHECKPOINT: 5
};

const TYPE_NAMES = Object.fromEntries(
  Object.entries(RECORD_TYPES).map(([name, code]) => [code, name])
);

/** Fixed part of the payload: lsn(8) + type(1) + txId(4) + pageId(4) + lens(8). */
const PAYLOAD_HEADER_SIZE = 25;

class WAL {
  /**
   * @param {object} options
   * @param {string} options.walFile - Path to wal.log.
   * @param {boolean} [options.syncOnCommit] - fsync COMMIT records.
   */
  constructor({ walFile, syncOnCommit = true }) {
    this.walFile = walFile;
    this.syncOnCommit = syncOnCommit;
    this.fd = null;
    this.opened = false;
    this.nextLSN = 1n;
  }

  /** Opens the log, creating it if absent, and restores the next LSN. */
  open() {
    if (this.opened) return;
    this.fd = openReadWrite(this.walFile);
    this.opened = true;

    const records = this.readAll();
    this.nextLSN = records.length ? records[records.length - 1].lsn + 1n : 1n;
    log.info('WAL opened', { file: this.walFile, records: records.length });
  }

  close() {
    if (!this.opened) return;
    fs.closeSync(this.fd);
    this.fd = null;
    this.opened = false;
  }

  assertOpen() {
    if (!this.opened) throw new Error('WAL is not open; call open() first');
  }

  /** @returns {number} Current size of the log in bytes. */
  get size() {
    this.assertOpen();
    return fs.fstatSync(this.fd).size;
  }

  /**
   * Appends one record and returns its LSN.
   *
   * @param {object} record
   * @param {number} record.type - A value from RECORD_TYPES.
   * @param {number} record.txId
   * @param {number} [record.pageId]
   * @param {Buffer} [record.beforeImage]
   * @param {Buffer} [record.afterImage]
   * @param {boolean} [record.sync] - Force fsync after this record.
   * @returns {bigint} The LSN assigned to the record.
   */
  append({ type, txId, pageId = 0, beforeImage = null, afterImage = null, sync = false }) {
    this.assertOpen();

    const before = beforeImage || Buffer.alloc(0);
    const after = afterImage || Buffer.alloc(0);
    const payloadLength = PAYLOAD_HEADER_SIZE + before.length + after.length;
    const frame = Buffer.alloc(4 + payloadLength);

    const lsn = this.nextLSN;
    let offset = 0;
    frame.writeUInt32LE(payloadLength, offset); offset += 4;
    frame.writeBigUInt64LE(lsn, offset); offset += 8;
    frame.writeUInt8(type, offset); offset += 1;
    frame.writeUInt32LE(txId, offset); offset += 4;
    frame.writeUInt32LE(pageId, offset); offset += 4;
    frame.writeUInt32LE(before.length, offset); offset += 4;
    frame.writeUInt32LE(after.length, offset); offset += 4;
    before.copy(frame, offset); offset += before.length;
    after.copy(frame, offset);

    fs.writeSync(this.fd, frame, 0, frame.length, this.size);
    if (sync || (this.syncOnCommit && type === RECORD_TYPES.COMMIT)) {
      fs.fsyncSync(this.fd);
    }

    this.nextLSN += 1n;
    return lsn;
  }

  /** @param {number} txId @returns {bigint} */
  logBegin(txId) {
    return this.append({ type: RECORD_TYPES.BEGIN, txId });
  }

  /**
   * Logs a page modification. Must be called before the page is changed in
   * the buffer pool, which is what makes the log "write-ahead".
   *
   * @param {number} txId
   * @param {number} pageId
   * @param {Buffer} beforeImage - Page image captured prior to the change.
   * @param {Buffer} afterImage - Page image the change will produce.
   * @returns {bigint}
   */
  logUpdate(txId, pageId, beforeImage, afterImage) {
    return this.append({ type: RECORD_TYPES.UPDATE, txId, pageId, beforeImage, afterImage });
  }

  /** @param {number} txId @returns {bigint} */
  logCommit(txId) {
    return this.append({ type: RECORD_TYPES.COMMIT, txId, sync: this.syncOnCommit });
  }

  /** @param {number} txId @returns {bigint} */
  logAbort(txId) {
    return this.append({ type: RECORD_TYPES.ABORT, txId });
  }

  /** @returns {bigint} */
  logCheckpoint() {
    return this.append({ type: RECORD_TYPES.CHECKPOINT, txId: 0, sync: true });
  }

  /**
   * Reads the whole log in LSN order.
   *
   * A trailing record whose declared length exceeds the remaining bytes is a
   * torn write: the process died midway through `fs.writeSync`. It is dropped,
   * which is safe because such a record was never acknowledged to any caller.
   *
   * @returns {Array<{lsn:bigint, type:number, typeName:string, txId:number,
   *                  pageId:number, beforeImage:Buffer|null, afterImage:Buffer|null}>}
   */
  readAll() {
    this.assertOpen();
    const total = this.size;
    if (total === 0) return [];

    const data = Buffer.alloc(total);
    fs.readSync(this.fd, data, 0, total, 0);

    const records = [];
    let cursor = 0;
    while (cursor + 4 <= total) {
      const payloadLength = data.readUInt32LE(cursor);
      if (payloadLength < PAYLOAD_HEADER_SIZE || cursor + 4 + payloadLength > total) {
        log.warn('Discarding torn WAL tail', { offset: cursor });
        break;
      }
      let offset = cursor + 4;
      const lsn = data.readBigUInt64LE(offset); offset += 8;
      const type = data.readUInt8(offset); offset += 1;
      const txId = data.readUInt32LE(offset); offset += 4;
      const pageId = data.readUInt32LE(offset); offset += 4;
      const beforeLength = data.readUInt32LE(offset); offset += 4;
      const afterLength = data.readUInt32LE(offset); offset += 4;

      const beforeImage = beforeLength
        ? Buffer.from(data.subarray(offset, offset + beforeLength))
        : null;
      offset += beforeLength;
      const afterImage = afterLength
        ? Buffer.from(data.subarray(offset, offset + afterLength))
        : null;

      records.push({
        lsn,
        type,
        typeName: TYPE_NAMES[type] || 'UNKNOWN',
        txId,
        pageId,
        beforeImage,
        afterImage
      });
      cursor += 4 + payloadLength;
    }
    return records;
  }

  /** Empties the log. Used after a successful checkpoint and by tests. */
  truncate() {
    this.assertOpen();
    fs.ftruncateSync(this.fd, 0);
    this.nextLSN = 1n;
  }
}

module.exports = { WAL, RECORD_TYPES, TYPE_NAMES };
