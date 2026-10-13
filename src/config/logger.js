/**
 * CollabWrite - Logger
 *
 * Thin wrapper over console so that engine modules can emit structured,
 * level-filtered diagnostics without pulling a logging framework into the
 * educational code paths.
 */

'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configured = LEVELS[process.env.LOG_LEVEL] !== undefined
  ? LEVELS[process.env.LOG_LEVEL]
  : (process.env.NODE_ENV === 'test' ? LEVELS.error : LEVELS.info);

function emit(level, scope, message, meta) {
  if (LEVELS[level] > configured) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}`;
  if (meta !== undefined) {
    console.log(line, JSON.stringify(meta));
  } else {
    console.log(line);
  }
}

/**
 * Creates a logger bound to a module name.
 * @param {string} scope - Module identifier shown in every line.
 */
function createLogger(scope) {
  return {
    error: (message, meta) => emit('error', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    debug: (message, meta) => emit('debug', scope, message, meta)
  };
}

module.exports = { createLogger };
