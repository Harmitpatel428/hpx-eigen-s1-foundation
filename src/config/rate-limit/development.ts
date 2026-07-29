import { baseConfig, RateLimitConfig } from './base';

export const developmentConfig: RateLimitConfig = {
  ...baseConfig,
  // Relaxed limits for local development
  windowMs: 15 * 60 * 1000,
  max: 100,
};
