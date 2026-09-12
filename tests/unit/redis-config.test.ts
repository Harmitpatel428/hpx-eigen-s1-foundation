/**
 * Redis config guard — an empty REDIS_URL means "unconfigured", not "connect to ''".
 * This is the invariant the test harness relies on (setup-env.js pins REDIS_URL='')
 * and that lets the dev server keep Redis while every suite runs Redis-free.
 */
import { describe, it, expect, jest } from '@jest/globals';

describe('redis config', () => {
  it("empty REDIS_URL yields a null client (empty === unconfigured)", async () => {
    process.env.REDIS_URL = '';
    jest.resetModules(); // fresh module state so the singleton re-reads the env
    const { redisIncr } = await import('../../src/redis');
    // A null client makes every op a no-op returning null (fail-open cache / rate limit).
    expect(await redisIncr('redis-guard-key')).toBeNull();
  });
});
