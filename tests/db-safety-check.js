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
  const rawUrl = process.env.DATABASE_URL ?? '';
  const url = rawUrl.toLowerCase();
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

  // Apply pending migrations (schema + permission seeds) against the safety-checked
  // test DB before any suite runs. Without this, a suite whose beforeAll grants a
  // not-yet-seeded permission throws and fails ALL its tests — deterministically,
  // not intermittently. The observed "run 1 all-fail → run 2 all-pass" was exactly a
  // migrate-deploy gap closed between the two runs (there is no pretest/CI step that
  // applies migrations), NOT lock contention: jest runs with maxWorkers:1 (serialized),
  // so cross-worker contention is impossible. rawUrl (original case) is passed
  // explicitly so Prisma's own .env loading cannot redirect the child at another DB.
  const { execSync } = require('child_process');
  try {
    // execSync (shell) so Windows `npx.cmd` resolves; env override so Prisma's own
    // .env load cannot redirect the child away from the safety-checked test DB.
    execSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: rawUrl },
    });
  } catch (_) {
    throw new Error('prisma migrate deploy failed during test globalSetup (see output above).');
  }
};
