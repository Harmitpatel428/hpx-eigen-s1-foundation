/** @type {import('@jest/types').Config.InitialOptions} */
// Integration test config — skips the prod-safety-check, runs against real PostgreSQL.
// Uses DATABASE_URL from .env (render.com or local). DO NOT run on prod data in CI.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.ts'],
  // No globalSetup — intentionally bypasses db-safety-check for integration tests
  setupFiles: ['./tests/setup-env.js'],
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          target: 'es2022',
        },
      },
    ],
  },
};
