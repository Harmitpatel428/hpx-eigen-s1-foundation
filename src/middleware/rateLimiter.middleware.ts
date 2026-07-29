import rateLimit from 'express-rate-limit';
import { RateLimitFactory } from '../config/rate-limit';

const policy = RateLimitFactory.getPolicy();

export const authLimiter = rateLimit({
  windowMs: policy.windowMs,
  max: policy.max,
  standardHeaders: policy.standardHeaders,
  legacyHeaders: policy.legacyHeaders,
  message: policy.message,
});
