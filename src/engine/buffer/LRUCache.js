/**
 * CollabWrite - LRU List (Phase 4, Buffer Pool)
 *
 * CONCEPT
 *   Page replacement is the classic operating-system memory-management
 *   problem: a small pool of frames must serve a much larger address space, so
 *   the pool needs a rule for deciding which resident page to evict. We use
 *   Least Recently Used because it is the policy every OS course derives by
 *   hand, and because its behaviour is easy to observe in a demo.
 *
 * DATA STRUCTURE
 *   A doubly-linked list of page identifiers plus a Map from pageId to its
 *   node. The Map gives O(1) lookup; the list gives O(1) move-to-front and
 *   O(1) removal of the tail. design.md section 4 specifies exactly this pair.
 *
 *     head  <-> ... <-> tail
 *     (most recently used)   (least recently used, evicted first)
 */

'use strict';

class LRUCache {
  constructor() {
    this.head = null;
    this.tail = null;
    /** @type {Map<number, {pageId:number, prev:object|null, next:object|null}>} */
    this.nodes = new Map();
  }

  get size() {
    return this.nodes.size;
  }

  /** @param {number} pageId @returns {boolean} */
  has(pageId) {
    return this.nodes.has(pageId);
  }

  /**
   * Records an access, moving the page to the most-recently-used end.
   * Inserts the page if it is not tracked yet.
   * @param {number} pageId
   */
  touch(pageId) {
    const existing = this.nodes.get(pageId);
    if (existing) {
      this.unlink(existing);
      this.linkFront(existing);
      return;
    }
    const node = { pageId, prev: null, next: null };
    this.nodes.set(pageId, node);
    this.linkFront(node);
  }

  /**
   * Stops tracking a page, for example because its frame was reused.
   * @param {number} pageId
   */
  remove(pageId) {
    const node = this.nodes.get(pageId);
    if (!node) return;
    this.unlink(node);
    this.nodes.delete(pageId);
  }

  /**
   * Returns page identifiers ordered least-recently-used first. The buffer
   * pool walks this order and takes the first evictable (unpinned) frame.
   * @returns {number[]}
   */
  evictionOrder() {
    const order = [];
    for (let node = this.tail; node !== null; node = node.prev) {
      order.push(node.pageId);
    }
    return order;
  }

  /** @returns {number[]} Page identifiers ordered most-recently-used first. */
  usageOrder() {
    const order = [];
    for (let node = this.head; node !== null; node = node.next) {
      order.push(node.pageId);
    }
    return order;
  }

  clear() {
    this.head = null;
    this.tail = null;
    this.nodes.clear();
  }

  linkFront(node) {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  unlink(node) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }
}

module.exports = { LRUCache };
