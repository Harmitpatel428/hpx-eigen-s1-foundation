'use strict';
/**
 * Jest globalSetup for integration tests — Phase 1 (A).
 *
 * jest.integration.config.js intentionally has no globalSetup (see its own
 * comment) so it can run against real Postgres without the prod-safety-check
 * gate that the unit config uses. But integration tests that grant new
 * permission slugs (e.g. permission-reconciliation, crm-settings-case-engine)
 * need those slugs to actually be seeded in the DB first, or their beforeAll
 * throws "Permission '<slug>' not seeded" and every test in the file fails.
 *
 * This wires the same safety gate (db-safety-check: validates DATABASE_URL,
 * blocks prod hosts, runs `prisma migrate deploy`) followed by
 * seed-permissions.ts, so the DB is both safe AND seeded before any suite runs.
 */
module.exports = async function () {
  await require('./db-safety-check')();            // validates DATABASE_URL, blocks prod, runs migrate deploy

  const { execSync } = require('child_process');
  const childEnv = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };
  delete childEnv.SEED_ADMIN_EMAILS;               // deterministic: skip user assignment
  // Same fix as tests/setup-env.js (empty string, not delete): globalSetup's own process.env
  // still carries the real REDIS_URL from .env (setup-env.js's override only runs inside the
  // Jest test-worker via setupFiles, not here). seed-permissions.ts's `import 'dotenv/config'`
  // does not overwrite an already-present env var, so this survives. Without it, the child's
  // ioredis client keeps a reconnect timer alive after main() finishes, the process never exits,
  // and this execSync (which waits for child exit) hangs forever — no test file ever runs.
  childEnv.REDIS_URL = '';

  // Not run a second time here: db-safety-check() above already ran `prisma migrate deploy`.
  execSync('npx tsx prisma/seed-permissions.ts', { env: childEnv, stdio: 'inherit' });
};
