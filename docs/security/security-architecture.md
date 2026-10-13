# Security Architecture

Implements `rules.md` section 12. This document describes what is actually
enforced in the code; section 6 lists what is deliberately not, because a
security document that overstates its coverage is worse than none.

## 1. Authentication

| Property | Implementation |
|----------|----------------|
| Password storage | bcrypt, cost 10 (`BCRYPT_ROUNDS`). Plaintext never leaves the request handler and is never logged. |
| Token | JWT, HS256, signed with `JWT_SECRET`. Claims: `sub`, `username`, `role`. |
| Lifetime | `JWT_EXPIRATION`, default 15 minutes. |
| Transport | `Authorization: Bearer <jwt>` for REST; `auth.token` in the Socket.IO handshake. |
| Validation | Every protected route and every socket handshake. An unauthenticated socket never joins a room. |

**Username enumeration is prevented.** A login for an unknown username still
runs a bcrypt comparison against a dummy hash, so the response time does not
reveal which accounts exist, and both failures return the same
`401 INVALID_CREDENTIALS`.

`JWT_SECRET` has no default. The server refuses to sign or verify without
it, which is better than silently falling back to a well-known value.

## 2. Authorisation

Checked **before** the request reaches the engine, in
`middleware/auth.js:requireDocumentAccess`. An unauthorised edit therefore
never occupies a worker, takes a lock, or writes a log record.

| Capability | Viewer | Editor | Owner | Admin |
|------------|:------:|:-----:|:-----:|:-----:|
| Read document content | yes | yes | yes | - |
| Submit an edit (REST or socket) | no | yes | yes | - |
| Join a document and appear in presence | yes | yes | yes | - |
| Rename a document | no | yes | yes | - |
| Grant or revoke permissions | no | no | yes | - |
| Delete a document | no | no | yes | - |
| View engine internals (`/api/admin/*`) | no | no | no | yes |
| Read audit logs | no | no | no | yes |

The `admin` account role is separate from the per-document role. An admin
has no implicit access to a document's content: admin routes expose engine
statistics, not text.

The owner's own permission cannot be revoked
(`400 CANNOT_REVOKE_OWNER`), so a document cannot be orphaned.

## 3. Engine internals are privileged

`rules.md` section 12 forbids exposing internal engine state or raw WAL files
to unauthenticated users. Accordingly:

- `/api/admin/*` requires authentication **and** the admin role.
- The raw WAL is never served. `/api/admin/stats` returns counts derived
  from it; there is no endpoint that streams `wal.log`.
- `documents.dat`, `wal.log` and `index.dat` live under `ENGINE_DATA_DIR`,
  which is outside any static route. Express serves no static files at all.
- The `transaction` block returned on a successful edit contains the
  caller's own transaction ids, pages and timings. This is intentional for
  the evaluation demo and reveals nothing about other users' documents.

## 4. Input handling

| Surface | Control |
|---------|---------|
| Edit operations | Type, position and length validated and typed; position clamped to the text length; inserts capped at 64 KiB |
| Request bodies | `express.json({ limit: '1mb' })` |
| Usernames | `^[A-Za-z0-9_.-]{3,50}$`, enforced in the controller and by a CHECK constraint |
| Passwords | Minimum 8 characters |
| Titles | Trimmed, non-blank, truncated to 255 characters |
| Document ids | Parsed as integers; a non-integer is rejected before any lookup |

**SQL injection.** Every PostgreSQL statement in `PostgresStore.js` is
parameterised (`$1`, `$2`, …). There is no string interpolation into SQL
anywhere in the codebase.

**XSS.** Document text is rendered into a `<textarea>` as a value, never as
HTML, so stored content cannot execute. The editor is plain text; there is
no rich-text HTML path to sanitise, which removes the class of bug rather
than mitigating it.

## 5. Transport and headers

- `helmet()` sets the standard security headers, including a restrictive
  default Content-Security-Policy.
- CORS is an **allowlist**, never a wildcard. `CLIENT_ORIGIN` may hold a
  comma-separated list of origins; with no value set it falls back to
  `http://localhost:3000`, not `*`. A permissive origin combined with
  credentials would let any site drive the API with a victim's session.
- Rate limiting is mounted on the `/api` prefix, so **every** API route is
  covered rather than only the ones that write: a route that merely performs
  an authorization check is still an oracle an attacker can hammer. 600
  requests per minute per IP, with a tighter 50 per 15 minutes on
  `/api/auth/*`. Both are configurable and disabled under `NODE_ENV=test`.
- HTTPS is expected to be terminated by a reverse proxy in front of the
  application; the Node process speaks plain HTTP inside the network.

## 6. What is not implemented

Listed because a reader must be able to trust section 1 to 5.

| Not implemented | Consequence | Note |
|-----------------|-------------|------|
| Refresh tokens | A session ends after 15 minutes and the user signs in again | A refresh flow needs server-side revocation state, which is beyond the project's scope |
| Token revocation / logout blocklist | A stolen token stays valid until it expires | Mitigated only by the short lifetime |
| Per-socket operation rate limiting | A malicious authenticated client can flood the scheduler | The worker pool bounds the damage: excess requests queue rather than running |
| Audit log tamper-evidence | An admin with database access can edit the audit trail | Would need append-only storage or signing |
| Encryption at rest | `documents.dat` and `wal.log` are plaintext on disk | Filesystem-level encryption is the appropriate layer |
| Account lockout after failed logins | Online password guessing is slowed only by the rate limiter | |
| CSRF tokens | Not required: authentication is a bearer header, not a cookie | |

## 7. Operational requirements

1. **Set `JWT_SECRET` to a long random value.** Generate with
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
   The value in `.env.example` is a placeholder and the Docker default is
   literally named `change_me_before_any_shared_deployment`.
2. **Change the seed passwords.** `database/seeds/001_sample_data.sql`
   creates three accounts with the password `password123`, one of them an
   admin. It is development data; never load it into a shared deployment.
3. **Keep `.env` out of version control.** It is in `.gitignore`; keep it
   there.
4. **Protect `ENGINE_DATA_DIR`.** Anyone who can read `wal.log` can read
   every document, including before-images of deleted text.
5. **Terminate TLS in front of the service**, and set `CLIENT_ORIGIN` to the
   exact origin rather than leaving the `*` default.
