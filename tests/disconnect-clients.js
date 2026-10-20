'use strict';
/**
 * Jest setupFilesAfterEnv — disconnect every PrismaClient a test file opens, after that file.
 *
 * Why here and not globalSetup/globalTeardown: Jest sandboxes each test file (fresh global +
 * module registry), so a client cached on globalThis is NOT shared across files, and
 * globalTeardown runs in a separate context that cannot reach per-file clients. 50 suites each
 * do a top-level `new PrismaClient()` and never disconnect; under --runInBand they run in one
 * process and their connections pile up across suites until Postgres runs out ("too many
 * clients" / P2024). setupFilesAfterEnv runs inside EACH file's own sandbox (shares its module
 * registry), so patching @prisma/client here intercepts that file's own `new PrismaClient()`,
 * and the afterAll below fires at the end of every file — keeping at most one file's clients
 * connected at a time. Covers the 3 files that import src/db (its client is a PrismaClient too).
 */
const prismaModule = require('@prisma/client');

if (!prismaModule.__disconnectPatched) {
  prismaModule.__disconnectPatched = true;
  const Original = prismaModule.PrismaClient;
  const live = new Set();
  class TrackedPrismaClient extends Original {
    constructor(...args) {
      super(...args);
      live.add(this);
    }
  }
  prismaModule.PrismaClient = TrackedPrismaClient;
  prismaModule.__liveClients = live;
}

afterAll(async () => {
  const live = prismaModule.__liveClients;
  for (const client of live) {
    try {
      await client.$disconnect();
    } catch (_) {
      // a never-connected or already-disconnected client is a no-op; ignore.
    }
  }
  live.clear();
});
