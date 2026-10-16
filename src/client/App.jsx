/**
 * CollabWrite - React Editor (Phases 1, 2, 8 and 9)
 *
 * The presentation layer. It captures keystrokes, turns them into engine
 * operations, and renders what the collaboration manager pushes back. It
 * holds no concurrency logic of its own: no locks, no versioning rules, no
 * merge policy. Every one of those decisions is made inside the engine, and
 * this component only reacts to the outcome.
 *
 * CONFLICT HANDLING
 *   Each edit is submitted with the version it was typed against. If another
 *   collaborator committed first, the server answers 409 with the current
 *   version; the client reloads the document and tells the user their edit
 *   was rebased. That is the abort-and-retry loop design.md section 10
 *   specifies in place of operational transformation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

import { api, applyOperation, diffToOperations } from './clientApi.js';

const SOCKET_URL = import.meta.env.VITE_API_URL || undefined;
const FLUSH_DELAY_MS = 350;

function AuthPanel({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'login'
        ? { username: form.username, password: form.password }
        : form;
      const result = await api(`/api/auth/${mode}`, { method: 'POST', body });
      onAuthenticated(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="card auth" onSubmit={submit}>
        <h1>CollabWrite</h1>
        <p className="subtitle">Collaborative editing over a custom OS/DBMS engine</p>

        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Register
          </button>
        </div>

        <label htmlFor="username">Username</label>
        <input
          id="username"
          value={form.username}
          autoComplete="username"
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          required
        />

        {mode === 'register' && (
          <>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={form.email}
              autoComplete="email"
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </>
        )}

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={form.password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
        />

        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

function DocumentList({ documents, activeId, onOpen, onCreate, onRefresh }) {
  const [title, setTitle] = useState('');

  return (
    <aside className="sidebar">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Documents</h2>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh document list"
            style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
          >
            ↻
          </button>
        )}
      </div>
      <form
        className="new-document"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onCreate(title.trim());
          setTitle('');
        }}
      >
        <input
          value={title}
          placeholder="New document title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      <ul>
        {documents.map((document) => (
          <li key={document.id}>
            <button
              type="button"
              className={document.id === activeId ? 'active' : ''}
              onClick={() => onOpen(document.id)}
            >
              <span className="doc-title">{document.title}</span>
              <span className="role">{document.role}</span>
            </button>
          </li>
        ))}
        {documents.length === 0 && <li className="empty">No documents yet.</li>}
      </ul>
    </aside>
  );
}

export default function App() {
  const [session, setSessionState] = useState(() => {
    try {
      const saved = localStorage.getItem('collabwrite_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const setSession = useCallback((newSession) => {
    setSessionState(newSession);
    try {
      if (newSession) {
        localStorage.setItem('collabwrite_session', JSON.stringify(newSession));
      } else {
        localStorage.removeItem('collabwrite_session');
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const [documents, setDocuments] = useState([]);
  const [active, setActive] = useState(null);
  const [text, setText] = useState('');
  const [participants, setParticipants] = useState([]);
  const [status, setStatus] = useState({ kind: 'idle', message: 'Ready' });

  const [sharingOpen, setSharingOpen] = useState(false);
  const [shareUsername, setShareUsername] = useState('');
  const [shareRole, setShareRole] = useState('editor');
  const [shareStatus, setShareStatus] = useState('');

  const socketRef = useRef(null);
  // The last text the server is known to hold, and the version it was at.
  // Operations are diffed against this, never against the previous keystroke.
  const committedRef = useRef({ text: '', version: 0 });
  const flushTimer = useRef(null);
  const activeRef = useRef(null);

  activeRef.current = active;

  const refreshDocuments = useCallback(async (token) => {
    const result = await api('/api/documents', { token });
    setDocuments(result.documents);
    return result.documents;
  }, []);

  const openDocument = useCallback(async (docId) => {
    const token = session.token;
    const result = await api(`/api/documents/${docId}`, { token });
    const document = result.document;

    committedRef.current = { text: document.text, version: document.version };
    setActive(document);
    setText(document.text);
    setStatus({ kind: 'idle', message: `Opened at version ${document.version}` });

    if (socketRef.current) socketRef.current.emit('document:join', { docId });
  }, [session]);

  // ---------------------------------------------------------------- socket
  useEffect(() => {
    if (!session) return undefined;

    const socket = io(SOCKET_URL, { auth: { token: session.token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('document:joined', (event) => setParticipants(event.participants || []));
    socket.on('presence', (event) => setParticipants(event.participants || []));

    socket.on('edit', (event) => {
      const current = activeRef.current;
      if (!current || event.docId !== current.id) return;
      if (event.userId === session.user.id) {
        // Our own committed edit coming back through the message queue.
        committedRef.current = { text: committedRef.current.text, version: event.version };
        return;
      }

      // Apply in place when the edit is the very next version; otherwise the
      // local copy has drifted and a reload is the honest repair.
      if (event.version === committedRef.current.version + 1) {
        const updated = applyOperation(committedRef.current.text, event.operation);
        committedRef.current = { text: updated, version: event.version };
        setText(updated);
        setStatus({ kind: 'remote', message: `${event.username || 'A collaborator'} edited (v${event.version})` });
      } else {
        openDocument(current.id).catch(() => {});
      }
    });

    socket.on('edit:error', (event) => {
      setStatus({ kind: 'error', message: `${event.code}: ${event.message}` });
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [session, openDocument]);

  useEffect(() => {
    if (!session) return;
    refreshDocuments(session.token).catch((error) => setStatus({ kind: 'error', message: error.message }));
  }, [session, refreshDocuments]);

  // ----------------------------------------------------------------- edits
  const flush = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return;

    const operations = diffToOperations(committedRef.current.text, text);
    if (operations.length === 0) return;

    setStatus({ kind: 'saving', message: 'Committing transaction...' });
    try {
      for (const operation of operations) {
        const result = await api(`/api/documents/${current.id}/edit`, {
          token: session.token,
          method: 'POST',
          body: { operation, baseVersion: committedRef.current.version }
        });
        committedRef.current = { text: result.text, version: result.version };
      }
      setStatus({ kind: 'saved', message: `Committed at version ${committedRef.current.version}` });
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') {
        setStatus({
          kind: 'conflict',
          message: `Another collaborator committed version ${error.currentVersion} first. Reloading and rebasing your edit.`
        });
        await openDocument(current.id);
        return;
      }
      setStatus({ kind: 'error', message: `${error.code || 'ERROR'}: ${error.message}` });
    }
  }, [text, session, openDocument]);

  const handleShare = async (event) => {
    event.preventDefault();
    const current = activeRef.current;
    if (!current || !shareUsername.trim()) return;

    try {
      await api(`/api/documents/${current.id}/permissions`, {
        token: session.token,
        method: 'PUT',
        body: { username: shareUsername.trim(), role: shareRole }
      });
      setShareStatus(`Shared with @${shareUsername.trim()} as ${shareRole}`);
      setShareUsername('');
      setTimeout(() => setShareStatus(''), 4000);
    } catch (error) {
      setShareStatus(`Failed: ${error.message}`);
    }
  };

  useEffect(() => {
    if (!active) return undefined;
    if (text === committedRef.current.text) return undefined;

    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => { flush().catch(() => {}); }, FLUSH_DELAY_MS);
    return () => clearTimeout(flushTimer.current);
  }, [text, active, flush]);

  // ----------------------------------------------------------------- render
  if (!session) {
    return <AuthPanel onAuthenticated={setSession} />;
  }

  const canEdit = active && (active.role === 'owner' || active.role === 'editor');

  return (
    <div className="layout">
      <header className="topbar">
        <strong>CollabWrite</strong>
        <span className="spacer" />
        <span className="user">{session.user.username}</span>
        <button type="button" onClick={() => setSession(null)}>Sign out</button>
      </header>

      <div className="body">
        <DocumentList
          documents={documents}
          activeId={active ? active.id : null}
          onOpen={(id) => openDocument(id).catch((error) => setStatus({ kind: 'error', message: error.message }))}
          onRefresh={() => refreshDocuments(session.token).catch((error) => setStatus({ kind: 'error', message: error.message }))}
          onCreate={async (title) => {
            try {
              const created = await api('/api/documents', {
                token: session.token, method: 'POST', body: { title }
              });
              await refreshDocuments(session.token);
              await openDocument(created.document.id);
            } catch (error) {
              setStatus({ kind: 'error', message: error.message });
            }
          }}
        />

        <main className="editor">
          {!active && <p className="placeholder">Select or create a document to start editing.</p>}

          {active && (
            <>
              <div className="editor-header">
                <h2>{active.title}</h2>
                <span className="version">version {committedRef.current.version}</span>
                {active.role === 'owner' && (
                  <button
                    type="button"
                    onClick={() => setSharingOpen(!sharingOpen)}
                    style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}
                  >
                    {sharingOpen ? 'Close Share' : 'Share'}
                  </button>
                )}
                <span className="spacer" />
                <span className="participants">
                  {participants.length} online: {participants.map((p) => p.username).join(', ') || '-'}
                </span>
              </div>

              {sharingOpen && active.role === 'owner' && (
                <form className="share-panel" onSubmit={handleShare}>
                  <input
                    placeholder="Enter collaborator username"
                    value={shareUsername}
                    onChange={(e) => setShareUsername(e.target.value)}
                    required
                  />
                  <select value={shareRole} onChange={(e) => setShareRole(e.target.value)}>
                    <option value="editor">Editor (Can edit)</option>
                    <option value="viewer">Viewer (Read-only)</option>
                  </select>
                  <button type="submit" className="primary">Grant Access</button>
                  {shareStatus && <span className="share-feedback">{shareStatus}</span>}
                </form>
              )}

              <textarea
                value={text}
                readOnly={!canEdit}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                placeholder={canEdit ? 'Start typing...' : 'You have read-only access to this document.'}
              />

              <div className={`status ${status.kind}`}>{status.message}</div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
