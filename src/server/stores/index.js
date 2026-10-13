/**
 * CollabWrite - Support Store Factory
 *
 * Chooses the backing store for users, document metadata, permissions and
 * audit logs. PostgreSQL is the production store; the in-memory store keeps
 * the API testable and lets the engine demos run without a database.
 */

'use strict';

const { InMemoryStore, ROLES } = require('./InMemoryStore');
const { PostgresStore } = require('./PostgresStore');

/**
 * @param {object} [options]
 * @param {'postgres'|'memory'} [options.driver] - Defaults to STORE_DRIVER,
 *        then to postgres outside the test environment.
 * @returns {Promise<InMemoryStore|PostgresStore>} An initialised store.
 */
async function createStore({ driver = null, ...config } = {}) {
  const selected = driver
    || process.env.STORE_DRIVER
    || (process.env.NODE_ENV === 'test' ? 'memory' : 'postgres');

  const store = selected === 'memory' ? new InMemoryStore() : new PostgresStore(config);
  await store.init();
  return store;
}

module.exports = { createStore, InMemoryStore, PostgresStore, ROLES };
