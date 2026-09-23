/**
 * Unit test for checkFirmUploadUrlAttempts — the cap logic in isolation.
 * Mocks the redis layer (src/redis.ts) so the returned incr count is
 * deterministic, independent of the Redis-free test environment
 * (tests/setup-env.js pins REDIS_URL='', which would otherwise make
 * redisIncr always resolve null and hide a broken cap check).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

// NOTE: `jest` here is the ambient global, not an `import ... from '@jest/globals'`.
// Importing `jest` from '@jest/globals' defeats @swc/jest's hoisting of jest.mock()
// calls above the imports below, which would leave the real src/redis.ts wired in
// (verified while writing this test — the mock silently no-ops otherwise).
const mockRedisIncr = jest.fn();
const mockRedisExpire = jest.fn();

jest.mock('../../src/redis', () => ({
  redisIncr: (...args: unknown[]) => mockRedisIncr(...args),
  redisExpire: (...args: unknown[]) => mockRedisExpire(...args),
}));

import { checkFirmUploadUrlAttempts } from '../../src/services/auth/RateLimitService';
import { RateLimitExceededError } from '../../src/types/exceptions';

describe('checkFirmUploadUrlAttempts', () => {
  beforeEach(() => {
    mockRedisIncr.mockReset();
    mockRedisExpire.mockReset();
    process.env.FIRM_UPLOAD_URL_CAP_PER_HOUR = '2';
  });

  it('does not throw at or under the cap', async () => {
    mockRedisIncr.mockResolvedValue(2);
    await expect(checkFirmUploadUrlAttempts('user-1', 'tenant-1')).resolves.toBeUndefined();
  });

  it('throws RateLimitExceededError once the count exceeds the cap', async () => {
    mockRedisIncr.mockResolvedValue(3);
    await expect(checkFirmUploadUrlAttempts('user-1', 'tenant-1')).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it('fails OPEN (no throw) when redisIncr returns null (Redis unavailable)', async () => {
    mockRedisIncr.mockResolvedValue(null);
    await expect(checkFirmUploadUrlAttempts('user-1', 'tenant-1')).resolves.toBeUndefined();
  });
});
