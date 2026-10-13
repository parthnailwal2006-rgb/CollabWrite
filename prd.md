# Product Requirements Document (PRD)

## 1. Project Overview
Simultaneous collaborative editing of a document requires more than simple file sharing. When multiple users edit the same file at the same time, they need a system that guarantees that every change is seen by all collaborators, that no update is silently lost, and that the document can be restored after crashes. This project builds a **Real‑Time Collaborative Document Editor** that demonstrates core operating‑system (OS) and database‑management‑system (DBMS) concepts through a custom educational engine. The editor UI (React) is only a demonstration layer; the heart of the system is a mini‑engine that implements transactions, locking, scheduling, indexing, and recovery.

## 2. Problem Statement
* **Lost updates** – concurrent writes can overwrite each other.
* **Conflicting changes** – two users may edit the same region with incompatible intentions.
* **Inconsistent document state** – without proper synchronization the document view diverges across clients.
* **Overwritten content** – naive last‑write‑wins approaches discard valuable edits.
* **Lack of reliable recovery** – crashes can leave the document in a partially written state.
* **Difficulty tracking revisions** – without versioning it is hard to audit or rollback changes.

## 3. Project Objectives
### Application Objectives
* Provide a web‑based rich‑text editor that multiple users can edit in real time.
* Persist document versions, support role‑based sharing, and allow undo/redo.
### Academic Objectives
* **OS Concurrency** – implement threads (workers), a request scheduler, and message passing.
* **Synchronization** – design a lock manager with shared/exclusive locks and dead‑lock detection.
* **Scheduling** – create a custom FIFO / round‑robin scheduler for edit requests.
* **Message Passing** – build an internal queue that decouples workers from the collaboration manager.
* **Resource Management** – buffer‑pool management for page caching.
* **DBMS Transactions** – ACID‑compliant transaction lifecycle (begin, commit, abort).
* **Concurrency Control** – two‑phase locking (2PL) and optimistic version checks.
* **Indexing** – implement a B+‑Tree index for fast document‑search.
* **Recovery** – write‑ahead logging (WAL), REDO/UNDO, and crash recovery.

## 4. Target Users
| Role            | Description 
|------           |-------------
| Document Owner  | Creates a document, defines collaborators and permissions. |
| Collaborator    | Edits the document in real time, subject to permissions. |
| Viewer          | Reads the document but cannot edit. |
| Administrator   | Manages user accounts, monitors system health, and runs evaluation scripts. |

## 5. Functional Requirements
1. **User Management** – registration, login, JWT‑based authentication.
2. **Document Lifecycle** – create, open, rename, delete documents.
3. **Real‑time Editing** – propagate character‑level edits via Socket.IO.
4. **Role‑Based Permissions** – owner, editor, viewer per document.
5. **Version History** – immutable snapshots for each committed transaction.
6. **Conflict Detection** – identify overlapping edits before commit.
7. **Conflict Resolution** – automatic merging when possible; manual resolution UI otherwise.
8. **Document Search** – keyword search using the custom index.
9. **Recovery after Failure** – system can restart and restore the last committed state.
10. **Collaboration Session Management** – join/leave sessions, presence indicators.

## 6. Academic Functional Requirements
| Requirement                    | Description 
|-------------                   |-------------
| Request Scheduling             | Queue incoming edit requests, assign to worker threads, support FIFO and round‑robin policies. |
| Transaction Management         | Begin/commit/abort transactions, maintain transaction logs, enforce ACID semantics. |
| Lock Acquisition & Release     | Implement shared/exclusive lock tables, lock waiting queues, and lock release on commit/abort. |
| Deadlock Detection             | Build a wait‑for graph, detect cycles, select victim, and abort. |
| Buffer‑Pool Management         | In‑memory page cache with LRU replacement, pin/unpin semantics, dirty‑page tracking. |
| Index‑Based Search             | B+‑Tree over document IDs/keywords; compare performance with full‑scan. |
| Write‑Ahead Logging (WAL)      | Log all modifications before they touch the data files; include commit/abort records. |
| Crash Recovery                 | REDO committed records, UNDO uncommitted, verify durability after simulated crash. |
| Concurrent Transaction Testing | Generate workloads with overlapping edits, measure isolation levels. |
| Performance Measurement        | Record request latency, lock wait time, page‑fault count, and recovery duration. |

## 7. Non‑Functional Requirements
* **Consistency** – the system must guarantee serializable isolation for committed edits.
* **Reliability** – survive process crashes without data loss (WAL guarantees).
* **Durability** – once a transaction commits, its effects persist after restart.
* **Security** – hashed passwords, HTTPS, JWT validation, role enforcement.
* **Performance** – editing latency < 200 ms under 5 concurrent users (target). Buffer pool size 4 MiB.
* **Scalability (within scope)** – support up to 10 simultaneous collaborators per document.
* **Maintainability** – clean module boundaries, extensive unit tests.
* **Explainability** – each academic module must be accompanied by documentation and tests understandable by B.Tech students.

## 8. Scope
### In‑Scope (Core) 
* Custom request scheduler, transaction manager, lock manager, buffer pool, storage manager, index manager, and recovery manager.
* Thin Express API that forwards edit operations to the educational engine.
* Real‑time push of committed changes via Socket.IO.
* PostgreSQL used **only** for user accounts, authentication metadata, and optional admin logs.
### Out‑of‑Scope
* Full Google‑Docs feature set (comments, suggestions, real‑time cursors).
* Voice or video editing.
* Distributed consensus (Raft, Paxos) or multi‑node sharding.
* Production‑grade PostgreSQL replacement – we only build a miniature file‑based engine.
* Advanced UI polish beyond a functional rich‑text editor.

## 9. Success Criteria
| Metric             | Target |
|--------            |--------|
| Concurrent Editing | ≥ 3 users edit the same document without lost updates. |
| Conflict Handling  | Demonstrated detection and resolution of overlapping edits. |
| Crash Recovery     | After a forced server restart, all committed transactions are present; uncommitted ones are rolled back. |
| Index Performance  | Search with index ≥ 2× faster than full scan on ≥ 100 documents. |
| Deadlock Demo      | System detects a deadlock cycle and aborts a victim transaction. |
| Documentation      | All six documents (PRD, architecture, rules, phases, design, memory) are approved by the mentor. |
| Tests              | ≥ 80 % unit‑test coverage for each academic module. |

## 10. Evaluation Plan
During the final demo the evaluator will see:
1. **Concurrent Editing Demo** – three browsers editing simultaneously; the scheduler and lock manager coordinate updates.
2. **Deadlock Demo** – two transactions request locks in opposite order, the deadlock detector aborts one.
3. **Transaction & ACID Demo** – show atomic commit, rollback on error, and durability after crash.
4. **Recovery Demo** – crash the server mid‑transaction, restart, and display recovered state.
5. **Indexing Comparison** – run a search benchmark with/without the B+‑Tree.
6. **Scheduling Comparison** – display average wait time under FIFO vs round‑robin.
7. **Architecture Walk‑through** – diagram on screen, explain each academic module and its code location.

## 11. Requirements Traceability
| Requirement                  | Module                            | OS/DBMS Concept          | Demonstration |
|-------------                 |--------                           |----------------          |---------------|
| Real‑time edit propagation   | Collaboration Manager / Socket.IO | Message Passing          | Live UI update across browsers |
| Serializability of edits     | Transaction Manager               | Transactions, ACID       | Verify final document state matches serial order |
| Locking of document sections | Lock Manager                      | Synchronization, 2PL     | Show lock table during concurrent edits |
| Scheduling of edit requests  | Request Scheduler                 | Scheduling, Resource Mgmt| Log queue timestamps, show FIFO vs RR |
| Crash‑safe persistence       | Recovery Manager                  | Write‑Ahead Log, Recovery| Restart after crash, check committed data |
| Fast keyword search          | Index Manager                     | Indexing (B+‑Tree)       | Benchmark search latency |
| Buffer‑pool efficiency       | Buffer Pool Manager               | Resource Management      | Page‑fault count before/after LRU |
| Deadlock handling            | Lock Manager + Deadlock Detector  | Deadlock Detection       | Induce cycle, show victim abort |

---
*End of PRD*
