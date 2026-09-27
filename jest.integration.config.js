/** @type {import('@jest/types').Config.InitialOptions} */
// Integration test config — runs against real PostgreSQL (.env.test, falling back to .env).
// DO NOT run on prod data in CI.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.ts'],
  // Phase 1 (A): globalSetup runs db-safety-check (validates DATABASE_URL, blocks prod,
  // applies pending migrations) THEN seed-permissions.ts, so suites that grant a
  // newly-added permission slug in beforeAll don't fail on an unseeded DB.
  globalSetup: '<rootDir>/tests/integration-bootstrap.js',
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
