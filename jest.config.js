/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // Integration suites share one local Postgres; running them in parallel causes
  // lock/connection contention that surfaces as flaky timeouts. Serialize so runs
  // are deterministic. (Equivalent to always passing --runInBand.)
  maxWorkers: 1,
  globalSetup: './tests/db-safety-check.js',
  setupFiles: ['./tests/setup-env.js'],
  // Disconnect every PrismaClient a suite opens, after that suite — otherwise per-file
  // clients accumulate connections across the serial run and exhaust Postgres.
  setupFilesAfterEnv: ['./tests/disconnect-clients.js'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.{ts,js}'],
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          target: 'es2022'
        }
      }
    ]
  }
};
