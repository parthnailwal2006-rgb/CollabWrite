/**
 * CollabWrite - B+-Tree (Phase 10)
 *
 * CONCEPT
 *   A full scan answers a keyword search in O(N) page reads. A B+-Tree answers
 *   it in O(log N) by keeping keys sorted and fanned out across a shallow
 *   tree. Two properties make it the structure every database actually uses:
 *   all data lives in the leaves, so every lookup costs the same number of
 *   hops, and the leaves are chained, so a range scan is a linear walk rather
 *   than a repeated descent.
 *
 * STRUCTURE
 *   Internal node : keys[k], children[k+1]. keys[i] is the smallest key in
 *                   the subtree at children[i+1].
 *   Leaf node     : keys[k], values[k] (a Set of document ids per key), and a
 *                   `next` pointer to the following leaf.
 *
 * INVARIANTS
 *   - Every node except the root holds at least ceil(maxKeys / 2) keys.
 *   - Every node holds at most maxKeys keys.
 *   - All leaves sit at the same depth; the tree grows upward from a split of
 *     the root, never downward.
 *
 * ALGORITHMS
 *   insert : descend to the leaf, insert in sorted position, then split
 *            upwards while the node overflows. A leaf split copies the
 *            separator up (the key stays in the leaf); an internal split
 *            moves it up (the key leaves the node).
 *   delete : remove from the leaf, then while the node underflows try to
 *            borrow a key from an adjacent sibling, and merge with it when
 *            borrowing is not possible. Merging can propagate to the root,
 *            which shrinks the tree by one level.
 *   search : one descent, O(log N).
 */

'use strict';

class BPlusNode {
  /** @param {boolean} leaf */
  constructor(leaf) {
    this.leaf = leaf;
    /** @type {Array<string>} */
    this.keys = [];
    /** @type {Array<Set<number>>} Leaf only. */
    this.values = [];
    /** @type {Array<BPlusNode>} Internal only. */
    this.children = [];
    /** @type {BPlusNode|null} */
    this.next = null;
    /** @type {BPlusNode|null} */
    this.parent = null;
  }
}

class BPlusTree {
  /**
   * @param {number} [maxKeys] - Maximum keys per node; must be at least 3.
   */
  constructor(maxKeys = 4) {
    if (maxKeys < 3) throw new Error('B+-Tree requires maxKeys of at least 3');
    this.maxKeys = maxKeys;
    /**
     * Leaves and internal nodes have different minimum-occupancy bounds, and
     * conflating them is the classic B+-Tree implementation bug.
     *
     * A leaf holds data, so it must stay at least half full: ceil(maxKeys/2).
     * An internal node is constrained by its CHILD count - it must keep at
     * least ceil((maxKeys+1)/2) children, which is one fewer key than that.
     * With maxKeys = 3 an internal node may legitimately hold a single key,
     * while a leaf may not.
     */
    this.leafMinKeys = Math.ceil(maxKeys / 2);
    this.internalMinKeys = Math.ceil((maxKeys + 1) / 2) - 1;
    this.root = new BPlusNode(true);
    this.size = 0;
    this.stats = { splits: 0, merges: 0, borrows: 0, comparisons: 0 };
  }

  /**
   * Minimum keys this node must retain.
   * @param {BPlusNode} node
   * @returns {number}
   */
  minKeysFor(node) {
    return node.leaf ? this.leafMinKeys : this.internalMinKeys;
  }

  /** @returns {number} Number of levels from root to leaf. */
  get height() {
    let height = 1;
    let node = this.root;
    while (!node.leaf) {
      node = node.children[0];
      height += 1;
    }
    return height;
  }

  /**
   * Descends to the leaf that would contain a key.
   * @param {string} key
   * @returns {BPlusNode}
   */
  findLeaf(key) {
    let node = this.root;
    while (!node.leaf) {
      let index = 0;
      while (index < node.keys.length && this.compare(key, node.keys[index]) >= 0) index += 1;
      node = node.children[index];
    }
    return node;
  }

  /**
   * @param {string} a
   * @param {string} b
   * @returns {number} Negative, zero or positive, as for Array#sort.
   */
  compare(a, b) {
    this.stats.comparisons += 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /**
   * Adds a document id under a key.
   * @param {string} key
   * @param {number} docId
   */
  insert(key, docId) {
    const leaf = this.findLeaf(key);

    let position = 0;
    while (position < leaf.keys.length && this.compare(key, leaf.keys[position]) > 0) position += 1;

    if (position < leaf.keys.length && leaf.keys[position] === key) {
      leaf.values[position].add(docId);
      return;
    }

    leaf.keys.splice(position, 0, key);
    leaf.values.splice(position, 0, new Set([docId]));
    this.size += 1;

    if (leaf.keys.length > this.maxKeys) this.splitLeaf(leaf);
  }

  /** @param {BPlusNode} leaf */
  splitLeaf(leaf) {
    this.stats.splits += 1;
    const mid = Math.ceil(leaf.keys.length / 2);

    const right = new BPlusNode(true);
    right.keys = leaf.keys.splice(mid);
    right.values = leaf.values.splice(mid);
    right.next = leaf.next;
    right.parent = leaf.parent;
    leaf.next = right;

    // A leaf split copies the separator upward: the key remains addressable
    // in the right leaf because all data lives at the leaf level.
    this.insertIntoParent(leaf, right.keys[0], right);
  }

  /**
   * @param {BPlusNode} left
   * @param {string} separator
   * @param {BPlusNode} right
   */
  insertIntoParent(left, separator, right) {
    if (left === this.root) {
      const root = new BPlusNode(false);
      root.keys = [separator];
      root.children = [left, right];
      left.parent = root;
      right.parent = root;
      this.root = root;
      return;
    }

    const parent = left.parent;
    const index = parent.children.indexOf(left);
    parent.keys.splice(index, 0, separator);
    parent.children.splice(index + 1, 0, right);
    right.parent = parent;

    if (parent.keys.length > this.maxKeys) this.splitInternal(parent);
  }

  /** @param {BPlusNode} node */
  splitInternal(node) {
    this.stats.splits += 1;
    const mid = Math.floor(node.keys.length / 2);
    const separator = node.keys[mid];

    const right = new BPlusNode(false);
    right.keys = node.keys.splice(mid + 1);
    right.children = node.children.splice(mid + 1);
    node.keys.pop(); // remove the separator; it moves up, it is not copied
    right.parent = node.parent;
    for (const child of right.children) child.parent = right;

    this.insertIntoParent(node, separator, right);
  }

  /**
   * Point lookup.
   * @param {string} key
   * @returns {number[]} Document ids, empty when the key is absent.
   */
  search(key) {
    const leaf = this.findLeaf(key);
    const index = leaf.keys.indexOf(key);
    return index === -1 ? [] : [...leaf.values[index]];
  }

  /**
   * Inclusive range scan, walking the leaf chain.
   * @param {string} from
   * @param {string} to
   * @returns {Array<{key:string, docIds:number[]}>}
   */
  rangeScan(from, to) {
    const results = [];
    let leaf = this.findLeaf(from);

    while (leaf) {
      for (let i = 0; i < leaf.keys.length; i += 1) {
        const key = leaf.keys[i];
        if (this.compare(key, from) < 0) continue;
        if (this.compare(key, to) > 0) return results;
        results.push({ key, docIds: [...leaf.values[i]] });
      }
      leaf = leaf.next;
    }
    return results;
  }

  /**
   * Removes one document id from a key, dropping the key when its last
   * document goes away.
   *
   * @param {string} key
   * @param {number} [docId] - Omit to remove the key entirely.
   * @returns {boolean} True when something was removed.
   */
  delete(key, docId = null) {
    const leaf = this.findLeaf(key);
    const index = leaf.keys.indexOf(key);
    if (index === -1) return false;

    if (docId !== null) {
      const removed = leaf.values[index].delete(docId);
      if (!removed) return false;
      if (leaf.values[index].size > 0) return true;
    }

    leaf.keys.splice(index, 1);
    leaf.values.splice(index, 1);
    this.size -= 1;

    if (leaf !== this.root && leaf.keys.length < this.leafMinKeys) this.rebalance(leaf);
    return true;
  }

  /**
   * Restores the minimum-occupancy invariant for a node, propagating upward.
   * @param {BPlusNode} node
   */
  rebalance(node) {
    if (node === this.root) {
      // The root is allowed to underflow. It only disappears when it is an
      // internal node left with a single child, which becomes the new root.
      if (!node.leaf && node.keys.length === 0) {
        this.root = node.children[0];
        this.root.parent = null;
      }
      return;
    }

    const parent = node.parent;
    const index = parent.children.indexOf(node);
    const left = index > 0 ? parent.children[index - 1] : null;
    const right = index < parent.children.length - 1 ? parent.children[index + 1] : null;

    const minKeys = this.minKeysFor(node);
    if (left && left.keys.length > minKeys) {
      this.borrowFromLeft(node, left, parent, index);
      return;
    }
    if (right && right.keys.length > minKeys) {
      this.borrowFromRight(node, right, parent, index);
      return;
    }
    if (left) this.mergeNodes(left, node, parent, index - 1);
    else if (right) this.mergeNodes(node, right, parent, index);
  }

  borrowFromLeft(node, left, parent, index) {
    this.stats.borrows += 1;
    if (node.leaf) {
      node.keys.unshift(left.keys.pop());
      node.values.unshift(left.values.pop());
      parent.keys[index - 1] = node.keys[0];
    } else {
      node.keys.unshift(parent.keys[index - 1]);
      parent.keys[index - 1] = left.keys.pop();
      const child = left.children.pop();
      child.parent = node;
      node.children.unshift(child);
    }
  }

  borrowFromRight(node, right, parent, index) {
    this.stats.borrows += 1;
    if (node.leaf) {
      node.keys.push(right.keys.shift());
      node.values.push(right.values.shift());
      parent.keys[index] = right.keys[0];
    } else {
      node.keys.push(parent.keys[index]);
      parent.keys[index] = right.keys.shift();
      const child = right.children.shift();
      child.parent = node;
      node.children.push(child);
    }
  }

  /**
   * Merges `right` into `left` and removes the separator from the parent.
   * @param {BPlusNode} left
   * @param {BPlusNode} right
   * @param {BPlusNode} parent
   * @param {number} separatorIndex
   */
  mergeNodes(left, right, parent, separatorIndex) {
    this.stats.merges += 1;
    if (left.leaf) {
      left.keys.push(...right.keys);
      left.values.push(...right.values);
      left.next = right.next;
    } else {
      left.keys.push(parent.keys[separatorIndex]);
      left.keys.push(...right.keys);
      for (const child of right.children) {
        child.parent = left;
        left.children.push(child);
      }
    }

    parent.keys.splice(separatorIndex, 1);
    parent.children.splice(separatorIndex + 1, 1);

    if (parent === this.root && parent.keys.length === 0) {
      this.root = left;
      left.parent = null;
      return;
    }
    if (parent !== this.root && parent.keys.length < this.internalMinKeys) this.rebalance(parent);
  }

  /**
   * Every key in ascending order, read off the leaf chain.
   * @returns {Array<{key:string, docIds:number[]}>}
   */
  entries() {
    const result = [];
    let node = this.root;
    while (!node.leaf) node = node.children[0];
    while (node) {
      for (let i = 0; i < node.keys.length; i += 1) {
        result.push({ key: node.keys[i], docIds: [...node.values[i]] });
      }
      node = node.next;
    }
    return result;
  }

  /**
   * Verifies the structural invariants. The tests call this after every
   * randomised insert/delete sequence; a tree that claims O(log N) lookups has
   * to prove it stays balanced.
   *
   * @returns {{valid:boolean, errors:string[]}}
   */
  validate() {
    const errors = [];
    const leafDepths = new Set();

    const walk = (node, depth, lowerBound, upperBound) => {
      for (let i = 1; i < node.keys.length; i += 1) {
        if (node.keys[i - 1] >= node.keys[i]) {
          errors.push(`Keys out of order in node at depth ${depth}`);
        }
      }
      for (const key of node.keys) {
        if (lowerBound !== null && key < lowerBound) errors.push(`Key ${key} below lower bound`);
        if (upperBound !== null && key >= upperBound) errors.push(`Key ${key} above upper bound`);
      }
      const minKeys = this.minKeysFor(node);
      if (node !== this.root && node.keys.length < minKeys) {
        errors.push(`Underfull ${node.leaf ? 'leaf' : 'internal'} node at depth ${depth}: ${node.keys.length} < ${minKeys}`);
      }
      if (node.keys.length > this.maxKeys) {
        errors.push(`Overfull node at depth ${depth}: ${node.keys.length} > ${this.maxKeys}`);
      }

      if (node.leaf) {
        leafDepths.add(depth);
        return;
      }
      if (node.children.length !== node.keys.length + 1) {
        errors.push(`Node at depth ${depth} has ${node.children.length} children for ${node.keys.length} keys`);
      }
      for (let i = 0; i < node.children.length; i += 1) {
        if (node.children[i].parent !== node) errors.push(`Broken parent pointer at depth ${depth}`);
        walk(
          node.children[i],
          depth + 1,
          i === 0 ? lowerBound : node.keys[i - 1],
          i === node.keys.length ? upperBound : node.keys[i]
        );
      }
    };

    walk(this.root, 0, null, null);
    if (leafDepths.size > 1) errors.push(`Leaves at differing depths: ${[...leafDepths].join(', ')}`);

    return { valid: errors.length === 0, errors };
  }
}

module.exports = { BPlusTree, BPlusNode };
