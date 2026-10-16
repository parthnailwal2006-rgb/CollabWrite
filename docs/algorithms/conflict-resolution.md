# Conflict Detection and Resolution

> **Scope note.** This document replaces the earlier operational-transformation
> design. `design.md` section 10 places full OT out of scope: concurrency
> correctness is provided by two-phase locking plus optimistic version checks,
> with abort-and-retry where edits genuinely overlap.

## 1. The problem locking does not solve

Two-phase locking guarantees that concurrent transactions produce a
serialisable schedule. It does not guarantee that a transaction's *input* was
computed against current data.

```
t0  Client A reads document, version 7, text "hello world"
t1  Client B reads document, version 7
t2  Client B commits a delete at offset 0, length 6  -> version 8, "world"
t3  Client A submits an insert at offset 6, "brave "
```

At t3 nobody holds the lock, so A's transaction acquires it immediately. The
schedule is perfectly serialisable. But A computed offset 6 against "hello
world", and the document is now "world": applying the edit there inserts into
the middle of a word.

Serialisability is a property of the *schedule*. It says nothing about
whether an operation's offsets still mean what the client intended.

## 2. The fix: an optimistic check under the lock

The document version is checked **after** the lock is acquired and before any
write. At that point the version cannot change, so the check cannot race.

```
acquire X locks (ascending page order)
read the metadata record -> currentVersion
if (baseVersion !== currentVersion) -> abort with VERSION_CONFLICT
apply the operation
write pages at currentVersion + 1
commit
```

The version lives in the record header of the metadata record on page 0 of
the document, and is bumped once per committed edit. The client sends the
version it typed against as `baseVersion`; omitting it opts out of the check
and accepts last-write-wins.

A rejected edit returns HTTP 409 carrying `currentVersion`, so the client can
rebase in a single round trip rather than polling to discover what happened.

## 3. Merging disjoint edits

Not every concurrent pair conflicts. Two edits that touch different parts of
the document can both be applied, with the later one shifted by the length
delta the earlier one introduced ahead of it.

An operation's affected range:

| Operation | Range | Delta |
|-----------|-------|-------|
| `insert(position, content)` | `[position, position)` | `+content.length` |
| `delete(position, length)` | `[position, position + length)` | `-length` |

```js
merge(base, committedOp, incomingOp)
  if ranges overlap           -> { merged: false }
  shift = incoming.start >= committed.end ? committed.delta : 0
  shiftedOp = { ...incomingOp, position: incoming.start + shift }
  text = apply(apply(base, committedOp), shiftedOp)
```

Worked example:

```
base                "hello world"
committed           insert(0, ">> ")        -> ">> hello world"
incoming            insert(6, "brave ")     base offset 6
  6 >= 0, shift by +3                       -> insert(9, "brave ")
result                                      -> ">> hello brave world"
```

The merge is order-independent: merging A then B gives the same text as
merging B then A, which the test suite asserts directly.

## 4. What counts as an overlap

| Case | Overlap? | Why |
|------|----------|-----|
| insert at 3, insert at 3 | yes | the resulting order would be arbitrary |
| insert at 3, insert at 8 | no | different positions, both survive |
| insert at 5, delete [3, 9) | yes | the text would land in characters that are disappearing |
| insert at 3, delete [3, 7) | no | the insert is at the boundary, not inside |
| delete [2, 6), delete [5, 8) | yes | they share character 5 |
| delete [2, 5), delete [5, 8) | no | adjacent, not overlapping |

The boundary cases are the ones worth testing, and they are tested
individually in `tests/unit/conflictResolver.test.js`.

## 5. Why not Operational Transformation

OT would let both clients keep typing and reconcile automatically, which is a
better experience. It is out of scope for three honest reasons, recorded in
`design.md` sections 10 and 17:

1. **Correctness burden.** A TP1/TP2-correct transform set is notoriously
   difficult to get right, and a subtly wrong one corrupts documents in ways
   that are hard to reproduce. The project's academic objectives are in the
   OS and DBMS mechanisms, and a half-correct OT engine would undermine the
   credibility of the parts that are correct.
2. **It demonstrates nothing new here.** OT is a distributed-systems
   technique. The locking, logging and recovery machinery this project exists
   to teach is already exercised by the version-check approach.
3. **It is not needed for correctness.** 2PL plus version checking is already
   safe. What OT buys is convenience, and the cost of not having it is a
   rebase-and-retry round trip the client performs automatically.

What is lost: under heavy simultaneous typing in one document, a client may
see its edit rebased. The React client handles this by reloading and
reporting it, rather than silently dropping the keystrokes.

## 6. Where it lives

| Concern | File |
|---------|------|
| Version check, merge, overlap rules | `src/engine/conflict/ConflictResolver.js` |
| Check invoked under the lock | `src/engine/Engine.js`, `executeEdit` step 3 |
| 409 translation with `currentVersion` | `src/server/middleware/errors.js` |
| Client rebase loop | `src/client/App.jsx`, `flush()` |
| Tests | `tests/unit/conflictResolver.test.js`, `tests/integration/engine.test.js` |
