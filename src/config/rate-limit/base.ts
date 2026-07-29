export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message: { code: string; message: string };
  standardHeaders: boolean;
  legacyHeaders: boolean;
}

export const baseConfig: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many authentication attempts. Please try again after 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
};
