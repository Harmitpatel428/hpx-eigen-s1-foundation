import { baseConfig, RateLimitConfig } from './base';

export const testConfig: RateLimitConfig = {
  ...baseConfig,
  // Deterministic CI execution requires massive throughput capabilities
  windowMs: 60 * 1000,
  max: 10000,
};
