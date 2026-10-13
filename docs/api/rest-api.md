# REST API

Base URL: `http://localhost:3001`. All request and response bodies are JSON.

Implements the API table in `design.md` section 13.

## Authentication

Every route except `/health`, `/api/auth/register` and `/api/auth/login`
requires a bearer token:

```
Authorization: Bearer <jwt>
```

Tokens are HS256, signed with `JWT_SECRET`, and expire after
`JWT_EXPIRATION` (default 15 minutes). The claims are `sub` (user id),
`username` and `role`.

## Error format

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Version conflict on page 4: ...",
    "expectedVersion": 1,
    "currentVersion": 2,
    "retryable": true
  }
}
```

| Status | Code | Meaning | Client action |
|--------|------|---------|---------------|
| 400 | `INVALID_OPERATION` | Malformed edit operation | Fix the request |
| 401 | `UNAUTHENTICATED` | Missing, malformed or expired token | Re-authenticate |
| 403 | `FORBIDDEN` | Role insufficient for this document | None |
| 404 | `DOCUMENT_NOT_FOUND` | No such document, or no access | None |
| 409 | `VERSION_CONFLICT` | Someone committed first | Rebase onto `currentVersion`, retry |
| 409 | `DEADLOCK` | Transaction chosen as deadlock victim | Retry |
| 413 | `OPERATION_TOO_LARGE` | Insert above 64 KiB | Split the edit |
| 503 | `LOCK_TIMEOUT` | Lock not granted in time | Retry with backoff |
| 503 | `ENGINE_SATURATED` | Every buffer frame pinned | Retry with backoff |

`retryable: true` marks the errors a client may resubmit. 5xx bodies never
include internal detail.

**Rate limits.** 50 requests per 15 minutes per IP on the auth routes, 600
per minute on the rest. Both are configurable and disabled under
`NODE_ENV=test`.

---

## Health

### `GET /health`

No authentication.

```json
{ "status": "ok", "documents": 3, "uptimeSeconds": 412 }
```

`status` is `starting` until crash recovery has finished.

---

## Authentication

### `POST /api/auth/register`

```json
{ "username": "ananya", "email": "ananya@gehu.ac.in", "password": "at least eight chars" }
```

`201`:

```json
{
  "user": { "id": 1, "username": "ananya", "email": "ananya@gehu.ac.in", "role": "user" },
  "token": "eyJhbGciOi..."
}
```

Username must match `^[A-Za-z0-9_.-]{3,50}$`; password must be at least 8
characters. Errors: `400 INVALID_USERNAME`, `400 INVALID_EMAIL`,
`400 WEAK_PASSWORD`, `409 USERNAME_TAKEN`.

### `POST /api/auth/login`

```json
{ "username": "ananya", "password": "..." }
```

Returns the same shape as register. A wrong password and an unknown username
both return `401 INVALID_CREDENTIALS`, and both run a bcrypt comparison so
the response time does not reveal which usernames exist.

### `GET /api/auth/me`

Returns the authenticated user.

---

## Documents

### `POST /api/documents`

```json
{ "title": "Project Report" }
```

`201`:

```json
{
  "document": {
    "id": 7, "title": "Project Report", "ownerId": 1,
    "role": "owner", "version": 1, "text": "",
    "createdAt": "...", "updatedAt": "..."
  }
}
```

Writes the metadata row in PostgreSQL first, then creates the page chain in
the engine. If the engine call fails the metadata row is soft-deleted, so a
failure never leaves an owned document with no content.

### `GET /api/documents`

Documents the caller owns or has been granted access to, each with the
caller's `role`.

### `GET /api/documents/:id`

Reads the full text under shared locks.

```json
{
  "document": {
    "id": 7, "title": "Project Report", "role": "editor",
    "version": 12, "text": "...", "pages": [4, 5, 6]
  }
}
```

`pages` is the engine's page chain, exposed because the evaluation demo
inspects it.

### `PATCH /api/documents/:id`

`{ "title": "New Title" }`. Requires `editor` or `owner`.

### `DELETE /api/documents/:id`

Owner only. Soft-deletes the metadata row and drops the document from the
index. The page chain is left in place: reclaiming pages would need a
free-space map, which `design.md` does not specify, and an unreferenced
chain is inert. `204` on success.

---

## Permissions

### `GET /api/documents/:id/permissions`

```json
{ "permissions": [ { "documentId": 7, "userId": 1, "role": "owner" } ] }
```

### `PUT /api/documents/:id/permissions`

Owner only. `{ "userId": 2, "role": "editor" }` with `role` one of `viewer`,
`editor`, `owner`. Upserts.

### `DELETE /api/documents/:id/permissions/:userId`

Owner only. `400 CANNOT_REVOKE_OWNER` if the target is the owner.

---

## Editing

### `POST /api/documents/:id/edit`

Requires `editor` or `owner`.

```json
{
  "operation": { "type": "insert", "position": 0, "content": "hello" },
  "baseVersion": 11
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `operation.type` | yes | `insert` or `delete` |
| `operation.position` | yes | non-negative integer, clamped to the text length |
| `operation.content` | insert only | non-empty, at most 65536 characters |
| `operation.length` | delete only | positive integer |
| `baseVersion` | no | the version the edit was computed against |

Omitting `baseVersion` skips the optimistic check and accepts
last-write-wins. Sending it is strongly recommended — it is what turns a
silently misapplied edit into a `409` the client can recover from.

`200`:

```json
{
  "docId": 7,
  "version": 12,
  "text": "hello world",
  "transaction": {
    "txId": 41, "state": "COMMITTED",
    "startLSN": "180", "endLSN": "184",
    "modifiedPages": [4], "locksHeld": ["doc:7/page:4"],
    "durationMs": 3, "lockWaitMs": 0, "abortReason": null
  }
}
```

The `transaction` block is returned deliberately: it makes the engine's work
visible from the client, and the evaluation demo reads it.

**Conflict response** (`409`):

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Version conflict on page 4: ...",
    "expectedVersion": 11,
    "currentVersion": 12,
    "retryable": true
  }
}
```

The document is unchanged. Re-read it, rebase the operation onto
`currentVersion` and resubmit.

---

## Search

### `GET /api/search?q=<keyword>&index=<true|false>`

`index=false` forces the O(N) full scan, for the benchmark comparison.

```json
{
  "keyword": "deadlock",
  "usedIndex": true,
  "latencyMs": 0.0412,
  "matched": [7, 9],
  "documents": [ { "id": 7, "title": "Project Report", "role": "owner" } ]
}
```

Results are filtered to documents the caller may see. Filtering happens
**after** the index lookup so that permission state never enters the index,
which would otherwise require re-indexing on every share.

### `GET /api/search/benchmark?q=<keyword>&iterations=<n>`

Admin only. Runs both paths and returns timings:

```json
{
  "benchmark": {
    "keyword": "recovery", "documents": 150, "iterations": 50,
    "indexedMs": 0.1311, "fullScanMs": 27.4106,
    "speedup": 209.08, "resultsMatch": true, "treeHeight": 4
  }
}
```

---

## Admin

All routes require `role: "admin"`. They expose engine internals, which
`rules.md` section 12 forbids showing to unauthenticated users. The raw WAL
is never served — only aggregates derived from it.

| Route | Returns |
|-------|---------|
| `GET /api/admin/stats` | Every component's statistics: buffer pool, transactions, locks, lock table, deadlock history, scheduler, message queue, index, conflicts, recovery report, metric summaries |
| `GET /api/admin/locks` | Lock table, live wait-for edges, deadlock history |
| `GET /api/admin/scheduler` | Scheduler metrics and per-worker state |
| `POST /api/admin/scheduler/policy` | `{ "policy": "FIFO" \| "ROUND_ROBIN" }`; rejected while tasks are queued |
| `GET /api/admin/audit?limit=n` | Audit log, newest first |
| `POST /api/admin/checkpoint` | Flushes the pool, fsyncs, appends a CHECKPOINT record; returns its LSN |

Example `GET /api/admin/locks`:

```json
{
  "lockTable": [
    { "resourceId": "doc:1/page:4",
      "holders": [ { "txId": 12, "mode": "X" } ],
      "waiting": [ { "txId": 13, "mode": "X" } ] }
  ],
  "waitForGraph": [
    { "waiter": 13, "holder": 12, "resourceId": "doc:1/page:4", "mode": "X" }
  ],
  "deadlocks": { "sweeps": 240, "deadlocksDetected": 1, "victimsAborted": 1,
                 "history": [ { "cycle": [12, 13], "victim": 13, "detectedAt": "..." } ] }
}
```
