# Operating Systems and DBMS Concepts in CollabWrite

This is the traceability matrix `prd.md` section 11 asks for: every academic
concept, the module that implements it, the test that proves it works, and
the demo that shows it during evaluation.

**The rule these entries obey** (`rules.md` sections 2 and 9): a framework
feature is not a demonstration of a concept. PostgreSQL transactions are not
our transaction manager, its row locks are not our lock manager, its B-Tree
is not our index, the event loop is not our scheduler, and Socket.IO's
routing is not our message-passing layer. Every row below names code we
wrote.

## 1. Operating Systems concepts

| Concept | Implementation | Code | Test | Demo |
|---------|----------------|------|------|------|
| Process/thread scheduling | FIFO and round-robin dispatch with waiting and turnaround metrics | `engine/scheduler/Scheduler.js` | `tests/unit/scheduler.test.js` | `demo:scheduling` |
| Threads and bounded concurrency | Fixed worker pool with an explicit IDLE/BUSY state machine | `engine/scheduler/WorkerPool.js` | `tests/unit/scheduler.test.js` | `demo:scheduling` |
| Mutual exclusion | Exclusive lock mode in the lock table | `engine/lock/LockManager.js` | `tests/unit/lockManager.test.js` | `demo:concurrency` |
| Readers-writers | Shared/exclusive compatibility with writer anti-starvation | `engine/lock/LockManager.js` | `tests/unit/lockManager.test.js` | `demo:concurrency` |
| Deadlock detection | Wait-for graph plus Tarjan's SCC | `engine/lock/DeadlockDetector.js` | `tests/unit/deadlockDetector.test.js` | `demo:deadlock` |
| Deadlock prevention | Total ordering of lock acquisition on the edit path | `engine/Engine.js`, `executeEdit` | `tests/integration/engine.test.js` | `demo:concurrency` |
| Deadlock recovery | Victim selection and rollback | `engine/lock/DeadlockDetector.js` | `tests/unit/deadlockDetector.test.js` | `demo:deadlock` |
| Memory management, paging | Fixed 4 KiB pages through a bounded frame pool | `engine/buffer/BufferPool.js` | `tests/unit/bufferPool.test.js` | `demo:buffer` |
| Page replacement (LRU) | Doubly-linked list plus map, O(1) touch and evict | `engine/buffer/LRUCache.js` | `tests/unit/bufferPool.test.js` | `demo:buffer` |
| Resource pinning | Pin counts; a pinned page is never evicted | `engine/buffer/BufferPool.js` | `tests/unit/bufferPool.test.js` | `demo:buffer` |
| Message passing | In-memory producer-consumer queue with FIFO-per-document ordering | `engine/messaging/MessageQueue.js` | `tests/unit/messaging.test.js` | `demo:concurrency` |
| Starvation avoidance | No barging past a queued writer; round-robin across documents | `LockManager.canGrant`, `Scheduler.dequeue` | `tests/unit/lockManager.test.js` | `demo:scheduling` |

## 2. DBMS concepts

| Concept | Implementation | Code | Test | Demo |
|---------|----------------|------|------|------|
| Transactions and ACID | BEGIN/COMMIT/ABORT with state tracking | `engine/transaction/TransactionManager.js` | `tests/unit/transaction.test.js` | `demo:transactions` |
| Atomicity | UNDO from WAL before-images | `TransactionManager.abort` | `tests/unit/transaction.test.js` | `demo:transactions` |
| Isolation | Strict two-phase locking | `engine/lock/LockManager.js` | `tests/unit/transaction.test.js` | `demo:concurrency` |
| Durability | COMMIT record fsync'd before the commit returns | `engine/recovery/WAL.js` | `tests/unit/recovery.test.js` | `demo:recovery` |
| Two-phase locking | Growing phase on acquire, shrinking at commit/abort | `engine/lock/LockManager.js` | `tests/unit/lockManager.test.js` | `demo:concurrency` |
| Optimistic concurrency control | Version check under the lock, abort on mismatch | `engine/conflict/ConflictResolver.js` | `tests/unit/conflictResolver.test.js` | `demo:transactions` |
| Write-ahead logging | Length-framed binary log with LSNs and page images | `engine/recovery/WAL.js` | `tests/unit/recovery.test.js` | `demo:recovery` |
| REDO / UNDO recovery | Three passes: analysis, forward REDO, backward UNDO | `engine/recovery/RecoveryManager.js` | `tests/unit/recovery.test.js` | `demo:recovery` |
| Buffer policy (STEAL/FORCE) | Eviction may write uncommitted pages; commit forces | `TransactionManager` | `tests/unit/transaction.test.js` | `demo:transactions` |
| Page and record organisation | Page header, record headers, page directory | `engine/storage/Page.js` | `tests/unit/storage.test.js` | `demo:buffer` |
| Checksums and integrity | CRC-32 per page, verified on read | `engine/storage/Page.js` | `tests/unit/storage.test.js` | - |
| Indexing (B+-Tree) | Split, borrow, merge; chained leaves | `engine/index/BPlusTree.js` | `tests/unit/index.test.js` | `demo:index` |
| Index versus full scan | Measured benchmark, both paths compared for equality | `engine/index/IndexManager.js` | `tests/unit/index.test.js` | `demo:index` |
| Range and prefix queries | Leaf-chain walk | `BPlusTree.rangeScan` | `tests/unit/index.test.js` | `demo:index` |
| Checkpointing | Flush, fsync, CHECKPOINT record | `RecoveryManager.checkpoint` | - | - |

## 3. Four concepts in detail

### 3.1 Readers-writers with writer anti-starvation

The naive readers-writers solution grants a shared lock whenever no writer
holds it. Under a steady stream of readers, a waiting writer never runs.

```js
canGrant(info, txId, mode) {
  // A queued request blocks everyone behind it, even compatible ones.
  if (info.waitQueue.some((r) => r.txId !== txId)) return false;
  for (const [holderTx, holderMode] of info.holders) {
    if (holderTx === txId) continue;
    if (!isCompatible(mode, holderMode)) return false;
  }
  return true;
}
```

The cost is slightly lower read concurrency; the benefit is a bound on how
long any writer waits. `tests/unit/lockManager.test.js` asserts that a
shared request arriving behind a queued writer waits for it.

### 3.2 Deadlock prevention *and* detection

Both appear, for different paths, and the distinction is worth making
explicitly rather than claiming the detector is always load-bearing:

- **Prevention** on the edit path. `Engine.executeEdit` locks pages in
  ascending page order. A total order makes a wait-for cycle impossible.
- **Detection** for the general transaction API, where a caller may lock
  several documents in any order. That is the case `demo:deadlock` builds.

### 3.3 Why STEAL forces UNDO to exist

If the buffer pool could never evict an uncommitted page (NO-STEAL), an abort
would only need to drop the in-memory frame. But NO-STEAL requires the pool
to be large enough to pin every page every active transaction has touched,
which a bounded pool cannot promise.

So the pool steals, an uncommitted page can reach disk, and ABORT must write
the before-image back through to disk rather than merely discarding a frame.
`tests/unit/transaction.test.js` forces exactly this: it flushes a dirty
uncommitted page, confirms the garbage is on disk, then aborts and confirms
the original is restored.

### 3.4 Leaf and internal occupancy are different bounds

```
leafMinKeys     = ceil(maxKeys / 2)
internalMinKeys = ceil((maxKeys + 1) / 2) - 1
```

A leaf holds data and must stay half full. An internal node is constrained by
its *child* count. At `maxKeys = 3` an internal node may legitimately hold
one key while a leaf may not. Using one bound for both is the classic
B+-Tree bug, and this project hit it: the first randomised trial at fanout 3
reported underfull internal nodes. The property test now covers four fanouts
specifically to keep it caught.

## 4. What PostgreSQL does, stated once

PostgreSQL stores users, password hashes, document metadata, permissions and
audit logs. That is authentication and bookkeeping. It performs no part of
the concurrency control, logging, recovery, caching or indexing described
above, and the CI `schema` job fails the build if an engine-owned table
appears in it.
