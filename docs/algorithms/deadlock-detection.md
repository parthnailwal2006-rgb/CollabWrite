# Deadlock Detection and Concurrency Control

Implementation: `src/engine/lock/LockManager.js` and
`src/engine/lock/DeadlockDetector.js`.
Tests: `tests/unit/lockManager.test.js`, `tests/unit/deadlockDetector.test.js`.

## 1. Two-phase locking

```
  locks held ^
             |        .---------.
             |      /             \
             |    /                 \
             |  /                     \
             +--------------------------> time
               growing phase    shrinking phase
                                (at COMMIT/ABORT)
```

1. **Growing phase.** The transaction acquires locks and releases none.
2. **Shrinking phase.** Entered at COMMIT or ABORT; every lock is released and
   none is acquired.

Because no lock is released before the last one is taken, the resulting
schedule is conflict-serialisable. This engine uses *strict* 2PL — all locks
are held until the transaction ends — which additionally prevents cascading
aborts, since no other transaction can have read uncommitted data.

**Granularity: the page.** A lock resource is `doc:<docId>/page:<pageId>`.
Pages are the unit of I/O and of caching, so making them the unit of locking
keeps the three aligned.

**Modes and compatibility.**

| requested \ held | S (shared) | X (exclusive) |
|------------------|------------|---------------|
| **S** | compatible | conflict |
| **X** | conflict | conflict |

## 2. Lock table

```
lockTable : Map<resourceId, LockInfo>
LockInfo  : { holders: Map<txId, 'S'|'X'>, waitQueue: LockRequest[] }
LockRequest : { txId, mode, resolve, reject, enqueuedAt, timer }
```

`acquire()` returns a promise. If the lock can be granted it resolves
immediately; otherwise the request joins the FIFO queue and the promise
settles when the lock is granted, times out, or the transaction is aborted.

**Grant rules, in order:**

1. The transaction already holds an equal or stronger mode → grant.
2. It holds S, asks for X, and is the sole holder → upgrade in place.
3. The mode is compatible with every holder **and nobody is already queued**
   → grant.
4. Otherwise → enqueue.

Rule 3's second clause is the anti-starvation condition. Without it, a steady
stream of readers would keep a waiting writer blocked forever. The test
`does not let a shared request barge past a queued writer` pins this
behaviour.

**Release** removes the holder and drains the queue from the front while
requests remain compatible, stopping at the first that is not. FIFO order is
preserved, so every waiter eventually runs.

## 3. The wait-for graph

Nodes are active transactions. A directed edge `Ti -> Tj` exists when `Ti` is
queued for a lock held by `Tj` in an incompatible mode. A cycle is exactly a
deadlock.

```
t0  tx1 acquires X on doc:1/page:4
t1  tx2 acquires X on doc:2/page:5
t2  tx1 requests X on doc:2/page:5  -> blocked, edge tx1 -> tx2
t3  tx2 requests X on doc:1/page:4  -> blocked, edge tx2 -> tx1

    tx1 <====> tx2        cycle
```

`LockManager.getWaitForEdges()` derives these edges from the lock table on
demand. Nothing maintains a separate graph, so the graph cannot drift out of
sync with the locks it describes.

## 4. Cycle detection: Tarjan's SCC

A single depth-first pass assigns every node an `index` (discovery order) and
a `lowLink` (the smallest index reachable from its subtree). When
`lowLink(v) === index(v)`, `v` is the root of a strongly connected component,
which is popped off the stack. Any SCC with more than one node contains a
cycle.

```js
strongConnect(node):
  index[node] = lowLink[node] = nextIndex++
  push(node); onStack.add(node)

  for neighbour in graph[node]:
    if neighbour not visited:
      strongConnect(neighbour)
      lowLink[node] = min(lowLink[node], lowLink[neighbour])
    else if onStack.has(neighbour):
      lowLink[node] = min(lowLink[node], index[neighbour])

  if lowLink[node] === index[node]:
    pop the component; if it has more than one node, it is a deadlock
```

**Complexity:** O(V + E), one pass, finds *every* cycle. The alternative —
running a DFS from each node looking for a back edge — is O(V · (V + E)) and
reports the same cycle repeatedly.

A single-node SCC is not a deadlock here: the lock manager never blocks a
transaction on a lock it already holds (grant rule 1), so no self-loop can
exist.

## 5. Victim selection

```js
victim = the transaction in the cycle holding the fewest locks,
         ties broken by the highest (youngest) transaction id
```

- **Fewest locks** approximates least work completed, so the rollback
  discards as little progress as possible.
- **Youngest on a tie** avoids repeatedly victimising a long-running
  transaction, which would starve it.

Alternatives considered: aborting the oldest transaction is simpler but
starves long transactions; wound-wait and wait-die prevent deadlock entirely
but abort transactions that were never actually deadlocked.

## 6. Recovery from deadlock

1. The sweep marks the victim via `TransactionManager.markDeadlockVictim`.
2. `LockManager.releaseAll(victimTxId)` rejects its pending request with
   `LockAbortedError` and frees its held locks.
3. Draining those resources wakes the survivor, which proceeds.
4. The victim's next engine call sees the mark and raises
   `TransactionAbortedError` with code `DEADLOCK`, which the API maps to
   HTTP 409 with `retryable: true`.

The sweep runs every `DEADLOCK_CHECK_INTERVAL_MS` (default 250 ms). The
interval is `unref`'d so it never keeps a process alive on its own.

An optional per-request timeout (`LOCK_TIMEOUT_MS`, default 5000) is a
backstop for pathologies the graph cannot see, such as a transaction blocked
on something that is not a lock.

## 7. Why the edit path cannot deadlock

`Engine.executeEdit` acquires exclusive locks on every page of the target
document **in ascending page order**. A total order over acquisition makes a
cycle impossible: a cycle requires some transaction to request a
lower-numbered resource while holding a higher-numbered one, and none ever
does. Newly allocated pages preserve the order because allocation always
appends at the end of the file.

So the detector is not load-bearing for editing. It exists for the general
transaction API, where a caller may lock several documents in any order, and
that is what `npm run demo:deadlock` exercises.

This is worth stating plainly rather than implying the production path is
permanently at risk of deadlock. Prevention where it is cheap, detection
where it is not.
