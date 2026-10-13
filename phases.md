# Phases Document (phases.md)

## 1. Development Strategy
The project is **incremental**. Each phase delivers a self‑contained, demonstrable subset of the overall system. Incremental development lets the team:
- Validate OS/DBMS concepts one at a time.
- Keep the codebase testable and understandable.
- Adjust scope based on time and learning curves.
- Ensure that a later phase never starts before the previous phase is **completed, unit‑tested, and approved**.

## 2. Phase Structure
Below is the recommended phase breakdown. Phases are ordered by dependency; a later phase assumes the artefacts of earlier phases are functional.

---
### Phase 0 – Documentation & Architecture
* **Objective**: Establish a solid foundation.
* **Deliverables**: `prd.md`, `architecture.md`, `rules.md`, `phases.md`, `design.md`, `memory.md`.
* **Key Activities**: Finalise requirements, data structures, testing strategy, and project plan.
* **Success Criteria**: All six documents approved by the mentor; clear traceability matrix.

---
### Phase 1 – Project Foundation
| Item                    | Details 
|------                   |---------
| **Goal**                | Set up repository, tooling, and basic UI/backend scaffolding. |
| **OS/DBMS Concepts**    | None (foundation only). |
| **Features**            | Git repo, `package.json`, React skeleton, Express server, PostgreSQL connection, basic CI pipeline. |
| **Modules / Files**     | `src/client/` (React app), `src/server/` (Express app), `src/config/` (DB config). |
| **Dependencies**        | Node.js, npm, `react`, `express`, `pg`, `socket.io`. |
| **Testing**             | Verify server starts, DB connection works, React renders a placeholder page. |
| **Completion Criteria** | `npm start` runs both client and server, login page appears. |
| **Risks**               | Environment setup issues; mitigated by using `npm ci` and documented scripts. |

---
### Phase 2 – Basic Document Management
| Item                 | Details 
|------                |---------
| **Goal**             | Provide CRUD for documents using PostgreSQL **only** for metadata. |
| **OS/DBMS Concepts** | None (still using PostgreSQL for these ops). |
| **Features**         | User registration/login, document create/open/delete, permission tables. |
| **Modules**          | `authController.js`, `docController.js`, DB schema `users`, `documents`, `doc_permissions`. |
| **Testing**          | End‑to‑end API tests (SuperTest), JWT validation, role checks. |
| **Completion**       | UI list of documents, ability to open a document (empty content). |
| **Risks**            | Over‑reliance on PostgreSQL – must label these operations as *supporting* only. |

---
### Phase 3 – Storage Manager (Mini File Engine)
| **Goal**             | Implement a file‑based storage layer that holds raw document pages and version snapshots. |
| **OS/DBMS Concepts** | Resource management (disk I/O), basic file organization. |
| **Features**         | Data file format, record insertion, read, update, delete; page abstraction (fixed 4 KB). |
| **Modules**          | `storageManager.js`, `page.js`, binary file `documents.dat`. |
| **Data Structures**  | Page header (pageId, checksum, dirty flag), record header (recordId, length, version). |
| **Testing**          | Unit tests for page read/write, record CRUD, file integrity checks. |
| **Completion**       | Ability to persist a document version to disk and retrieve it via API (no real‑time yet). |
| **Risks**            | Binary file corruption – use checksum and simple validation. |

---
### Phase 4 – Buffer‑Pool Manager
| **Goal**             | Cache pages in memory, implement LRU replacement, pin/unpin semantics. |
| **OS/DBMS Concepts** | Memory management, page replacement algorithm. |
| **Features**         | Fixed‑size pool (e.g., 8 pages), dirty‑page tracking, automatic flush on eviction or commit. |
| **Modules**          | `bufferPool.js`, `lruCache.js`. |
| **Testing**          | Simulate page accesses, verify LRU order, ensure dirty pages are written back. |
| **Completion**       | Buffer pool serves pages to the Transaction Manager; logs show hit/miss stats. |

---
### Phase 5 – Transaction Manager
| **Goal**             | Provide ACID transaction lifecycle for edit operations. |
| **OS/DBMS Concepts** | Transactions, atomicity, durability (via WAL). |
| **Features**         | `BEGIN`, `COMMIT`, `ABORT`; transaction ID generation, state tracking, interaction with WAL. |
| **Modules**          | `transactionManager.js`, `transaction.ts` (optional TypeScript). |
| **Testing**          | Unit tests for commit/abort paths, integration test with Storage Manager (write‑then‑rollback). |
| **Completion**       | API `POST /edit` starts a transaction, writes a page, commits, and returns success. |

---
### Phase 6 – Lock Manager
| **Goal**             | Serialise access to document pages using two‑phase locking. |
| **OS/DBMS Concepts** | Synchronisation, lock compatibility, deadlock detection. |
| **Features**         | Shared (S) / Exclusive (X) locks, lock table, waiting queue, deadlock detector (wait‑for graph). |
| **Modules**          | `lockManager.js`, `deadlockDetector.js`. |
| **Testing**          | Scenarios with conflicting lock requests, verify blocking and eventual grant; deadlock cycle test. |
| **Completion**       | Transactions acquire/release locks correctly; deadlock detection logs victim. |

---
### Phase 7 – Request Scheduler
| **Goal**             | Queue incoming edit requests and assign them to workers based on a scheduling policy. |
| **OS/DBMS Concepts** | Scheduling, resource allocation, fairness. |
| **Features**         | FIFO queue, Round‑Robin worker assignment, optional priority flag, metrics collection. |
| **Modules**          | `scheduler.js`, `workerPool.js`. |
| **Testing**          | Submit a burst of requests, verify order and distribution across workers; measure average wait time. |
| **Completion**       | Scheduler logs show tasks being dispatched; workers process them concurrently. |

---
### Phase 8 – Message Queue & Real‑Time Collaboration
| **Goal**             | Decouple workers from the UI broadcast layer and demonstrate producer‑consumer communication. |
| **OS/DBMS Concepts** | Message passing, queue ordering. |
| **Features**         | In‑memory queue, `publish` from workers, `consume` by Collaboration Manager, Socket.IO broadcast. |
| **Modules**          | `msgQueue.js`, `collabManager.js`. |
| **Testing**          | Simulate multiple workers publishing edits; ensure clients receive updates in the correct order. |
| **Completion**       | Live UI shows edits from other users instantly. |

---
### Phase 9 – Conflict Resolution
| **Goal**             | Detect and resolve overlapping edits using optimistic version checks (or simple OT). |
| **OS/DBMS Concepts** | Concurrency control, versioning, conflict handling. |
| **Features**         | Document version number per page, conflict detection after lock acquisition, automatic merge for non‑overlapping changes, abort‑and‑retry for conflicts. |
| **Modules**          | `conflictResolver.js`. |
| **Testing**          | Two concurrent transactions edit the same region; expect one abort and the other to commit. |
| **Completion**       | Demonstration where two browsers attempt conflicting edits and the system resolves them gracefully. |

---
### Phase 10 – Index Manager
| **Goal**             | Implement a B+‑Tree index for keyword → document‑ID lookup. |
| **OS/DBMS Concepts** | Indexing, tree data structures, performance trade‑offs. |
| **Features**         | Insert, delete, point lookup, range scan, benchmark mode comparing with full‑file scan. |
| **Modules**          | `bplusTree.js`, `indexManager.js`. |
| **Testing**          | Insert 200 documents, search for a keyword; verify O(log N) behavior and compare timings. |
| **Completion**       | UI search bar returns results faster when index is enabled; benchmark report displayed. |

---
### Phase 11 – Recovery Manager
| **Goal**             | Ensure durability via Write‑Ahead Logging (WAL) and implement crash recovery. |
| **OS/DBMS Concepts** | Logging, REDO/UNDO, durability. |
| **Features**         | WAL file format, `BEGIN`, `UPDATE`, `COMMIT`, `ABORT` records, LSN tracking, recovery routine that runs on server start. |
| **Modules**          | `wal.js`, `recoveryManager.js`. |
| **Testing**          | Simulate crash after a series of writes (kill process), restart, verify only committed transactions are present. |
| **Completion**       | Demonstration where the server is forcibly stopped mid‑transaction, restarted, and the document state is recovered correctly. |

---
### Phase 12 – Integration & Evaluation
| **Goal**     | Assemble all modules, perform stress testing, and prepare the final demo. |
| **Features** | Full end‑to‑end workflow, performance metrics collection, final documentation polish. |
| **Testing**  | Load test with 5‑10 concurrent editors, measure latency, page‑fault count, lock wait times, index speedup. |
| **Success**  | All success criteria from `prd.md` are met; demo script runs without errors. |

---
## 5. Dependency Order
```text
Storage Manager
    ↓
Buffer‑Pool Manager
    ↓
Transaction Manager
    ↓
Lock Manager
    ↓
Conflict Resolver
    ↓
Request Scheduler & Worker Pool
    ↓
Message Queue
    ↓
Index Manager
    ↓
Recovery Manager
    ↓
Presentation Layer (React) & Real‑time Collaboration
```
Modules higher in the diagram cannot be fully implemented until lower‑level modules are operational.

---
## 6. Milestone Demonstrations
| Milestone | Demonstration |
|---------- |--------------|
| Phase 3   | Show a document version written to `documents.dat` and read back correctly. |
| Phase 5   | Execute two concurrent transactions, commit both, and display serialised final state. |
| Phase 6   | Trigger a deadlock with two transactions, show detector aborting one. |
| Phase 8   | Real‑time edit from one browser appears instantly in another. |
| Phase 10  | Search benchmark: indexed vs full scan times displayed. |
| Phase 11  | Crash the server during a transaction, restart, and verify only committed edits persist. |
| Phase 12  | Full end‑to‑end demo covering concurrency, recovery, indexing, and scheduling metrics. |

---
*End of phases.md*
