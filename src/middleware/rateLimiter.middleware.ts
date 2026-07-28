import rateLimit from 'express-rate-limit';

// In production, use a Redis Store: `rate-limit-redis`
// import RedisStore from 'rate-limit-redis';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per window
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many authentication attempts. Please try again after 15 minutes.'
  },
  // store: new RedisStore({ /* redis config */ })
});
