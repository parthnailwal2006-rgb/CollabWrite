# User Workflows

End-to-end walkthroughs of what happens inside the system for each user
action. Each one names the engine components involved, so a workflow can be
traced into the code.

## Workflow 1: Registration and sign-in

```
Browser                 Express                 PostgreSQL
   |  POST /api/auth/register  |                     |
   |-------------------------->|                     |
   |                           | validate username,  |
   |                           | email, password     |
   |                           | bcrypt.hash (cost 10)
   |                           |-- INSERT users ---->|
   |                           |-- INSERT audit ---->|
   |  201 { user, token }      |                     |
   |<--------------------------|                     |
```

The engine is not involved: this is support data. A failed login runs the
same bcrypt comparison as a successful one, against a dummy hash when the
username is unknown, so timing does not reveal which accounts exist.

## Workflow 2: Creating a document

```
POST /api/documents { title }
  |
  1. INSERT into PostgreSQL documents   -> id = 7
     trigger grants owner permission
  |
  2. engine.createDocument({ docId: 7 })
       StorageManager.createDocument     -> allocates page 4, updates the page directory
       TransactionManager.runInTransaction
         WAL BEGIN
         write page 4: record 0 = metadata (version 1)
                       record 1 = empty text chunk (version 1)
         WAL UPDATE, WAL COMMIT, flush, release locks
  |
  3. IndexManager.indexDocument(7, '')
  |
  201 { document: { id: 7, version: 1, text: '' } }
```

Metadata is written first. If the engine call fails the metadata row is
soft-deleted, so a failure never leaves an owned document with no content.

## Workflow 3: A single edit

The path `prd.md` section 11 traces. One `POST /api/documents/7/edit`:

```
  middleware        JWT verified, role on document 7 checked
       |            (an unauthorised edit stops here, before any lock)
       v
  Scheduler         task queued, enqueuedAt recorded
       |
       v
  WorkerPool        idle worker assigned, startedAt recorded
       |
       v
  TransactionManager.begin      -> txId 41, WAL BEGIN
       |
       v
  LockManager                   -> X locks on every page of doc 7,
                                   acquired in ascending page order
       |
       v
  ConflictResolver              -> baseVersion vs currentVersion
       |                           mismatch -> abort, 409
       v
  BufferPool                    -> pages fetched (hit or miss)
       |
       v
  apply operation, re-chunk the text
       |
       v
  WAL.logUpdate per page        -> before-image + after-image, BEFORE the write
       |
       v
  TransactionManager.commit     -> WAL COMMIT (fsync), flush dirty pages,
                                   release all locks  [shrinking phase]
       |
       +--> IndexManager.indexDocument(7, newText)
       +--> MessageQueue.publish({docId: 7, type: 'edit', ...})
                 |
                 v
            CollaborationManager -> Socket.IO room doc:7 -> every client
```

Steps up to `commit` are the transaction. Indexing and broadcasting happen
after, because neither may resurrect work that was rolled back.

## Workflow 4: Two users editing the same document

```
t0   Ananya and Rahul both have document 7 at version 11

t1   Ananya types; after 350 ms the client submits
       insert(0, "Intro: "), baseVersion 11
t2   Rahul types; his client submits
       insert(0, "Draft: "), baseVersion 11

t3   Scheduler dispatches Ananya's request to worker 1
t4   Scheduler dispatches Rahul's request to worker 2
t5   Worker 1 takes X locks on doc 7's pages
t6   Worker 2 requests the same locks -> BLOCKED, queued
         (lock table: holders [tx41:X], waiting [tx42:X])
t7   Worker 1: version check 11 == 11, applies, commits version 12
         locks released -> worker 2's request is granted
t8   Worker 2: version check 11 != 12 -> VERSION_CONFLICT, abort
t9   Rahul's client receives 409 with currentVersion 12,
         reloads the document and reports the rebase
t10  Both clients receive Ananya's edit over the socket
```

Nothing is lost: Rahul's keystrokes are still in his editor, now measured
against version 12, and his next flush submits them with the correct base.

**Two users editing different documents** never interact at all — their
transactions touch disjoint lock resources and run fully in parallel,
bounded only by the worker pool.

## Workflow 5: A deadlock

Only reachable through the lower-level transaction API; the edit path
acquires locks in a total order and cannot deadlock.

```
t0   tx1 locks doc 1 page 4            tx2 locks doc 2 page 5
t1   tx1 requests doc 2 page 5  BLOCKED
t2   tx2 requests doc 1 page 4  BLOCKED

     wait-for graph:   tx1 ---> tx2
                        ^         |
                        +---------+

t3   DeadlockDetector sweep (every 250 ms)
       Tarjan's SCC finds the component {tx1, tx2}
       victim = fewest locks held, ties to the youngest -> tx2
t4   tx2's locks released, its pending request rejected
t5   tx1 is granted doc 2 page 5 and proceeds
t6   tx2 receives DEADLOCK (409, retryable) and may retry
```

`npm run demo:deadlock` prints the wait-for graph and the lock table at t2,
then the detected cycle and the victim.

## Workflow 6: Searching

```
GET /api/search?q=recovery
  |
  1. IndexManager.search('recovery')
       B+-Tree descent, O(log N)  -> [7, 9, 23]
  |
  2. Filter to documents the caller may see
       (after the lookup, so permissions never enter the index)
  |
  { keyword, usedIndex: true, latencyMs: 0.13, matched: [7, 9], documents: [...] }
```

`?index=false` forces the O(N) full scan instead, which is how the
comparison in `npm run demo:index` is produced.

## Workflow 7: Crash and restart

```
   normal operation
       committed: "Chapter 1. Chapter 2."
       in flight: tx17 wrote "CORRUPT CHAPTER 3" to page 4
       buffer pool evicted page 4 -> the uncommitted bytes are on disk

   *** process killed ***

   restart
       StorageManager.open, WAL.open
       RecoveryManager.recover()
         analysis : winners {14, 15}, losers {17}
         REDO     : after-images of 14 and 15 re-applied
         UNDO     : before-image of tx17's write restored
         ABORT record written for tx17
       IndexManager rebuilt from the recovered pages
       scheduler and deadlock detector started
       HTTP listener bound   <- only now

   first request
       GET /api/documents/7 -> "Chapter 1. Chapter 2."
```

The listener binds last on purpose. Serving a read before UNDO completed
would hand a client text that is about to disappear.

## Workflow 8: Sharing

```
PUT /api/documents/7/permissions { userId: 2, role: "editor" }
  |
  owner check (403 otherwise)
  target user exists (404 otherwise)
  UPSERT document_permissions
  INSERT audit_logs { action: "document.share" }
  |
  200 { permission }
```

Permissions live entirely in PostgreSQL and are consulted on every request
and on every socket join. They never reach the engine, which knows only
about pages — a separation that keeps the index free of permission state.

## Workflow 9: Observing the engine during evaluation

As an admin:

```bash
curl -s localhost:3001/api/admin/locks     -H "Authorization: Bearer $T" | jq
curl -s localhost:3001/api/admin/scheduler -H "Authorization: Bearer $T" | jq
curl -s localhost:3001/api/admin/stats     -H "Authorization: Bearer $T" | jq '.stats.bufferPool'

curl -s -X POST localhost:3001/api/admin/scheduler/policy \
     -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"policy":"ROUND_ROBIN"}'
```

The lock table can be polled while several browsers type, which makes the
holders and wait queues visible live rather than only in a log.
