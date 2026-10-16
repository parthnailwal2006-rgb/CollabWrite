# WebSocket Protocol

Transport: Socket.IO at the same origin as the REST API.
Implementation: `src/server/realtime/socket.js`.
Tests: `tests/integration/realtime.test.js`.

## 1. What the socket layer is, and is not

Socket.IO is **transport only**. The ordering guarantee, the presence table
and the fan-out decision live in the engine's `MessageQueue` and
`CollaborationManager`; this layer adapts them to sockets and rooms.

`rules.md` section 2 forbids presenting Socket.IO's own routing as the
project's message-passing layer, so the split is deliberate and the transport
is injected into the collaboration manager rather than imported by it — which
is also what lets the ordering guarantees be tested without opening a socket.

## 2. Connecting

A token is required during the handshake; an unauthenticated socket never
reaches a room or the engine.

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  auth: { token: jwt },
  transports: ['websocket']
});
```

The token may also be passed as `?token=` in the query string. A missing or
invalid token fails the handshake with a `connect_error`:

```
Authentication token is required
Invalid token: jwt expired
```

## 3. Client to server

### `document:join` — `{ docId }`

Checks the caller's permission, joins the room `doc:<docId>`, registers a
session with the collaboration manager and broadcasts presence.

Replies `document:joined`; on failure replies `edit:error` with
`FORBIDDEN`.

### `document:leave` — `{ docId }`

Leaves the room and deregisters the session for that document.

### `edit` — `{ docId, operation, baseVersion? }`

Same operation shape as `POST /api/documents/:id/edit`. The caller must hold
`editor` or `owner`.

**Nothing is echoed back to the sender directly.** The committed edit reaches
every client, including the one that sent it, through the message queue. One
delivery path means one ordering, and the sender's own view cannot drift
ahead of everyone else's.

## 4. Server to client

### `document:joined`

```json
{
  "docId": 7,
  "role": "editor",
  "participants": [ { "sessionId": "abc", "userId": 1, "username": "ananya" } ]
}
```

### `edit`

Emitted to every member of `doc:<docId>` after the transaction commits.

```json
{
  "sequence": 14,
  "publishedAt": "2026-10-13T17:22:41.108Z",
  "docId": 7,
  "version": 12,
  "operation": { "type": "insert", "position": 0, "content": "hello" },
  "userId": 1,
  "username": "ananya",
  "txId": 41
}
```

`sequence` is the per-document message-queue sequence number; `version` is
the engine's document version. Both increase monotonically per document.

### `presence`

```json
{
  "sequence": 13,
  "action": "join",
  "userId": 2,
  "username": "rahul",
  "participants": [ ... ]
}
```

`action` is `join` or `leave`. A disconnect produces a `leave` for every
document the session had joined.

### `edit:error`

```json
{
  "code": "VERSION_CONFLICT",
  "message": "Version conflict on page 4: ...",
  "currentVersion": 12,
  "retryable": true
}
```

Codes match the REST contract: `FORBIDDEN`, `VERSION_CONFLICT`, `DEADLOCK`,
`LOCK_TIMEOUT`, `INVALID_OPERATION`. Sent only to the socket that caused it.

## 5. Ordering guarantees

| Guarantee | Holds? | Why |
|-----------|--------|-----|
| Edits to one document delivered in commit order | yes | The message queue is FIFO and stamps a per-document sequence number; the consumer drains in insertion order |
| Edits across different documents ordered relative to each other | no | Not needed, and not promised |
| Every client sees the same order for one document | yes | One queue, one consumer, one broadcast per event |
| An edit is delivered at most once per client | yes | Each event is drained once and broadcast to the room once |
| An edit survives a client being offline | no | There is no replay buffer; a reconnecting client re-reads the document |

The last row is the honest limitation: a client that misses events while
disconnected must `GET /api/documents/:id` to resynchronise. The React client
does this automatically whenever an arriving version is not exactly one
greater than the version it holds.

## 6. Client reconciliation

`src/client/App.jsx` keeps the last server-confirmed text and version. On an
incoming `edit`:

```
if (event.userId === me)               -> record the new version, text already matches
else if (event.version === mine + 1)   -> apply the operation locally
else                                   -> reload the document (local copy has drifted)
```

Outgoing edits are debounced by 350 ms, diffed against the last confirmed
text into at most one delete and one insert, and submitted over REST with
`baseVersion`. On `VERSION_CONFLICT` the client reloads and reports the
rebase to the user rather than silently discarding keystrokes.

REST is used for sending and the socket for receiving on purpose: the REST
reply carries the committed transaction summary, which the client needs in
order to know the new confirmed version.

## 7. Worked exchange

```
C1 -> connect (auth: token)
C1 -> document:join {docId: 7}
C1 <- document:joined {docId: 7, role: "owner", participants: [C1]}

C2 -> connect (auth: token)
C2 -> document:join {docId: 7}
C2 <- document:joined {... participants: [C1, C2]}
C1 <- presence {action: "join", username: "rahul", participants: [C1, C2]}

C1 -> edit {docId: 7, operation: {type: "insert", position: 0, content: "hi"}}
         engine: scheduler -> worker -> transaction -> commit (version 2)
C1 <- edit {sequence: 2, version: 2, operation: {...}, userId: 1}
C2 <- edit {sequence: 2, version: 2, operation: {...}, userId: 1}

C2 -> disconnect
C1 <- presence {action: "leave", username: "rahul", participants: [C1]}
```
