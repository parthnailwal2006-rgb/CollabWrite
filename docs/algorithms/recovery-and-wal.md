# Write-Ahead Logging and Crash Recovery

Implementation: `src/engine/recovery/WAL.js`,
`src/engine/recovery/RecoveryManager.js`.
Tests: `tests/unit/recovery.test.js`, `tests/integration/engine.test.js`.
Demo: `npm run demo:recovery`.

## 1. The write-ahead rule

> A log record describing a change must reach stable storage **before** the
> changed page does.

If the process dies at any instant, the log alone determines what happened: a
transaction whose COMMIT record is present must be redone, and one without it
must be undone. Durability is bought here, not in the data file.

In code (`TransactionManager.write`):

```
acquire X lock
fetch page through the buffer pool
beforeImage = page.serialize()        <- capture
mutator(page)                          <- apply
afterImage  = page.serialize()
wal.logUpdate(txId, pageId, beforeImage, afterImage)   <- log FIRST
bufferPool.unpinPage(pageId, dirty = true)             <- page may now flush
```

## 2. Buffer policy, and why both passes exist

The engine is **STEAL / FORCE**:

| Policy | Meaning | Consequence |
|--------|---------|-------------|
| STEAL | The buffer pool may evict, and therefore write, a page belonging to an uncommitted transaction | UNDO is required |
| FORCE | COMMIT flushes the transaction's dirty pages before returning | REDO is short, but still required |

REDO is still required because COMMIT forces the **log**, and a crash can land
between writing the COMMIT record and completing the page flush. The two
alternatives are worth naming: NO-STEAL avoids UNDO but needs a buffer large
enough to pin every uncommitted page, and NO-FORCE avoids the commit-time
flush but makes REDO do much more work. STEAL/FORCE keeps both passes small
and both are implemented.

## 3. Record format

```
uint32 payloadLength      bytes following this field
uint64 lsn                monotonically increasing log sequence number
uint8  type               1 BEGIN, 2 UPDATE, 3 COMMIT, 4 ABORT, 5 CHECKPOINT
uint32 txId
uint32 pageId             0 for records that name no page
uint32 beforeLength
uint32 afterLength
bytes  beforeImage        full page image before the change  (UNDO source)
bytes  afterImage         full page image after the change   (REDO source)
```

**Full page images, not byte deltas.** This costs disk space — 8 KiB per
UPDATE at a 4 KiB page size — and buys a recovery algorithm in which REDO and
UNDO are each a single buffer write. For a teaching engine, an algorithm
short enough to verify by hand is worth more than the space. A production
system would log physiological deltas instead.

**fsync.** COMMIT records are fsync'd when `WAL_SYNC_ON_COMMIT=true` (the
default). Without it the operating system may hold the record in a write-back
cache and a machine crash loses an acknowledged commit. Tests disable it for
speed, and the test that matters simulates a *process* crash, which fsync
would not affect anyway.

## 4. Recovery: three passes

### Pass 1 — Analysis

Walk the log and classify every transaction:

| Observed | Classification |
|----------|----------------|
| BEGIN then COMMIT | **winner** — its work must survive |
| BEGIN, no COMMIT | **loser** — its work must vanish |
| BEGIN then ABORT | **loser** — undone the same way |

### Pass 2 — REDO

Forward, in LSN order. For every UPDATE belonging to a winner, write its
after-image to the page.

Replaying in LSN order reproduces the original execution exactly. REDO is
**idempotent** — writing an after-image twice is indistinguishable from
writing it once — which is what makes a crash *during recovery* survivable.

### Pass 3 — UNDO

Backward, from the end of the log. For every UPDATE belonging to a loser,
write its before-image.

Direction matters. If one transaction wrote the same page three times, the
oldest before-image is the correct final state, and only a backward pass
lands it last.

Each loser then receives an ABORT record, so a second crash during recovery
does not repeat work already done.

```
          +-- Analysis --+-- REDO (forward) --+-- UNDO (backward) --+
log:      BEGIN t1, UPDATE t1 p4, COMMIT t1, BEGIN t2, UPDATE t2 p4
winners:  {t1}
losers:   {t2}
REDO:     p4 <- after-image of t1's update
UNDO:     p4 <- before-image of t2's update   (t1's committed state)
```

## 5. Torn writes

A trailing record whose declared `payloadLength` exceeds the bytes actually
present is a torn write: the process died midway through `fs.writeSync`. It is
discarded, which is safe because such a record was never acknowledged to any
caller. The log opens cleanly and the next LSN continues from the last intact
record.

This is tested directly by truncating a real log three bytes short.

## 6. Pages the log mentions but the file lacks

A page can be allocated and written just before a crash, so the log may name
a page beyond the end of `documents.dat`. `StorageManager.ensureCapacity`
extends the file before the image is written, rather than failing recovery
over a short read.

## 7. Checkpoints

`RecoveryManager.checkpoint()` flushes the buffer pool, fsyncs the data file
and appends a CHECKPOINT record. A checkpoint marks a point at which every
dirty page has reached disk, so a future recovery could skip everything
before it.

Log truncation at the checkpoint is **not** implemented; `design.md`
section 12 lists it as a future improvement. The consequence is honest: the
log grows without bound over a long deployment, and recovery time grows with
it. For a semester project with a bounded demo, that is acceptable; for
anything longer it is the first thing to fix.

## 8. Verifying it works

`npm run demo:recovery`:

1. Commits two edits.
2. Starts a third transaction, writes a page, and **forces the dirty page to
   disk** so the uncommitted bytes really are persisted.
3. Discards all in-memory state without flushing or closing — a crash.
4. Restarts against the same files and prints the recovery report.

The committed text is intact, the uncommitted text is gone, and the report
names the winners, the losers, and the pages redone and undone. The same
scenario runs as an assertion in `tests/integration/engine.test.js`.
