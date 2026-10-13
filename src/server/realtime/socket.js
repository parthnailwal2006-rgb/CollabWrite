/**
 * CollabWrite - WebSocket Layer (Phase 8)
 *
 * Socket.IO is the transport only. The ordering guarantee, the presence table
 * and the fan-out decision all live in the engine's MessageQueue and
 * CollaborationManager; this file adapts them to sockets and rooms.
 *
 * That split is what rules.md section 2 demands: Socket.IO's own routing is
 * never presented as the project's message-passing layer.
 *
 * PROTOCOL
 *   client -> server  'document:join'   {docId}
 *                     'document:leave'  {docId}
 *                     'edit'            {docId, operation, baseVersion}
 *   server -> client  'edit'            {docId, version, operation, userId, sequence}
 *                     'presence'        {action, userId, username, participants}
 *                     'edit:error'      {code, message, currentVersion?}
 */

'use strict';

const { Server } = require('socket.io');

const { verifyToken } = require('../middleware/auth');
const { WRITE_ROLES } = require('../middleware/auth');
const { createLogger } = require('../../config/logger');

const log = createLogger('Socket');

/**
 * Attaches the WebSocket layer to an HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {object} deps
 * @param {object} deps.store
 * @param {import('../../engine/Engine').Engine} deps.engine
 * @returns {import('socket.io').Server}
 */
function attachSocketServer(httpServer, { store, engine }) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_ORIGIN || '*', credentials: true }
  });

  // The collaboration manager pushes here; it never touches io directly.
  engine.collaborationManager.setTransport({
    broadcast(docId, event, payload) {
      io.to(`doc:${docId}`).emit(event, payload);
    }
  });

  // Authenticate during the handshake so an unauthenticated socket never
  // reaches a room or the engine.
  io.use((socket, next) => {
    const token = (socket.handshake.auth && socket.handshake.auth.token)
      || (socket.handshake.query && socket.handshake.query.token);
    if (!token) {
      next(new Error('Authentication token is required'));
      return;
    }
    try {
      const claims = verifyToken(String(token));
      socket.data.user = { id: claims.sub, username: claims.username, role: claims.role };
      next();
    } catch (error) {
      next(new Error(`Invalid token: ${error.message}`));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    log.debug('Socket connected', { socketId: socket.id, userId: user.id });

    socket.on('document:join', async ({ docId } = {}) => {
      const id = Number(docId);
      const role = Number.isInteger(id) ? await store.getPermission(id, user.id) : null;
      if (!role) {
        socket.emit('edit:error', { code: 'FORBIDDEN', message: 'No access to this document' });
        return;
      }

      socket.join(`doc:${id}`);
      const participants = engine.collaborationManager.join({
        sessionId: socket.id,
        userId: user.id,
        username: user.username,
        docId: id
      });
      socket.emit('document:joined', { docId: id, role, participants });
    });

    socket.on('document:leave', ({ docId } = {}) => {
      const id = Number(docId);
      socket.leave(`doc:${id}`);
      engine.collaborationManager.leave(socket.id, id);
    });

    socket.on('edit', async ({ docId, operation, baseVersion } = {}) => {
      const id = Number(docId);
      try {
        const role = await store.getPermission(id, user.id);
        if (!role || !WRITE_ROLES.has(role)) {
          socket.emit('edit:error', { code: 'FORBIDDEN', message: 'You may not edit this document' });
          return;
        }

        // The result is not echoed back here: the committed edit reaches
        // every client, this one included, through the message queue. One
        // delivery path means one ordering.
        await engine.submitEdit({
          docId: id,
          operation,
          baseVersion,
          userId: user.id,
          username: user.username
        });
      } catch (error) {
        socket.emit('edit:error', {
          code: error.code || 'EDIT_FAILED',
          message: error.message,
          currentVersion: error.actualVersion,
          retryable: Boolean(error.code && error.code !== 'INVALID_OPERATION')
        });
      }
    });

    socket.on('disconnect', () => {
      engine.collaborationManager.leave(socket.id);
      log.debug('Socket disconnected', { socketId: socket.id, userId: user.id });
    });
  });

  return io;
}

module.exports = { attachSocketServer };
