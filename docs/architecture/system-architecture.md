# System Architecture

Implements `architecture.md` at the repository root. That document is the
specification; this one maps it onto the code.

## 1. Four layers

```
+-----------------------------------------------------------------+
|  Presentation Layer            src/client/                      |
|  React editor. Captures keystrokes, renders remote edits and     |
|  presence. Holds no concurrency logic.                           |
+-----------------------------------------------------------------+
            | REST (fetch)            | WebSocket (Socket.IO)
            v                         v
+-----------------------------------------------------------------+
|  Application Layer             src/server/                      |
|  Express + Socket.IO. Authenticates, authorises, validates, and  |
|  forwards. No business logic.                                    |
+-----------------------------------------------------------------+
            | submitEdit / readDocument / search
            v
+-----------------------------------------------------------------+
|  Academic Engine Layer         src/engine/                      |
|                                                                  |
|   Scheduler -> Worker Pool -> Transaction Manager                |
|                                 |-> Lock Manager -> Deadlock Det.|
|                                 |-> Conflict Resolver            |
|                                 |-> Buffer Pool -> Storage Mgr   |
|                                 |-> Recovery Manager (WAL)       |
|   Index Manager          Message Queue -> Collaboration Manager  |
+-----------------------------------------------------------------+
            |                                    |
            v                                    v
+----------------------------+      +----------------------------+
|  Storage Layer             |      |  Supporting DB             |
|  documents.dat             |      |  PostgreSQL                |
|  wal.log                   |      |  users, document metadata, |
|  index.dat                 |      |  permissions, audit logs   |
+----------------------------+      +----------------------------+
```

The engine sits **between** the application layer and storage so that every
collaborative-editing operation passes through our own OS/DBMS mechanisms.
There is no path from the API to a page that bypasses it.

## 2. The life of an edit

A single `POST /api/documents/:id/edit` traverses the whole system:

| # | Where | What happens |
|---|-------|--------------|
| 1 | `middleware/auth.js` | JWT verified; the caller's role on this document is checked. An unauthorised edit never reaches the engine, so it never occupies a worker or takes a lock. |
| 2 | `editController.js` | The operation shape is validated and clamped. |
| 3 | `Scheduler.submit` | The request is queued and `enqueuedAt` recorded. |
| 4 | `WorkerPool.acquire` | An idle worker is assigned; `startedAt` recorded. |
| 5 | `TransactionManager.begin` | A transaction id is allocated and a WAL BEGIN record written. |
| 6 | `LockManager.acquire` | Exclusive locks on every page of the document, in ascending page order. |
| 7 | `ConflictResolver` | The client's `baseVersion` is compared with the document's current version. A mismatch aborts here. |
| 8 | `BufferPool.fetchPage` | Pages are read, from memory on a hit, through the storage manager on a miss. |
| 9 | `WAL.logUpdate` | A before- and after-image is logged **before** the page is modified. |
| 10 | `TransactionManager.commit` | COMMIT record written and fsync'd, dirty pages flushed, all locks released. |
| 11 | `IndexManager.indexDocument` | The B+-Tree is updated — after the commit, because an aborted edit must not be indexed. |
| 12 | `MessageQueue.publish` | The committed event is queued with a per-document sequence number. |
| 13 | `CollaborationManager` | Consumes the event and broadcasts through the Socket.IO transport. |

Steps 5 to 10 are the transaction. Steps 11 to 13 are post-commit side
effects, and neither may resurrect work that was rolled back.

## 3. Document layout

A document occupies a chain of pages recorded in the storage manager's page
directory:

```
page[0]  record 0 = metadata JSON {title, ownerId, length, updatedAt}
         record 1 = text chunk 0
page[n]  record 1 = text chunk n
```

The document text is the concatenation of the chunks in page order. The
document version is the **record header version of the metadata record**,
bumped once per committed edit. Keeping the version in a record header rather
than inventing a new page-header field is what lets the on-disk page layout
stay exactly as `design.md` section 3 specifies.

Chunks are split on UTF-8 boundaries, so a multi-byte character is never torn
across a page.

## 4. Locking policy for edits

An edit transaction takes an exclusive lock on **every page of the target
document**, acquired in **ascending page order**.

Taking every page matters because an insert near the start of a document
shifts every later chunk, so an edit is rarely confined to one page.
Acquiring in ascending order matters more: a total order over lock
acquisition makes the edit path deadlock-free by construction.

Consequences, stated plainly:

- Two edits to the **same** document serialise. Three users typing in one
  document commit one after another, which is what "no lost updates" costs.
- Edits to **different** documents run fully concurrently, bounded only by
  the worker pool.
- The deadlock detector is not load-bearing for editing. It serves the
  general transaction API, where a caller may lock several documents in any
  order, and that is what the deadlock demo exercises.

`design.md` section 17 records this as a trade-off: less intra-document
concurrency in exchange for an edit path that cannot deadlock.

## 5. Component responsibilities

| Component | File | Owns |
|-----------|------|------|
| Request Scheduler | `engine/scheduler/Scheduler.js` | Queueing policy, dispatch, waiting-time metrics |
| Worker Pool | `engine/scheduler/WorkerPool.js` | Bounded concurrency, worker state |
| Transaction Manager | `engine/transaction/TransactionManager.js` | ACID lifecycle, STEAL/FORCE policy |
| Lock Manager | `engine/lock/LockManager.js` | Lock table, wait queues, 2PL |
| Deadlock Detector | `engine/lock/DeadlockDetector.js` | Wait-for graph, Tarjan SCC, victim choice |
| Conflict Resolver | `engine/conflict/ConflictResolver.js` | Version checks, disjoint-edit merge |
| Buffer Pool | `engine/buffer/BufferPool.js` | Frame cache, LRU, pin counts, dirty tracking |
| Storage Manager | `engine/storage/StorageManager.js` | Page I/O, page directory, checksums |
| Index Manager | `engine/index/IndexManager.js` | Inverted index over a B+-Tree |
| Recovery Manager | `engine/recovery/RecoveryManager.js` | WAL, REDO/UNDO, crash recovery |
| Message Queue | `engine/messaging/MessageQueue.js` | FIFO-per-document delivery |
| Collaboration Manager | `engine/messaging/CollaborationManager.js` | Sessions, presence, broadcast |

Each is explained in the six-step format in [`../engine/README.md`](../engine/README.md).

## 6. Start-up and shutdown order

Start-up order is enforced in `src/server/index.js` and is not arbitrary:

1. Open the support store (PostgreSQL) — needed for authentication.
2. Start the engine: open `documents.dat` and `wal.log`, **run crash
   recovery**, rebuild the index, start the scheduler and the deadlock sweep.
3. Only then bind the HTTP and WebSocket listeners.

Accepting a request before recovery finished would let a client read a page
that is about to be rolled back, which would defeat the recovery manager
entirely.

Shutdown reverses it: stop accepting connections, flush the buffer pool,
persist the index, fsync and close the files.

## 7. The PostgreSQL boundary

| Stored in PostgreSQL | Owned by the engine |
|----------------------|---------------------|
| User accounts, password hashes | Document content |
| Document metadata: title, owner, timestamps | Document versions |
| Permission table (owner / editor / viewer) | Change log (`wal.log`) |
| Administrative audit logs | Lock table |
| | Keyword index (`index.dat`) |

`database/init.sql` contains four tables and no more. The absence of
`document_versions`, `change_logs` and `document_locks` is a design statement,
not an omission, and CI enforces it: the `schema` job fails the build if any
of those tables or a `content` column on `documents` reappears.

## 8. Failure behaviour

| Failure | Engine reaction |
|---------|-----------------|
| Worker fails mid-transaction | The thrown error aborts the transaction: before-images restored, ABORT logged, locks released. |
| Conflict detected after locking | Abort, 409 with the current version, client rebases. |
| Crash before the COMMIT record | Recovery classifies the transaction a loser and UNDOes its pages. |
| Crash after COMMIT, before the flush | Recovery REDOes the after-images from the log. |
| Crash during the final log write | The torn trailing record is discarded; it was never acknowledged. |
| Deadlock | Detector picks a victim, releases its locks, the survivor proceeds. |
| Every buffer frame pinned | `BufferPoolFullError` → 503, rather than violating the pin invariant. |
| Message queue full | `QueueFullError` → 503, rather than growing without bound. |
