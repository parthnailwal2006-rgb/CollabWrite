/**
 * Phase 3 - Storage Manager and Page tests.
 *
 * Covers the two properties the layer promises: record CRUD inside a page is
 * exact, and anything that reaches disk is checksum-protected.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { Page, PageCorruptionError, PageFullError, crc32 } = require('../../src/engine/storage/Page');
const { StorageManager, DocumentNotFoundError } = require('../../src/engine/storage/StorageManager');
const { makeDataDir, cleanup } = require('../helpers/engineHarness');

const PAGE_SIZE = 4096;

describe('Page', () => {
  test('stores its identifier and starts empty', () => {
    const page = new Page(7, PAGE_SIZE);
    expect(page.pageId).toBe(7);
    expect(page.recordCount).toBe(0);
    expect(page.freeSpace()).toBe(PAGE_SIZE - 11);
  });

  test('inserts and reads records with their version stamp', () => {
    const page = new Page(4, PAGE_SIZE);
    page.insertRecord(1, 'hello', 3);
    page.insertRecord(2, 'world', 4);

    expect(page.recordCount).toBe(2);
    expect(page.readRecord(1).payload.toString()).toBe('hello');
    expect(page.readRecord(2).version).toBe(4);
    expect(page.readRecord(99)).toBeNull();
  });

  test('updates a record to a different length and compacts on delete', () => {
    const page = new Page(4, PAGE_SIZE);
    page.insertRecord(1, 'short', 1);
    page.insertRecord(2, 'second', 1);

    expect(page.updateRecord(1, 'a much longer payload', 2)).toBe(true);
    expect(page.readRecord(1).payload.toString()).toBe('a much longer payload');
    expect(page.readRecord(2).payload.toString()).toBe('second');

    expect(page.deleteRecord(1)).toBe(true);
    expect(page.recordCount).toBe(1);
    expect(page.readRecord(1)).toBeNull();
    expect(page.deleteRecord(1)).toBe(false);
  });

  test('refuses a record that does not fit', () => {
    const page = new Page(4, PAGE_SIZE);
    expect(() => page.insertRecord(1, Buffer.alloc(PAGE_SIZE), 1)).toThrow(PageFullError);
  });

  test('round-trips through serialize and deserialize', () => {
    const page = new Page(9, PAGE_SIZE);
    page.insertRecord(1, 'persisted', 2);

    const restored = Page.deserialize(page.serialize(), PAGE_SIZE);
    expect(restored.pageId).toBe(9);
    expect(restored.readRecord(1).payload.toString()).toBe('persisted');
    expect(restored.dirty).toBe(false);
  });

  test('detects a single flipped byte', () => {
    const page = new Page(3, PAGE_SIZE);
    page.insertRecord(1, 'important data', 1);

    const image = page.serialize();
    image[64] ^= 0xff;
    expect(() => Page.deserialize(image, PAGE_SIZE)).toThrow(PageCorruptionError);
  });

  test('treats an all-zero image as empty rather than corrupt', () => {
    expect(() => Page.deserialize(Buffer.alloc(PAGE_SIZE), PAGE_SIZE)).not.toThrow();
  });

  test('crc32 matches the known IEEE check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('StorageManager', () => {
  let dataDir;
  let storage;

  beforeEach(() => {
    dataDir = makeDataDir();
    storage = new StorageManager({
      dataFile: path.join(dataDir, 'documents.dat'),
      pageSize: PAGE_SIZE,
      directoryPages: 4
    });
    storage.open();
  });

  afterEach(() => {
    storage.close();
    cleanup(dataDir);
  });

  test('reserves the directory region on a fresh file', () => {
    expect(storage.pageCount).toBe(4);
    expect(() => storage.readPage(0)).toThrow(/reserved directory region/);
  });

  test('creates documents and allocates pages after the directory', () => {
    const firstPage = storage.createDocument(1);
    expect(firstPage).toBe(4);
    expect(storage.getDocumentPages(1)).toEqual([4]);

    const second = storage.allocatePage(1);
    expect(second).toBe(5);
    expect(storage.getDocumentPages(1)).toEqual([4, 5]);
  });

  test('persists records across a close and reopen', () => {
    const pageId = storage.createDocument(42);
    const page = storage.readPage(pageId);
    page.insertRecord(1, 'durable content', 1);
    storage.writePage(page);
    storage.close();

    const reopened = new StorageManager({
      dataFile: path.join(dataDir, 'documents.dat'),
      pageSize: PAGE_SIZE,
      directoryPages: 4
    });
    reopened.open();
    expect(reopened.getDocumentPages(42)).toEqual([pageId]);
    expect(reopened.readPage(pageId).readRecord(1).payload.toString()).toBe('durable content');
    reopened.close();

    storage.open(); // so afterEach can close it
  });

  test('throws for an unknown document', () => {
    expect(() => storage.getDocumentPages(999)).toThrow(DocumentNotFoundError);
  });

  test('reads every record of a multi-page document in page order', () => {
    const first = storage.createDocument(5);
    const second = storage.allocatePage(5);

    for (const [pageId, text] of [[first, 'part-one'], [second, 'part-two']]) {
      const page = storage.readPage(pageId);
      page.insertRecord(1, text, 1);
      storage.writePage(page);
    }

    const records = storage.readDocumentRecords(5);
    expect(records.map((r) => r.payload.toString())).toEqual(['part-one', 'part-two']);
  });

  test('ensureCapacity extends the file for recovery', () => {
    storage.createDocument(1);
    storage.ensureCapacity(20);
    expect(storage.pageCount).toBe(21);
    expect(fs.statSync(path.join(dataDir, 'documents.dat')).size).toBe(21 * PAGE_SIZE);
  });
});
