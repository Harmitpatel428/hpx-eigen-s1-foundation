'use strict';
/**
 * Jest globalSetup — blocks tests if DATABASE_URL points to a production host.
 * Integration tests must NEVER run against production data.
 */

// Load env files: .env.test takes priority over .env
// Developers: create .env.test with a local DATABASE_URL for test isolation
try {
  require('dotenv').config({ path: '.env.test', override: true });
} catch (_) {}
try { require('dotenv').config(); } catch (_) {}

const PROD_PATTERNS = [
  'render.com',
  'railway.app',
  'supabase.com',
  'neon.tech',
  'amazonaws.com',
  '.azure.',
  'herokussl.com',
];

module.exports = async function globalSetup() {
  const url = (process.env.DATABASE_URL ?? '').toLowerCase();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
      'Integration tests require an isolated test PostgreSQL instance.\n' +
      'Set DATABASE_URL before running tests.'
    );
  }

  for (const pattern of PROD_PATTERNS) {
    if (url.includes(pattern)) {
      throw new Error(
        `SAFETY BLOCK: DATABASE_URL contains '${pattern}'.\n` +
        'Refusing to run tests against what looks like a production database.\n' +
        'Use a local or CI-provisioned isolated test database.'
      );
    }
  }
};
