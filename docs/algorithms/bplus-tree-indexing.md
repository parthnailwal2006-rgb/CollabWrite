# B+-Tree Indexing

Implementation: `src/engine/index/BPlusTree.js`,
`src/engine/index/IndexManager.js`.
Tests: `tests/unit/index.test.js`. Demo: `npm run demo:index`.

## 1. Why a B+-Tree

Answering "which documents contain *recovery*?" by scanning every document is
O(N) and re-tokenises text that has not changed. An inverted index maps each
keyword to the set of documents containing it; backing that map with a
B+-Tree makes lookup O(log N) and keeps the keys sorted.

Two properties make the B+-Tree the structure databases actually use:

1. **All data lives in the leaves**, so every lookup costs the same number of
   hops — predictable latency, and internal nodes stay small enough to keep
   the tree shallow.
2. **The leaves are chained**, so a range or prefix scan is a linear walk
   instead of a repeated descent from the root.

A hash index would answer point lookups in O(1) but could not serve the
prefix query at all, and `design.md` section 17 records that as the reason
for the choice — along with the fact that node splitting and merging is the
classic DBMS concept worth demonstrating.

## 2. Structure

```
internal node   keys[k], children[k+1]
                keys[i] is the smallest key in the subtree at children[i+1]

leaf node       keys[k], values[k]  (a Set of docIds per keyword)
                next -> the following leaf
```

### Minimum occupancy — the easy bug

Leaves and internal nodes have **different** lower bounds, and conflating
them is the classic implementation error. This project hit it during
development: a randomised trial at fanout 3 produced underfull internal nodes
on the very first run.

- A **leaf** holds data, so it must stay at least half full:
  `leafMinKeys = ceil(maxKeys / 2)`.
- An **internal** node is constrained by its **child** count: it must keep at
  least `ceil((maxKeys + 1) / 2)` children, which is one fewer key than that:
  `internalMinKeys = ceil((maxKeys + 1) / 2) - 1`.

| maxKeys | leafMinKeys | internalMinKeys |
|---------|-------------|-----------------|
| 3 | 2 | 1 |
| 4 | 2 | 2 |
| 5 | 3 | 2 |
| 8 | 4 | 4 |

At `maxKeys = 3` an internal node may legitimately hold a single key while a
leaf may not. A single shared `minKeys` either rejects a valid tree or
accepts an invalid one.

Both bounds also have to survive a merge. The worst case is a node at
`min - 1` keys merging with a sibling at exactly `min`:

- leaves: `2 * leafMin - 1 <= maxKeys`
- internal: `2 * internalMin <= maxKeys` (the separator moves down)

Both hold for every fanout above.

## 3. Insert

```
descend to the leaf that should contain the key
if the key exists        -> add the docId to its Set, done
otherwise                -> insert in sorted position
while the node overflows -> split and propagate upward
```

A **leaf split copies** the separator up: the key stays addressable in the
right leaf, because all data lives at the leaf level. An **internal split
moves** it: the separator leaves the node entirely.

The tree grows only at the root, by splitting it into a new root with two
children, which is why all leaves stay at the same depth.

## 4. Delete

```
remove the docId; drop the key when its last docId goes
while the node underflows:
  borrow from the left sibling   if it has a key to spare
  else borrow from the right sibling
  else merge with a sibling, pulling the separator down
```

Merging removes a key from the parent, which can cascade. When the root is an
internal node left with no keys, its single child becomes the new root and
the tree shrinks by a level.

## 5. Validation as a test strategy

A balanced-tree implementation cannot be trusted on worked examples alone: a
bug typically appears only after a specific sequence of splits and merges.
`BPlusTree.validate()` checks the structural invariants directly:

- keys sorted within every node;
- every key inside the bounds implied by its ancestors;
- occupancy between the type-specific minimum and `maxKeys`, root exempt;
- `children.length === keys.length + 1`;
- parent pointers consistent;
- all leaves at the same depth.

`tests/unit/index.test.js` then runs a **property test**: at each of four
fanouts (3, 4, 5, 8), fifteen randomised trials insert 300 keys, validate,
delete a random subset validating after each key, and compare the final
contents against a plain `Map`. A deterministic seeded PRNG means any failure
is reproducible from its trial number.

## 6. Persistence

`index.dat` stores the **leaf level only**:

```
uint32 entryCount
repeated:
  uint16 keyLength, key bytes (utf8)
  uint32 docCount, uint32 docIds[]
```

Internal nodes are rebuilt by re-inserting on load. They are derived data —
they carry no information the leaves do not already determine — so
serialising them would mean persisting something that can only go stale
relative to the leaves. Load becomes O(N log N) instead of O(N), which at
this scale is microseconds.

The index is additionally **rebuilt from the data files at every start-up**
(`Engine.reindexAll`). After recovery rolls transactions back, a persisted
index may describe text that no longer exists; the index is derived state, so
rebuilding it is cheaper and safer than trying to recover it.

## 7. Tokenisation

Text is lower-cased, split on non-alphanumeric characters, and filtered:
tokens shorter than two characters and a small stop-word list are dropped.
Stop words carry no discriminating power and would otherwise produce postings
lists containing nearly every document.

Re-indexing a document first removes every posting it previously had, so a
word deleted from a document stops matching it. A reverse map
`docId -> Set<keyword>` makes that removal O(keywords) rather than a scan of
the whole tree.

## 8. Measured result

150 documents, 50 iterations per query:

| Keyword | Matches | Indexed | Full scan | Speed-up |
|---------|---------|---------|-----------|----------|
| `semaphoreinversion` | 1 | 0.09 ms | 25.9 ms | 281x |
| `recovery` | 30 | 0.13 ms | 27.4 ms | 209x |
| `indexing` | 30 | 0.06 ms | 26.9 ms | 455x |
| `scheduling` | 30 | 0.04 ms | 29.0 ms | 781x |

`prd.md` section 9 sets the bar at 2x. The benchmark asserts that both paths
return identical results — a faster answer that disagrees with the baseline
would prove nothing.

The margin is this large because the baseline re-tokenises every document on
every query, which is precisely the work an index exists to avoid. A fairer
baseline that pre-tokenised would narrow the gap but would, in effect, be a
worse index.
