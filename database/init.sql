-- =============================================================================
-- CollabWrite - PostgreSQL Support Schema
-- Version: 2.0.0
-- =============================================================================
--
-- THE POSTGRESQL BOUNDARY
--
-- rules.md section 8 and architecture.md section 7 restrict PostgreSQL to
-- support data. This schema therefore contains exactly four tables:
--
--     users                  accounts and authentication metadata
--     documents              document metadata: title, owner, timestamps
--     document_permissions   role-based access control per document
--     audit_logs             administrative audit trail
--
-- It deliberately does NOT contain:
--
--     document content       owned by the engine, in documents.dat
--     document versions      the version is a record header field on page 0
--     change logs            owned by the engine, in wal.log
--     locks                  owned by the engine's in-memory lock table
--     keyword indexes        owned by the engine's B+-Tree, in index.dat
--
-- Those five belong to the Academic Engine. Delegating any of them to
-- PostgreSQL would mean presenting its transaction manager, lock manager or
-- B-Tree as our own, which rules.md section 2 forbids outright. The absence
-- of those tables is a design statement, not an omission.
--
-- The `documents` table carries no `content` column for the same reason: the
-- row is a pointer to engine-owned state, nothing more. `documents.id` is the
-- docId the engine's page directory is keyed by, so the two stores agree on
-- document identity without either owning the other's data.
-- =============================================================================

-- =============================================================================
-- 1. ENUM TYPES
-- =============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'permission_role_enum') THEN
    CREATE TYPE permission_role_enum AS ENUM ('viewer', 'editor', 'owner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_role_enum') THEN
    CREATE TYPE account_role_enum AS ENUM ('user', 'admin');
  END IF;
END $$;

-- =============================================================================
-- 2. USERS
--    Authentication only. Passwords are stored exclusively as bcrypt hashes
--    (rules.md section 12); no plaintext or reversible form is ever written.
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(50)  NOT NULL UNIQUE,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(255),
  role            account_role_enum NOT NULL DEFAULT 'user',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_.-]{3,50}$'),
  CONSTRAINT users_email_format CHECK (position('@' IN email) > 1)
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- =============================================================================
-- 3. DOCUMENTS (metadata only)
--    `id` is the docId used by the engine's page directory. The text itself
--    lives in documents.dat and is never written here.
-- =============================================================================
CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT documents_title_not_blank CHECK (length(trim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_owner_active ON documents(owner_id, is_deleted);

-- =============================================================================
-- 4. DOCUMENT PERMISSIONS
--    Role-based access control. Checked by the API before a request is ever
--    handed to the engine's scheduler, so an unauthorised edit never takes a
--    lock or occupies a worker.
-- =============================================================================
CREATE TABLE IF NOT EXISTS document_permissions (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         permission_role_enum NOT NULL DEFAULT 'viewer',
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT document_permissions_unique UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_permissions_lookup ON document_permissions(document_id, user_id);
CREATE INDEX IF NOT EXISTS idx_doc_permissions_user_id ON document_permissions(user_id);

-- =============================================================================
-- 5. AUDIT LOGS
--    Administrative trail of who did what. This is reporting data, not the
--    engine's write-ahead log: wal.log is what recovery reads, and it is
--    never exposed here (rules.md section 12).
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  document_id  INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  action       VARCHAR(100) NOT NULL,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_document_id ON audit_logs(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- =============================================================================
-- 6. TRIGGERS
--    Keep updated_at honest without requiring every caller to remember.
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 7. OWNER PERMISSION INVARIANT
--    Every document must grant its owner the 'owner' role. The application
--    does this on create; the trigger guarantees it even if a row is inserted
--    by hand during a demo.
-- =============================================================================
CREATE OR REPLACE FUNCTION grant_owner_permission() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO document_permissions (document_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'owner')
  ON CONFLICT (document_id, user_id) DO UPDATE SET role = 'owner';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_grant_owner_permission ON documents;
CREATE TRIGGER documents_grant_owner_permission
  AFTER INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION grant_owner_permission();
