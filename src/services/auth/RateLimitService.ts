import { redisIncr, redisExpire } from '../../redis';

export async function checkResendLimit(email: string): Promise<number> {
  const key = `resend:${email}:${Math.floor(Date.now() / 3600000)}`;
  const attempts = await redisIncr(key);
  
  if (attempts === null) {
    throw new Error('Rate limit check failed: Redis unavailable');
  }
  
  if (attempts === 1) {
    await redisExpire(key, 3600);
  }
  
  return attempts;
}

/**
 * Limit to max 5 login attempts per minute
 */
export async function checkLoginAttempts(email: string): Promise<number> {
  const key = `login:${email}:${Math.floor(Date.now() / 60000)}`;
  const attempts = await redisIncr(key);
  
  if (attempts === null) {
    console.warn('Rate limit check bypassed: Redis unavailable');
    return 1;
  }
  
  if (attempts === 1) {
    await redisExpire(key, 60);
  }
  
  return attempts;
}
