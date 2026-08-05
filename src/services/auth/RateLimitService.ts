import { redisIncr, redisExpire } from '../../redis';

export class RateLimitService {
  /**
   * Limit to max 3 resends per hour
   */
  async checkResendLimit(email: string): Promise<number> {
    const key = `resend:${email}:${Math.floor(Date.now() / 3600000)}`;
    const attempts = await redisIncr(key);
    
    if (attempts === 1) {
      await redisExpire(key, 3600);
    }
    
    return attempts ?? 1; // Fallback to 1 if redis is unavailable
  }
  
  /**
   * Limit to max 5 login attempts per minute
   */
  async checkLoginAttempts(email: string): Promise<number> {
    const key = `login:${email}:${Math.floor(Date.now() / 60000)}`;
    const attempts = await redisIncr(key);
    
    if (attempts === 1) {
      await redisExpire(key, 60);
    }
    
    return attempts ?? 1;
  }
}
