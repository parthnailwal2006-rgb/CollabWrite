# Database Schema

CollabWrite stores data in **two** places, and which place is deliberate.

| Store | Holds | Defined in |
|-------|-------|------------|
| PostgreSQL | Users, document metadata, permissions, audit logs | `database/init.sql` |
| Engine files | Document content, versions, change log, index | `src/engine/` |

## 1. The boundary

`rules.md` section 8 permits PostgreSQL for user accounts, authentication
metadata and administrative audit logs. `architecture.md` section 7 adds
document metadata such as titles for the UI list, and the permission table
that the API checks before any engine call.

Everything else is engine-owned. Using PostgreSQL for it would mean
presenting its transaction manager, its row locks or its B-Tree as our own,
which `rules.md` section 2 forbids by name.

**What PostgreSQL deliberately does not contain:**

| Absent table or column | Where it actually lives |
|------------------------|-------------------------|
| `documents.content` | Text chunks in `documents.dat`, one record per page |
| `document_versions` | Record header version on page 0 of each document |
| `change_logs` | `wal.log`, as BEGIN / UPDATE / COMMIT / ABORT records |
| `document_locks` | The in-memory lock table in `LockManager` |
| Keyword indexes on content | The B+-Tree in `index.dat` |

CI enforces this. The `schema` job in `.github/workflows/ci.yml` queries
`information_schema` after applying the schema and fails the build if any of
those tables, or a `content` column on `documents`, reappears.

## 2. PostgreSQL tables

### users

Authentication only. Passwords are stored exclusively as bcrypt hashes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PK | |
| `username` | VARCHAR(50) UNIQUE | `^[A-Za-z0-9_.-]{3,50}$`, enforced by CHECK |
| `email` | VARCHAR(255) UNIQUE | must contain `@` |
| `password_hash` | VARCHAR(255) | bcrypt, cost 10 by default |
| `full_name` | VARCHAR(255) | optional |
| `role` | `account_role_enum` | `user` or `admin`; gates the `/api/admin` routes |
| `is_active` | BOOLEAN | soft disable |
| `created_at`, `updated_at` | TIMESTAMPTZ | `updated_at` maintained by trigger |

### documents (metadata only)

`documents.id` is the `docId` the engine's page directory is keyed by, so the
two stores agree on identity without either owning the other's data.

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PK | also the engine's docId |
| `title` | VARCHAR(255) | non-blank, enforced by CHECK |
| `owner_id` | INTEGER FK users | ON DELETE CASCADE |
| `is_deleted` | BOOLEAN | soft delete; the page chain is left in place |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

There is no `content`, no `version` and no `last_modified_by`. Content and
version belong to the engine, and duplicating the version here would create
two sources of truth that could disagree after a crash.

### document_permissions

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PK | |
| `document_id` | INTEGER FK documents | ON DELETE CASCADE |
| `user_id` | INTEGER FK users | ON DELETE CASCADE |
| `role` | `permission_role_enum` | `viewer`, `editor` or `owner` |
| `granted_at` | TIMESTAMPTZ | |

Unique on `(document_id, user_id)`. A trigger grants the owner role on insert
into `documents`, so the invariant holds even for a row inserted by hand
during a demo.

Role semantics:

| Role | Read | Edit | Share / delete |
|------|------|------|----------------|
| `viewer` | yes | no | no |
| `editor` | yes | yes | no |
| `owner` | yes | yes | yes |

### audit_logs

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `user_id` | INTEGER FK users | SET NULL on user deletion |
| `document_id` | INTEGER FK documents | SET NULL |
| `action` | VARCHAR(100) | `user.login`, `document.create`, `document.share`, … |
| `details` | JSONB | free-form context |
| `timestamp` | TIMESTAMPTZ | indexed descending |

This is reporting data for an administrator. It is **not** the engine's
change log: `wal.log` is what recovery reads, and it is never exposed through
the API (`rules.md` section 12).

## 3. Engine files

Created under `ENGINE_DATA_DIR` (default `./data`).

### documents.dat

Fixed 4 KiB pages. The first four pages hold the page directory; data pages
follow.

```
Page directory   uint32 entryCount
                 { uint32 docId, uint16 pageCount, uint32 pageIds[] } *

Page header      uint32 pageId, uint32 checksum, uint8 dirtyFlag,
                 uint16 recordCount                                  (11 bytes)

Record header    uint32 recordId, uint32 length, uint32 version      (12 bytes)
                 followed by `length` payload bytes
```

`recordId 0` is the document metadata (page 0 only); `recordId 1` is the text
chunk. The checksum is CRC-32 over the page with the checksum field itself
excluded, verified on every read.

### wal.log

Append-only. Record format and the three-pass recovery algorithm are
documented in [`../algorithms/recovery-and-wal.md`](../algorithms/recovery-and-wal.md).

### index.dat

The leaf level of the keyword B+-Tree: `{keyLength, key, docCount, docIds[]}`
repeated. Internal nodes are rebuilt on load — see
[`../algorithms/bplus-tree-indexing.md`](../algorithms/bplus-tree-indexing.md).

## 4. Applying the schema

```bash
# Directly
npm run db:init
npm run db:seed

# Or through Docker, which applies both on first start
npm run docker:up
```

The seed creates three accounts (`ananya` as admin, `rahul`, `priya`, all
with password `password123`) and two document metadata rows. It seeds **no
document text**: content must be created through the engine so that the page
chain, the WAL and the index stay consistent with the metadata. Run
`npm run demo:concurrency` or create documents through the API instead.

## 5. Running without PostgreSQL

`STORE_DRIVER=memory` swaps in `src/server/stores/InMemoryStore.js`, which
implements the same interface. It is the default under `NODE_ENV=test`, which
is why the test suite needs no database. Because the store holds only support
data, swapping it changes nothing about the academic mechanisms — which is
the clearest possible demonstration that the boundary is real.
