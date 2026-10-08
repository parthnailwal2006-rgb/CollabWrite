# Architecture Document

## 1. Architecture Overview
The system is divided into four logical layers:

1. **Presentation Layer** – React front‑end with a rich‑text editor. It renders the UI, captures user keystrokes and forwards edit operations via Socket.IO.
2. **Application Layer** – Express HTTP server that authenticates users, authorises requests, and provides thin REST/WebSocket adapters. It **does not** contain any business logic; it only forwards calls to the Academic Engine.
3. **Academic Engine Layer** – The educational core that demonstrates OS and DBMS concepts. It includes:
   - Request Scheduler
   - Worker Pool
   - Transaction Manager
   - Lock Manager
   - Conflict Resolver
   - Message Queue
   - Buffer‑Pool Manager
   - Storage Manager
   - Index Manager
   - Recovery (WAL) Manager
4. **Storage Layer** – A file‑based data store used by the Academic Engine for document records, pages, and WAL files. PostgreSQL is used *only* for auxiliary data such as user accounts, authentication tokens, and optional admin logs.

The Academic Engine is deliberately placed **between** the Application Layer and the Storage Layer so that every collaborative‑editing operation passes through our own OS‑DBMS mechanisms.

## 2. High‑Level Architecture Diagram
```mermaid
flowchart TB
    subgraph Presentation[Presentation Layer]
        React[React Editor]
    end
    subgraph App[Application Layer]
        Express[Express API]
        SocketIO[Socket.IO]
    end
    subgraph Engine[Academic Engine Layer]
        Scheduler[Request Scheduler]
        Workers[Worker Pool]
        TxMgr[Transaction Manager]
        LockMgr[Lock Manager]
        Conflict[Conflict Resolver]
        MsgQueue[Message Queue]
        BufPool[Buffer‑Pool Manager]
        StorageMgr[Storage Manager]
        IndexMgr[Index Manager]
        RecoveryMgr[Recovery (WAL) Manager]
    end
    subgraph Storage[Storage Layer]
        DataFiles[Data Files]
        WAL[WAL Log]
    end
    subgraph SupportDB[Supporting DB]
        Postgres[PostgreSQL]
    end

    React -->|WebSocket| SocketIO
    React -->|REST| Express
    Express --> Scheduler
    SocketIO --> Scheduler
    Scheduler --> Workers
    Workers --> TxMgr
    TxMgr --> LockMgr
    TxMgr --> Conflict
    TxMgr --> BufPool
    TxMgr --> RecoveryMgr
    LockMgr --> Conflict
    Conflict --> BufPool
    BufPool --> StorageMgr
    StorageMgr --> DataFiles
    RecoveryMgr --> WAL
    IndexMgr --> DataFiles
    Workers --> MsgQueue
    MsgQueue --> SocketIO
    Postgres --> Express
    Postgres --> StorageMgr
```

## 3. Module Responsibilities
### Request Scheduler
* Receives edit requests from the Express API / Socket.IO.
* Places each request into an **in‑memory FIFO queue**.
* Assigns requests to idle workers based on a scheduling policy (FIFO, Round‑Robin, optional priority).
* Emits metrics: queue length, wait time.

### Worker Pool
* Fixed‑size pool of Node.js worker threads (or child processes) that execute tasks concurrently.
* Each worker pulls a request from the Scheduler, invokes the Transaction Manager, and reports success/failure back to the Scheduler.
* Demonstrates OS‑style concurrency and resource sharing.

### Transaction Manager
* Implements the lifecycle of a transaction: `BEGIN`, `READ/WRITE`, `COMMIT`, `ABORT`.
* Generates a unique Transaction ID (TID) and tracks its state (Active, Committed, Aborted).
* Coordinates with the Lock Manager to acquire necessary locks before any write.
* Writes **WAL** records before modifying the buffer pool (ensuring durability).
* On `COMMIT` triggers the Recovery Manager to flush dirty pages.

### Lock Manager
* Maintains a **Lock Table** mapping `(document_id, page_id, region?)` → lock holders.
* Supports **Shared (S)** and **Exclusive (X)** lock modes.
* Enqueues waiting transactions when a lock is unavailable.
* Provides dead‑lock detection via a Wait‑For Graph (see Deadlock Detection design).

### Conflict Resolver
* Performs **optimistic version checks** after a transaction obtains its locks.
* Detects overlapping edits (e.g., two transactions editing the same character range).
* Either merges non‑conflicting changes automatically or rejects the transaction, forcing the client to retry.

### Message Queue
* Internal **producer‑consumer** queue used by Workers to send committed edit events to the Collaboration Manager.
* Guarantees ordering of committed operations per document.
* The Collaboration Manager broadcasts these events via Socket.IO to all connected clients.

### Storage Manager
* Provides CRUD‑style operations on **record pages** stored in binary data files.
* Abstracts file I/O away from higher layers; works with page IDs supplied by the Buffer‑Pool.
* Handles persistence of document metadata, version snapshots, and change logs.

### Buffer‑Pool Manager
* In‑memory cache of fixed‑size pages (e.g., 4 KB each).
* Implements **LRU** replacement, dirty‑page tracking, pin/unpin semantics.
* Supplies pages to the Transaction Manager on demand; writes back to disk on eviction or commit.

### Index Manager
* Implements a **B+‑Tree** index on `(keyword → document_id)` for fast search.
* Supports Insert, Delete, Point Lookup, and optional Range Scan.
* Provides a benchmark mode to compare indexed vs full‑scan performance.

### Recovery Manager
* Implements **Write‑Ahead Logging (WAL)**.
* On every modifying operation writes a log record **before** the page is changed.
* Stores `BEGIN`, `UPDATE`, `COMMIT`, and `ABORT` records with Log Sequence Numbers (LSN).
* On server start after a crash, performs **REDO** of committed records and **UNDO** of incomplete ones.

## 4. Data Flow (Edit Operation)
1. **User** types in the React editor → Socket.IO emits an **EditRequest** event.
2. **Express / Socket.IO** handler forwards the request to the **Request Scheduler**.
3. Scheduler enqueues the request and assigns it to a **Worker**.
4. Worker invokes **Transaction Manager** → `BEGIN` (writes WAL BEGIN).
5. Transaction Manager asks **Lock Manager** for required locks (shared for read, exclusive for write).
6. Lock Manager grants locks or queues the transaction.
7. Transaction reads the required page via **Buffer‑Pool** (page loaded from **Storage Manager** if not cached).
8. Conflict Resolver checks version numbers; if conflict → abort transaction.
9. If no conflict, transaction writes modifications to the buffered page and logs an **UPDATE** record to WAL.
10. On `COMMIT`, Transaction Manager writes a **COMMIT** record, signals **Recovery Manager** to flush dirty pages, releases locks.
11. **Message Queue** receives the committed edit event, broadcasts via **Socket.IO** to all other clients.
12. Clients receive the update and apply it to their local editor state.

## 5. Concurrency Architecture
* Multiple Workers run concurrently, each handling a distinct transaction.
* **Two‑Phase Locking (2PL)** guarantees serializable execution:
  - **Growing phase** – locks are acquired; no lock is released.
  - **Shrinking phase** – after `COMMIT`/`ABORT`, all held locks are released.
* **Version numbers** on each document page enable optimistic checks after lock acquisition.
* **Deadlock detection** runs periodically (or on lock wait) to break cycles.
* The Scheduler ensures fairness (FIFO) and optionally Round‑Robin distribution of tasks.

## 6. Failure Architecture
| Failure Scenario | Engine Reaction |
|------------------|-----------------|
| Worker thread crashes mid‑transaction | Transaction remains in **Active** state; Lock Manager holds locks. Recovery Manager’s **WAL** contains a `BEGIN` without `COMMIT`; on next server start the transaction is **ABORTED** and locks are released. |
| Transaction abort due to conflict | Transaction Manager writes an **ABORT** record to WAL, releases all locks, discards buffered changes. |
| Server crash **before** WAL `COMMIT` | On restart, Recovery Manager scans WAL: `BEGIN` without `COMMIT` → **UNDO** of any dirty pages, release locks. |
| Server crash **after** WAL `COMMIT` but before page flush | Recovery Manager performs **REDO** of committed records from WAL, ensuring durability. |
| Lock never released (programmer error) | Deadlock detector eventually identifies a wait‑for cycle; victim transaction is aborted, releasing its locks. |
| Conflict detected after lock acquisition | Transaction aborts, writes `ABORT` to WAL, releases locks; client receives retry instruction. |

## 7. PostgreSQL Boundary
* **Stored in PostgreSQL**: user credentials, authentication tokens, role definitions, audit logs, and optional meta‑information about documents (e.g., document titles for UI list).
* **Handled by our Engine**: the actual collaborative editing workflow—document content, versioning, concurrency control, indexing, and recovery. The engine reads/writes raw binary files; PostgreSQL is never used for document storage or locking.

## 8. Architecture Decisions
* **Node.js + Express** – lightweight, event‑driven runtime suitable for prototyping OS‑style concurrency with worker threads.
* **React** – familiar front‑end framework for a responsive rich‑text editor.
* **Socket.IO** – simple bi‑directional real‑time channel, used only for UI updates (message passing demonstration).
* **PostgreSQL** – reliable relational DB for authentication; kept minimal to avoid hiding academic mechanisms.
* **File‑based storage** – gives us full control over page layout, buffer pool, and WAL, essential for teaching DBMS internals.
* **Custom Transaction & Lock Managers** – showcase OS synchronization and DBMS ACID guarantees; cannot be delegated to PostgreSQL.
* **Mini B+‑Tree Index** – educational implementation of indexing without relying on PostgreSQL indexes.
* **Write‑Ahead Log** – classic recovery technique; demonstrates durability and crash recovery.

---
*End of Architecture Document*
