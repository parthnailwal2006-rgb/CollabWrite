# Design Document (design.md)

## 1. Design Principles
| Principle              | Description |
|-----------             |-------------|
| Modularity             | Each academic concept lives in its own module with a clean public API. |
| Separation of Concerns | Presentation (React) never touches storage internals; the Express layer only forwards calls to the Engine. |
| Testability            | All modules expose functions that can be unit‑tested without a running server. |
| Educational Clarity    | Data structures and algorithms are kept simple and heavily commented so that a B.Tech student can read and explain them. |
| Data Consistency       | Transactions enforce ACID; the engine never exposes partially written pages to other transactions. |
| Failure Handling       | WAL guarantees durability; deadlock detection prevents indefinite waiting. |

## 2. Data Model
### Entities
| Entity              | Stored In          | Fields                                                 | notes |
|--------             |-----------         |--------                                                |------|
| **User**            | PostgreSQL         | `id`, `username`, `password_hash`, `role`              | authentication only |
| **Document**        | Engine (data files)| `docId`, `ownerId`, `currentVersion`, `metadata`       | stored as a series of pages |
| **DocumentVersion** | Engine             | `versionId`, `docId`, `timestamp`, `pagePointers[]`    | immutable snapshot |
| **ChangeLog**       | Engine             | `logId`, `txId`, `docId`, `operation`, `details`       | used for WAL and audit |
| **Transaction**     | Engine (in‑memory) | `txId`, `state`, `lockedResources[]`, `writtenPages[]` | not persisted except in WAL |
| **Lock**            | Engine (in‑memory) | `resourceId`, `mode` (S/X), `holderTxId`, `waitQueue[]`| lock table |
| **Session**         | Engine (in‑memory) | `sessionId`, `userId`, `connectedDocs[]`               | managed by Socket.IO |
| **IndexEntry**      | Engine             | `keyword`, `docIdList[]`                               | B+‑Tree leaf nodes |

### Ownership
- **PostgreSQL**: `User` table, optional audit logs.
- **Engine**: all other entities; they are persisted to binary files (`documents.dat`, `wal.log`, `index.dat`).

## 3. Storage Design
### Files
- `documents.dat` – sequence of fixed‑size pages (4 KB). Each page starts with a **Page Header**:
  ```text
  struct PageHeader {
    uint32 pageId;
    uint32 checksum;
    uint8  dirtyFlag; // 0 = clean, 1 = dirty
    uint16 recordCount;
  }
  ```
- `wal.log` – append‑only log of WAL records.
- `index.dat` – serialized B+‑Tree nodes.

### Record Layout (within a page)
```
struct RecordHeader {
  uint32 recordId;
  uint32 length;      // bytes of payload
  uint32 version;     // document version at write time
}
payload bytes …
```
Pages are linked via a simple **Page Directory** stored at the beginning of `documents.dat` mapping `docId → list of pageIds`.

## 4. Buffer Pool Design
- **Page Size**: 4 KB (chosen for easy calculation and to keep RAM usage low).
- **Pool Size**: configurable; default 8 pages (~32 KB), sufficient for a semester demo.
- **Data Structures**:
  - `pageTable: Map<pageId, BufferFrame>` where `BufferFrame` holds the page data, `pinCount`, `dirty` flag, and a timestamp for LRU.
  - `lruList` (doubly‑linked) to track usage order.
- **Operations**:
  1. `fetchPage(pageId)` – if in pool, increment `pinCount`; else load from disk, possibly evict LRU page (if `pinCount===0`).
  2. `unpinPage(pageId, isDirty)` – decrement `pinCount`; set `dirty` if changed.
  3. `flushPage(pageId)` – write to `documents.dat` if dirty, clear flag.
- **Eviction Policy**: Least‑Recently‑Used among pages with `pinCount===0`.

## 5. Transaction Design
### States
```
enum TxState { ACTIVE, COMMITTED, ABORTED }
```
### Metadata (stored in WAL only)
- `txId` – monotonically increasing integer.
- `startLSN` – LSN of the BEGIN record.
- `modifiedPages[]` – pageIds touched.
- `locksHeld[]` – resources locked.
### Lifecycle
1. **BEGIN** – write WAL `BEGIN(txId)`; create Tx object.
2. **READ** – fetch page via Buffer Pool (shared lock optional).
3. **WRITE** – acquire exclusive lock, fetch page, modify in memory, mark dirty, write WAL `UPDATE(txId, pageId, ... )`.
4. **COMMIT** – write WAL `COMMIT(txId)`, flush dirty pages, release locks, transition state.
5. **ABORT** – write WAL `ABORT(txId)`, undo modifications using before‑image stored in WAL, release locks.

## 6. Lock Manager Design
### Lock Modes
- **S** – shared, multiple holders.
- **X** – exclusive, single holder.
### Compatibility Matrix
| Requested \ Held | S | X |
|-------------------|---|---|
| **S** | ✅ | ❌ |
| **X** | ❌ | ❌ |
### Data Structures
- `lockTable: Map<resourceId, LockInfo>` where `LockInfo` contains `mode`, `holders:Set<txId>`, `waitQueue:Queue<LockRequest>`.
- `LockRequest` = `{ txId, mode, promiseResolve }`.
### Operations
- `acquire(txId, resourceId, mode)` returns a Promise that resolves when lock granted.
- `release(txId, resourceId)` removes holder, wakes next waiting request.
- **Deadlock Detection** runs every N ms or on lock wait:
  - Build **wait‑for graph**: edge `TxA -> TxB` if `TxA` waits for a lock held by `TxB`.
  - Detect cycles via DFS; choose victim with lowest `txId` (youngest) to abort.

## 7. Deadlock Detection Design
### Wait‑For Graph
- Nodes: active transactions.
- Directed edge `Ti -> Tj` if Ti is waiting for a lock held by Tj.
### Cycle Detection
- Use Tarjan’s strongly connected components algorithm; any SCC with >1 node is a deadlock.
### Victim Selection
- Simple heuristic: abort the transaction with the **fewest acquired locks** (or highest `txId`).
- After abort, its locks are released, breaking the cycle.
### Timeout Handling
- Optional timeout per lock request (configurable). After timeout, transaction aborts automatically.

## 8. Request Scheduler Design
- **Queue**: `requestQueue: Array<ScheduledTask>` where each task contains `txId`, `docId`, `operation`.
- **Scheduling Policies**:
  - **FIFO** – tasks processed in arrival order.
  - **Round‑Robin** – each worker picks the next task in a circular fashion.
  - **Priority (optional)** – tasks may carry a priority flag; higher priority tasks are placed ahead in the queue.
- **Metrics**: record enqueue time, start time, completion time for each task to compute average waiting, turnaround.

## 9. Message Queue Design
- Simple in‑memory queue `msgQueue: Queue<EditEvent>`.
- **Producer**: Workers push a committed `EditEvent` after transaction commit.
- **Consumer**: Collaboration Manager subscribes, reads events in order, and emits via Socket.IO to all clients subscribed to the document.
- Guarantees **FIFO per document** because events carry `docId` and are processed sequentially.

## 10. Conflict Resolution Design
### Version Numbers
- Each document page stores a `pageVersion`. When a transaction begins, it records the current version.
### Optimistic Check
- After acquiring locks, before writing, compare stored `pageVersion` with the version read earlier.
- If mismatch → **conflict** → abort transaction (or retry).
### Merge Strategy (simple)
- Non‑overlapping character ranges are merged automatically.
- Overlap leads to abort; client receives a “conflict” response and can retry.
### Note on OT/CRDT
- Full Operational Transformation is out of scope. The version‑based approach satisfies the academic goal while staying implementable.

## 11. Index Manager Design
- **Structure**: Classic B+‑Tree with internal nodes holding keys and child pointers, leaf nodes holding `keyword → Set<docId>`.
- **Key**: Lower‑cased keyword string.
- **Operations**:
  - `insert(keyword, docId)` – locate leaf, add docId, split if overflow.
  - `delete(keyword, docId)` – remove entry, merge/redistribute if underflow.
  - `search(keyword)` – locate leaf, return docId list.
- **Performance**: `O(log N)` lookup vs `O(N)` full‑file scan.
- **Persistence**: Tree nodes are serialized to `index.dat`; on start, tree is loaded into memory.

## 12. Recovery Manager Design
### WAL Record Types
| Type       | Fields |
|------      |--------|
| **BEGIN**  | `txId`, `timestamp` |
| **UPDATE** | `txId`, `pageId`, `beforeImage`, `afterImage` |
| **COMMIT** | `txId` |
| **ABORT**  | `txId` |
### Log Sequence Number (LSN)
- Monotonically increasing 64‑bit integer; each WAL record gets an LSN.
### REDO / UNDO
- **REDO**: On startup, scan WAL forward; for each `COMMIT` record, re‑apply corresponding `UPDATE`s that have LSN > last checkpoint.
- **UNDO**: For any transaction with a `BEGIN` but no `COMMIT`, apply the stored `beforeImage` to revert pages.
### Crash Simulation
- For testing, the assistant will provide a script that kills the server process after a random number of WAL writes.
### Checkpoint (optional)
- Periodic snapshot of `documents.dat` to truncate WAL (future improvement).

## 13. API Design
| Method          | URL | Body | Engine Call |
|--------|-----|------|-------------|
| `POST /api/login`       | `/api/login`         | `{username,password}` | AuthController → PostgreSQL |
| `POST /api/documents`   | `/api/documents`     | `{title}` | Creates metadata in PostgreSQL, creates empty document in Engine |
| `GET /api/documents/:id`| `/api/documents/:id` | – | Returns latest version pointer (Engine reads pages) |
| `POST /api/edit`        | `/api/edit`          | `{docId, ops, version}` | Scheduler receives request, creates transaction, goes through lock/transaction flow |
| `GET /api/search?q=`    | `/api/search`        | query param | IndexManager lookup; falls back to full scan if index disabled |
| WebSocket `edit` event  | `ws://.../socket.io` | `{docId, ops}` | Workers broadcast via Message Queue |

All routes perform **authentication** and **role** checks against PostgreSQL before invoking the engine.

## 14. Error Handling
- **Invalid Document ID** – 404 response; engine returns `DocumentNotFound`.
- **Permission Failure** – 403 response; engine checks role before scheduling.
- **Transaction Conflict** – 409 Conflict; client receives conflict details to retry.
- **Deadlock Abort** – 409 with `deadlock` flag; victim transaction is aborted and client notified.
- **Storage Errors** – 500; engine logs error, attempts graceful shutdown.
- **Recovery Failure** – 500; system enters safe mode, refuses new edits until manual admin reset.

## 15. Testing Design
| Module              | Unit Tests                                       | Integration Tests 
|--------             |------------                                      |-------------------
| Storage Manager     | page read/write, checksum validation             | end‑to‑end document version persistence |
| Buffer Pool         | LRU ordering, dirty handling                     | transaction commit triggers flush |
| Transaction Manager | begin/commit/abort paths, WAL records            | concurrent transactions with lock manager |
| Lock Manager        | lock compatibility, wait queue                   | deadlock scenario detection |
| Scheduler           | FIFO ordering, round‑robin distribution          | load test with many edit requests |
| Message Queue       | ordering guarantees                              | real‑time UI update verification |
| Conflict Resolver   | version mismatch abort, merge success            | two browsers editing same region |
| Index Manager       | insert/delete/search correctness, tree balancing | search performance benchmark |
| Recovery Manager    | REDO/UNDO correctness after simulated crash      | full system restart after crash |

Automated tests use **Jest** (or Mocha) and run via `npm test`.

## 16. Performance Evaluation
- **Request Waiting Time** – measured from enqueue to start of transaction.
- **Transaction Completion Time** – commit latency.
- **Lock Wait Time** – per transaction, aggregated.
- **Page Access Count** – buffer‑pool hits vs misses.
- **Recovery Time** – time to replay WAL on startup.
- **Search Latency** – indexed vs full‑scan on 100+ documents.
- Metrics are logged to `metrics.log` and plotted in the final report.

## 17. Design Trade‑offs
| Trade‑off                               | Reasoning 
|-----------                              |-----------
| Fixed‑size 4 KB pages                   | Simplicity; easier to calculate offsets and keep memory usage predictable. |
| In‑memory lock table                    | Sufficient for a single‑node prototype; avoids distributed lock service complexity. |
| Simple version‑based conflict detection | Guarantees correctness without implementing full OT/CRDT, which is beyond semester scope. |
| B+‑Tree over hash index                 | B+‑Tree demonstrates node splitting/merging, a classic DBMS concept. |
| Small buffer pool (8 pages)             | Demonstrates hits/misses without large RAM; students can observe behaviour. |
| Single‑process WAL file                 | Simpler than persisting logs across multiple nodes; adequate for crash‑recovery demo. |

---
*End of design.md*
