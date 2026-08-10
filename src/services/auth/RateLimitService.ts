import { redisIncr, redisExpire } from '../../redis';
import { RateLimitExceededError } from '../../types/exceptions';

// 10/hr per actor, 50/hr per tenant, 20/hr per IP — all three must pass
export async function checkInviteCreation(actorUserId: string, tenantId: string, ip: string): Promise<void> {
  const hour = Math.floor(Date.now() / 3600000);
  const keys = [
    { key: `invite:actor:${actorUserId}:${hour}`, limit: 10 },
    { key: `invite:tenant:${tenantId}:${hour}`, limit: 50 },
    { key: `invite:ip:${ip}:${hour}`, limit: 20 }
  ];
  for (const { key, limit } of keys) {
    const count = await redisIncr(key);
    if (count === null) throw new Error('Rate limit check failed: Redis unavailable');
    if (count === 1) await redisExpire(key, 3600);
    if (count > limit) throw new RateLimitExceededError();
  }
}

// 5/min per IP — fail-open (GET is read-only; don't block legitimate access on Redis outage)
export async function checkInviteTokenLookup(ip: string): Promise<void> {
  const key = `invite:lookup:${ip}:${Math.floor(Date.now() / 60000)}`;
  const count = await redisIncr(key);
  if (count === null) return; // fail-open
  if (count === 1) await redisExpire(key, 60);
  if (count > 5) throw new RateLimitExceededError();
}

// 10/min per IP — fail-closed (brute-force protection on acceptance)
export async function checkAcceptAttempts(ip: string): Promise<void> {
  const key = `invite:accept:${ip}:${Math.floor(Date.now() / 60000)}`;
  const count = await redisIncr(key);
  if (count === null) throw new Error('Rate limit check failed: Redis unavailable');
  if (count === 1) await redisExpire(key, 60);
  if (count > 10) throw new RateLimitExceededError();
}

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
