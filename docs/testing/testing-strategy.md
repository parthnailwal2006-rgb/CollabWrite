# Testing Strategy

`prd.md` section 9 requires at least 80% unit-test coverage for each academic
module, and `rules.md` section 10 requires unit tests, integration tests and
runnable demonstrations for every one of them.

## 1. Current state

```
Test Suites: 14 passed
Tests:      190 passed

Coverage, src/engine:  93.3% statements  78.1% branches  92.1% functions  95.3% lines
```

A `coverageThreshold` of 80% statements, 70% branches, 80% functions and 80%
lines over `src/engine/` is enforced in `package.json`, so the build fails if
coverage regresses.

## 2. Layers

```
   Evaluation demos          7 scripts, each asserting its own outcome
   -----------------------   npm run demo        (also a CI job)

   Integration tests         engine end-to-end, HTTP API, WebSocket
   -----------------------   tests/integration/

   Property tests            B+-Tree invariants under randomised churn
   -----------------------   tests/unit/index.test.js

   Unit tests                one module at a time, no server, no database
   -----------------------   tests/unit/
```

Nothing in the suite needs PostgreSQL. `STORE_DRIVER` defaults to `memory`
under `NODE_ENV=test`, and the in-memory store implements the same interface
as the PostgreSQL one. The schema is validated separately, in its own CI job,
so a SQL error points at the SQL rather than at a test.

## 3. Unit tests

| File | Module | Notable assertions |
|------|--------|--------------------|
| `storage.test.js` | Page, Storage Manager | variable-length update, compaction on delete, a single flipped byte caught by CRC-32, persistence across reopen |
| `bufferPool.test.js` | Buffer Pool, LRU | eviction order after a re-touch, refusal to evict a pinned page, dirty write-back on eviction |
| `transaction.test.js` | Transaction Manager | UPDATE logged before the data file changes, abort undoing a stolen page, a second writer blocking |
| `lockManager.test.js` | Lock Manager | full compatibility matrix, FIFO fairness, no barging past a queued writer, S-to-X upgrade, timeout |
| `deadlockDetector.test.js` | Deadlock Detector | 2- and 3-cycles, two independent cycles in one pass, a waiting chain that is *not* a deadlock, both victim rules |
| `scheduler.test.js` | Scheduler, Worker Pool | concurrency bounded by pool size, round-robin rotation, priority, recorded wait times |
| `messaging.test.js` | Message Queue, Collaboration | FIFO per document, per-document sequence numbers, capacity rejection, presence |
| `conflictResolver.test.js` | Conflict Resolver | every overlap boundary case, offset shifting both directions, order-independent merge |
| `index.test.js` | B+-Tree, Index Manager | property test across four fanouts, prefix search, persistence round-trip, 2x benchmark |
| `recovery.test.js` | WAL, Recovery Manager | REDO, UNDO, repeated writes undone to the oldest image, idempotence, torn log tail |
| `metrics.test.js` | Metrics | aggregation, retention window, failure to write never propagating |

## 4. Property testing the B+-Tree

A balanced-tree implementation cannot be trusted on worked examples: bugs
appear only after a particular sequence of splits and merges. So the tree is
tested against its invariants rather than against expected outputs.

```js
describe.each([3, 4, 5, 8])('property test at fanout %i', (fanout) => {
  test('stays balanced and consistent under randomised churn', () => {
    for (let trial = 0; trial < 15; trial += 1) {
      const random = seededRandom(trial * 7919 + fanout);
      const tree = new BPlusTree(fanout);
      const model = new Map();          // the oracle

      // 300 randomised inserts, then validate
      // a randomised subset deleted, validating after every key
      // finally: contents must equal the model, keys must be sorted
    }
  });
});
```

`validate()` checks key ordering, ancestor bounds, type-specific occupancy,
`children.length === keys.length + 1`, parent pointers, and that all leaves
sit at the same depth. The PRNG is seeded, so any failure is reproducible
from its trial number.

**This found a real bug.** The first run reported underfull internal nodes at
fanout 3, because leaves and internal nodes had been given the same minimum
occupancy. No example-based test in the suite would have caught it.

## 5. Integration tests

### `engine.test.js`

Drives the full engine. The assertions mirror `prd.md` section 9's success
criteria:

- three concurrent editors, all contributions present, versions contiguous;
- a stale edit rejected, the document provably unchanged;
- a document growing across page boundaries, including multi-byte characters;
- a deadlock between two multi-document transactions, one victim;
- committed edits surviving a simulated crash while uncommitted ones do not;
- the index rebuilt to match the recovered text.

The crash test is a real crash: it writes through an uncommitted
transaction, **flushes the dirty page to disk**, then discards all in-memory
state without closing anything. A test that only dropped memory would never
exercise UNDO.

### `api.test.js`

Supertest against the real controllers and middleware: registration
validation, identical responses for a wrong password and an unknown user,
role enforcement for viewer/editor/owner, 409 with `currentVersion` on a
stale edit, operation validation, search permission filtering, and admin
route protection.

### `realtime.test.js`

Two authenticated Socket.IO clients, which is `phases.md` milestone 8
("an edit in one browser appears in another"). Covers handshake rejection,
join authorisation, cross-client delivery, commit ordering under four rapid
edits, viewer refusal, conflict reporting and presence.

## 6. Demos as tests

The seven scripts under `scripts/demos/` assert their own outcomes and exit
non-zero on failure, and CI runs them as a job. The concurrency demo fails if
a contribution is lost, the deadlock demo fails if no cycle is detected or if
both transactions survive, the recovery demo fails if committed text is lost
or uncommitted text persists, and the index demo fails if the speed-up misses
2x or the two search paths disagree.

This keeps the evaluation story honest: if a demo would fail in front of an
examiner, it fails in CI first.

## 7. Running

```bash
npm test                  # everything
npm run test:coverage     # with the coverage gate
npm run test:storage      # Phases 3-4
npm run test:transactions # Phase 5
npm run test:locks        # Phase 6
npm run test:scheduler    # Phases 7-8
npm run test:index        # Phase 10
npm run test:recovery     # Phase 11
npm run test:integration  # engine, API, WebSocket
npm run demo              # all seven evaluation demos
```

Tests run with `--runInBand`. Each suite opens real files in its own
temporary directory, and running suites in parallel would make the timing
assertions in the scheduler and lock tests flaky.

## 8. Known gaps

Stated rather than hidden:

- **`PostgresStore` is not unit-tested.** It is covered only by the CI schema
  job applying the same SQL. Testing it properly needs a live database in the
  test run, which the suite deliberately avoids.
- **No sustained load test.** `prd.md` targets editing latency under 200 ms
  with five concurrent users; the demos measure latency but do not hold load
  for a meaningful period.
- **No browser-level end-to-end test.** The React client is covered only
  through the API and socket layers it calls.
- **Multi-node behaviour is untested** because it is out of scope: the lock
  table and buffer pool are per-process.
