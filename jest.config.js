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
