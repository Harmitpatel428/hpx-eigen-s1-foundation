import { baseConfig, RateLimitConfig } from './base';

export const productionConfig: RateLimitConfig = {
  ...baseConfig,
  // Production enforces strict rate limiting
  windowMs: 15 * 60 * 1000,
  max: 5,
};
