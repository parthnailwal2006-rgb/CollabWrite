# The Academic Engine

This document is the six-step explanation that `rules.md` section 3 requires
before any academic mechanism may be implemented. Every module is described as
**Concept, Data Structures, Algorithm, Implementation, Test, Result** so that
a reader can follow the reasoning from theory to the line of code and then to
the number the demo prints.

Nothing here is delegated to a library. PostgreSQL provides authentication and
metadata; everything below is ours.

## Module map

| # | Module | OS/DBMS concept | Source | Phase |
|---|--------|-----------------|--------|-------|
| 1 | Storage Manager | File organisation, page I/O | `src/engine/storage/` | 3 |
| 2 | Buffer Pool Manager | Memory management, LRU replacement | `src/engine/buffer/` | 4 |
| 3 | Transaction Manager | ACID transactions | `src/engine/transaction/` | 5 |
| 4 | Lock Manager | Synchronisation, two-phase locking | `src/engine/lock/LockManager.js` | 6 |
| 5 | Deadlock Detector | Deadlock detection, wait-for graph | `src/engine/lock/DeadlockDetector.js` | 6 |
| 6 | Request Scheduler | CPU scheduling, fairness | `src/engine/scheduler/Scheduler.js` | 7 |
| 7 | Worker Pool | Threads, bounded concurrency | `src/engine/scheduler/WorkerPool.js` | 7 |
| 8 | Message Queue | Message passing, producer-consumer | `src/engine/messaging/` | 8 |
| 9 | Conflict Resolver | Optimistic concurrency control | `src/engine/conflict/` | 9 |
| 10 | Index Manager | Indexing, B+-Tree | `src/engine/index/` | 10 |
| 11 | Recovery Manager | Write-ahead logging, REDO/UNDO | `src/engine/recovery/` | 11 |

The composition root that wires them together is `src/engine/Engine.js`.

---

## 1. Storage Manager

**Concept.** A database moves fixed-size pages, not individual records. The
page is the unit of disk I/O, of caching, and of locking. Fixing that unit at
the bottom of the stack is what lets every layer above speak in page
identifiers instead of byte offsets.

**Data structures.**

```
PageHeader   uint32 pageId, uint32 checksum, uint8 dirtyFlag, uint16 recordCount   (11 bytes)
RecordHeader uint32 recordId, uint32 length, uint32 version                        (12 bytes)
PageDirectory  uint32 entryCount, then { uint32 docId, uint16 pageCount, uint32 pageIds[] }
```

Records sit contiguously after the page header. Each carries its own length,
so the page is walked sequentially without a slot directory — the simplest
layout that still supports record-level addressing.

**Algorithm.** `readPage(id)` seeks to `id * pageSize`, reads one page and
verifies its CRC-32. `writePage` recomputes the checksum and writes. The page
directory occupies the first four pages of `documents.dat` and is rewritten
whenever a page is allocated.

**Implementation.** `Page.js` owns the byte layout and record CRUD;
`StorageManager.js` owns the file descriptor and the directory. Synchronous
`fs` calls are deliberate: the buffer pool and the WAL need a visible
happens-before ordering between writes, and a promise chain would hide it.

**Test.** `tests/unit/storage.test.js` — record insert, variable-length
update, delete with compaction, page-full rejection, serialize/deserialize
round-trip, a single flipped byte caught by the checksum, and persistence
across a close and reopen.

**Result.** A document version written to `documents.dat` reads back
byte-identical, and corruption is detected rather than silently served
(phases.md milestone, Phase 3).

---

## 2. Buffer Pool Manager

**Concept.** Memory is smaller than disk, so a fixed set of frames must serve
a much larger file. The pool needs a replacement rule, a way to know which
pages are in use, and a way to know which are modified. This is the OS page
cache with pin counts in place of reference counts.

**Data structures.** `pageTable: Map<pageId, {page, pinCount, dirty}>` plus an
`LRUCache`: a doubly-linked list of page identifiers with a `Map` from pageId
to node, giving O(1) touch and O(1) eviction of the tail.

**Algorithm.**

1. Hit — the frame is resident: increment `pinCount`, move to the front.
2. Miss and the pool is full — walk the LRU list from the least recently used
   end for the first frame with `pinCount === 0`; flush it if dirty; drop it.
3. Read the page through the storage manager and install the frame.

**Implementation.** `BufferPool.js` and `LRUCache.js`. The invariant that
matters is that a page with `pinCount > 0` is never evicted, so a transaction
holding a page cannot have it pulled out from under it. When every frame is
pinned, `fetchPage` throws `BufferPoolFullError` rather than violating it.

**Test.** `tests/unit/bufferPool.test.js` — hit and miss counting, LRU
ordering after a re-touch, refusal to evict a pinned page, write-back of a
dirty page on eviction, and `flushAll` writing each dirty frame exactly once.

**Result.** `npm run demo:buffer` shows a hit ratio of 0.90 for a working set
that fits in the pool and 0.00 for a cyclic scan larger than it — the textbook
worst case for LRU, visible rather than asserted.

---

## 3. Transaction Manager

**Concept.** A transaction is the unit of atomicity: everything it does
becomes visible together at COMMIT or disappears together at ABORT. The four
guarantees are provided by four different mechanisms, and the transaction
manager is where they meet.

| Property | Provided by |
|----------|-------------|
| Atomicity | UNDO from WAL before-images on ABORT |
| Consistency | Optimistic version check before each write |
| Isolation | Strict two-phase locking |
| Durability | WAL COMMIT record fsync'd before commit returns |

**Data structures.** `Transaction` holds `txId`, `state`, `startLSN`,
`modifiedPages[]`, `locksHeld[]`, `readVersions`, and an `undoLog` of
`{pageId, beforeImage}` pairs in write order.

**Algorithm.** The write path is the write-ahead rule in code form:

```
acquire X lock -> fetch page -> capture before-image -> apply mutation
               -> write WAL UPDATE -> mark the frame dirty
```

COMMIT writes the COMMIT record, flushes the transaction's dirty pages, then
releases every lock. ABORT restores before-images in reverse order, writes the
ABORT record, and releases every lock.

**Implementation.** The buffer policy is **STEAL / FORCE**. Steal means an
uncommitted dirty page can be evicted to disk, which is why UNDO exists. Force
means COMMIT flushes before returning, which is why REDO is short. Both halves
are implemented because a crash can land between the two.

**Test.** `tests/unit/transaction.test.js` — commit durability, the UPDATE
record preceding the data file write, abort undoing a page that was already
stolen to disk, lock release at commit, a second writer blocking, and a stale
version being rejected.

**Result.** `npm run demo:transactions` walks all four properties, including
forcing a steal and then rolling it back.

---

## 4. Lock Manager

**Concept.** Two-phase locking makes concurrent schedules serialisable. A
transaction has a growing phase in which it only acquires locks and a
shrinking phase, entered at COMMIT or ABORT, in which it only releases them.
Because no lock is released before the last one is taken, the schedule is
conflict-serialisable.

**Data structures.** `lockTable: Map<resourceId, {holders: Map<txId, mode>,
waitQueue: LockRequest[]}>`, where a resource is `doc:<id>/page:<id>` and a
`LockRequest` carries the promise resolver for a blocked transaction.

Compatibility: shared with shared only.

| requested \ held | S | X |
|------------------|---|---|
| **S** | yes | no |
| **X** | no | no |

**Algorithm.** A request is granted if the transaction already holds an equal
or stronger mode, if it is a sole-holder S-to-X upgrade, or if it is
compatible with every holder **and no one is already queued**. That last
condition is deliberate: letting a compatible reader jump a queue of waiting
writers would starve them. Otherwise the request joins the FIFO queue. On
release, the queue is drained from the front while requests remain compatible.

**Implementation.** `LockManager.js`. It does not resolve deadlocks; it only
exposes `getWaitForEdges()`. Separating detection from the lock table keeps
each piece small enough to test alone.

**Test.** `tests/unit/lockManager.test.js` — the full compatibility matrix,
blocking and eventual grant, FIFO fairness, refusal to let a reader barge past
a queued writer, S-to-X upgrade, timeout, and wait-for edge extraction.

**Result.** Three users editing one document all commit, with contiguous
version numbers proving a serialisable schedule (`npm run demo:concurrency`).

---

## 5. Deadlock Detector

**Concept.** Deadlock is the state in which each member of a set of
transactions holds a resource another member is waiting for. This engine
detects and recovers rather than preventing: transactions lock freely, a
background sweep looks for a cycle, and one victim is aborted.

**Data structure.** The wait-for graph. Nodes are active transactions; a
directed edge `Ti -> Tj` exists when `Ti` is queued for a lock held by `Tj` in
an incompatible mode. A cycle in this graph is exactly a deadlock.

**Algorithm.** Tarjan's strongly connected components. One depth-first pass
assigns each node an index and a low-link value; when a node's low-link equals
its index it is the root of an SCC, which is popped off the stack. Any SCC
with more than one node is a cycle. Tarjan is O(V + E) and finds every cycle
in a single pass, which beats repeating a DFS from each node.

Victim selection: the transaction holding the fewest locks, breaking ties by
the highest (youngest) transaction id. Rolling back the smallest holder throws
away the least completed work; preferring the youngest avoids starving a
long-running transaction that keeps losing.

**Implementation.** `DeadlockDetector.js`, swept every
`DEADLOCK_CHECK_INTERVAL_MS` (default 250 ms). The victim's pending lock
request is rejected, and its next engine call turns that into an abort.

**Test.** `tests/unit/deadlockDetector.test.js` — acyclic graphs, two- and
three-transaction cycles, two independent cycles in one pass, a long waiting
chain that is *not* a deadlock, both victim-selection rules, and a live
end-to-end detection against the real lock manager.

**Result.** `npm run demo:deadlock` prints the wait-for graph, the lock table,
the detected cycle and the chosen victim; one transaction proceeds, one is
aborted.

**An honest caveat.** The ordinary edit path cannot deadlock.
`Engine.executeEdit` acquires page locks in ascending page order, and a total
acquisition order makes a cycle impossible — a cycle would require some
transaction to request a lower-numbered page while holding a higher-numbered
one, and none ever does. The detector exists for the general transaction API,
where a caller may lock several documents in any order. Prevention where it is
cheap, detection where it is not.

---

## 6. Request Scheduler

**Concept.** Every edit enters the engine through one queue, and the policy
applied to that queue decides who runs next. This is CPU scheduling with
transactions in place of processes and workers in place of cores.

**Data structures.** FIFO keeps a single `requestQueue`. Round-robin keeps one
sub-queue per document plus a rotation cursor. Each task records
`enqueuedAt`, `startedAt` and `finishedAt`, giving waiting time and turnaround
time — the two numbers a scheduling comparison is judged on.

**Algorithm.** `dispatch()` pairs idle workers with queued tasks until one
side runs out, and runs again whenever work arrives or a worker frees up.
Under FIFO the head of the queue is taken. Under round-robin the rotation
advances one document at a time, so a burst aimed at one document cannot
monopolise the pool. A task flagged `priority` is placed ahead of non-priority
tasks within its queue, preserving arrival order inside each class.

**Implementation.** `Scheduler.js`. The policy is switchable at runtime
through `POST /api/admin/scheduler/policy`, but only while the queue is empty
— changing it mid-flight would make the metrics meaningless.

**Test.** `tests/unit/scheduler.test.js` — concurrency never exceeding the
pool size, FIFO arrival order, round-robin rotating across documents, priority
jumping the queue, recorded waiting and turnaround times, and a direct
comparison showing round-robin lowering the mean wait for non-burst documents.

**Result.** `npm run demo:scheduling`, with 16 requests bursting onto one
document and 6 other documents sending one each:

| Policy | Mean wait (all) | Mean wait (non-burst documents) |
|--------|-----------------|---------------------------------|
| FIFO | 82 ms | 146 ms |
| Round-robin | 78 ms | 23 ms |

Total throughput is unchanged, because the total work is identical.
Round-robin redistributes waiting rather than removing it — which is the
trade-off, and the point of the comparison.

---

## 7. Worker Pool

**Concept.** A worker is an execution context owning one transaction at a
time. A fixed pool bounds concurrency by the number of workers rather than by
the number of clients, and that bound is what makes the scheduler queue, the
lock table and the buffer pool observable at all.

**Data structures.** `Worker { id, state: IDLE|BUSY, currentTask,
tasksProcessed, busyMs }` and a circular cursor so work spreads evenly instead
of always landing on worker 1.

**Implementation note — why not `node:worker_threads`.** `rules.md` section 9
requires that workers be modelled explicitly rather than borrowed from a
framework. It does not require OS threads, and real threads would actively
hurt here: the lock table, buffer pool and WAL are shared in-process
structures, so moving tasks onto worker threads would force every page and
every lock decision through message passing to a single owning thread, hiding
the mechanisms this project exists to show. Workers are therefore first-class
objects with an explicit state machine, an occupancy record and per-worker
statistics — all the state an OS keeps for a thread — scheduled cooperatively
on the event loop. This is recorded as a trade-off, not glossed over.

**Test.** `tests/unit/scheduler.test.js` — the IDLE/BUSY transition, circular
acquisition, `acquire()` returning null when all workers are busy, and
per-worker task counts.

**Result.** The scheduling demo prints per-worker task counts and busy time;
with two workers and 22 tasks the split was 11/11.

---

## 8. Message Queue and Collaboration Manager

**Concept.** Producer-consumer with a bounded buffer. Workers produce
committed edit events; the collaboration manager consumes them and pushes to
clients. The queue in between means a worker never blocks on a slow socket.

**Data structures.** An array buffer with a capacity, a `Map` of per-document
sequence numbers, and a consumer list. The collaboration manager keeps
`sessions: Map<sessionId, …>` and a reverse index `byDocument: Map<docId,
Set<sessionId>>` for broadcast and presence.

**Algorithm.** `publish` stamps the event with the next per-document sequence
number and schedules an asynchronous drain, so the calling worker is never
blocked. `drain` delivers every buffered event to every consumer in insertion
order. A full queue rejects rather than growing without bound.

**Why this is not just Socket.IO.** `rules.md` section 2 forbids presenting
Socket.IO's own routing as our message-passing layer. The queue owns the
ordering guarantee, the capacity bound and the delivery bookkeeping; Socket.IO
is only the transport the consumer happens to use, injected rather than
imported so the guarantees can be tested without opening a socket.

**Test.** `tests/unit/messaging.test.js` for ordering, per-document sequence
numbering, multiple consumers, capacity rejection and presence bookkeeping;
`tests/integration/realtime.test.js` drives two real browser-equivalent
clients through the whole path.

**Result.** An edit by one client appears at the other with the right version
and sequence number, and four rapid edits arrive in commit order
(phases.md milestone, Phase 8).

---

## 9. Conflict Resolver

**Concept.** Locking alone does not stop a client submitting an edit computed
against a stale copy. The client reads version 7, types, and by the time the
request arrives another transaction has committed version 8. The lock is
granted — nobody holds it any more — but applying the edit at the old offsets
would corrupt the text. The fix is an optimistic version check performed
*after* the lock is held, when the version can no longer change.

**Scope note.** `design.md` section 10 puts full Operational Transformation out
of scope. Correctness comes from two-phase locking plus version checking:
disjoint edits merge, overlapping edits abort and the client retries against
the fresh version. That is weaker than OT in user experience and equivalent in
correctness.

**Data structures.** The document version is the record header version of the
metadata record on page 0, bumped once per committed edit. An operation's
affected range is `[start, end)` with a length delta: an insert is a
zero-width point with a positive delta, a delete spans what it removes.

**Algorithm.**

1. `expectedVersion !== actualVersion` → conflict, abort, report the current
   version so the client can rebase in one round trip.
2. Disjoint ranges → merge, shifting the later operation by the earlier one's
   length delta.
3. Overlapping ranges → refuse to merge.

Two inserts collide only at the exact same offset, where the resulting order
would otherwise be arbitrary. An insert strictly inside a deleted span is
ambiguous, because the text would land in characters that are disappearing; at
the boundary it is not.

**Test.** `tests/unit/conflictResolver.test.js` — range arithmetic, every
overlap case including both boundary cases, offset shifting in both
directions, and a check that a merged result does not depend on which edit is
replayed first.

**Result.** A stale edit returns HTTP 409 with `currentVersion`, the document
is unchanged, and the React client rebases automatically.

---

## 10. Index Manager

**Concept.** A full scan answers a keyword query in O(N). A B+-Tree answers it
in O(log N) by keeping keys sorted in a shallow, high-fanout tree. All data
lives in the leaves, so every lookup costs the same number of hops, and the
leaves are chained, so a range or prefix scan is a linear walk.

**Data structures.** Internal node: `keys[k]`, `children[k+1]`. Leaf node:
`keys[k]`, `values[k]` (a `Set` of document ids per keyword), and a `next`
pointer.

Minimum occupancy differs by node type, and conflating the two is the classic
implementation bug:

- a leaf holds data, so it stays at least half full: `ceil(maxKeys / 2)`;
- an internal node is constrained by its **child** count, so it keeps
  `ceil((maxKeys + 1) / 2)` children — one fewer key than that.

With `maxKeys = 3` an internal node may legitimately hold a single key while a
leaf may not.

**Algorithm.** Insert descends to the leaf and splits upward while nodes
overflow; a leaf split *copies* the separator up, an internal split *moves*
it. Delete removes from the leaf, then borrows from an adjacent sibling, and
merges when borrowing is impossible — which can propagate to the root and
shrink the tree by a level.

**Persistence.** `index.dat` stores the leaf level only; internal nodes are
rebuilt by re-inserting on load. Internal nodes are derived data carrying no
information the leaves do not already determine, so serialising them would
mean persisting something that can only go stale. Load is O(N log N) instead
of O(N), which at this scale is microseconds.

**Test.** `tests/unit/index.test.js` runs a **property test**: 15 randomised
insert/delete trials at each of four fanouts, re-validating every structural
invariant after each step and comparing contents against a plain `Map`. A tree
that claims O(log N) lookups has to prove it stays balanced.

**Result.** `npm run demo:index` over 150 documents, measured:

| Keyword | Matches | Indexed | Full scan | Speed-up |
|---------|---------|---------|-----------|----------|
| `semaphoreinversion` | 1 | 0.09 ms | 25.9 ms | 281x |
| `recovery` | 30 | 0.13 ms | 27.4 ms | 209x |
| `indexing` | 30 | 0.06 ms | 26.9 ms | 455x |
| `scheduling` | 30 | 0.04 ms | 29.0 ms | 781x |

Both paths return identical answers, which is what makes the comparison
meaningful. `prd.md` section 9 asks for 2x. The margin is this large because
the full scan re-tokenises every document on every query, which is exactly the
cost an index exists to remove.

---

## 11. Recovery Manager

**Concept.** The write-ahead rule: a log record describing a change reaches
stable storage before the changed page does. If the process dies at any
instant, the log alone decides what happened.

**Record format.**

```
uint32 payloadLength
uint64 lsn
uint8  type        1 BEGIN, 2 UPDATE, 3 COMMIT, 4 ABORT, 5 CHECKPOINT
uint32 txId, uint32 pageId
uint32 beforeLength, uint32 afterLength
bytes  beforeImage   (UNDO source)
bytes  afterImage    (REDO source)
```

Full page images rather than byte deltas: more disk, but REDO and UNDO each
become a single buffer write, which keeps the recovery algorithm short enough
to verify by hand.

**Algorithm — three passes.**

1. **Analysis.** Classify every transaction: a COMMIT record makes it a
   winner, a BEGIN without one makes it a loser.
2. **REDO.** Forward in LSN order, write the after-image of every winner's
   UPDATE. Replaying in LSN order reproduces the original execution, and REDO
   is idempotent, which is what makes a crash *during* recovery survivable.
3. **UNDO.** Backward from the end, write the before-image of every loser's
   UPDATE. Going backwards matters when one transaction wrote the same page
   repeatedly: the oldest before-image must land last.

Each loser then gets an ABORT record, so a second crash during recovery does
not repeat the work.

**Why both passes.** REDO because COMMIT only forces the log, so a crash can
fall between the COMMIT record and the page flush. UNDO because the buffer
pool steals, so an uncommitted dirty page can reach disk at any moment.

**Torn writes.** A trailing record whose declared length exceeds the remaining
bytes is a torn write from the crash. It is discarded, which is safe because
it was never acknowledged to any caller.

**Test.** `tests/unit/recovery.test.js` — winner/loser classification, REDO of
a committed page that never reached disk, UNDO of a stolen uncommitted page,
multiple writes undone to the oldest image, a winner and a loser on the same
page, idempotence, a truncated log tail, and a page the log mentions that the
file does not yet contain.

**Result.** `npm run demo:recovery` commits two chapters, starts a third
transaction, forces its dirty page to disk, kills the engine, restarts, and
shows the committed text intact and the uncommitted text gone — with the
recovery report naming the winners, the losers and the page counts.

---

## Reading the engine in dependency order

`phases.md` section 5 fixes the order in which these modules can be built, and
the same order is the best way to read them:

```
Storage Manager -> Buffer Pool -> Transaction Manager -> Lock Manager
  -> Conflict Resolver -> Scheduler & Worker Pool -> Message Queue
  -> Index Manager -> Recovery Manager -> Presentation Layer
```

Start at `src/engine/storage/Page.js` and finish at `src/engine/Engine.js`,
which is where the document layout policy and the locking policy for edits are
documented.
