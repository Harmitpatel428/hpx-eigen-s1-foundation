import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { PrismaClient, Prisma } from "@prisma/client";

// Load RSA keys from environment variables
const PRIVATE_KEY = process.env.JWT_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PUBLIC_KEY = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');

if (!PRIVATE_KEY || !PUBLIC_KEY) {
  logger.error('FATAL: JWT_PRIVATE_KEY or JWT_PUBLIC_KEY is missing. Asymmetric signing unavailable.');
}

export class TokenService {
  /**
   * Generates a short-lived access token using RS256.
   * RS256 allows microservices to verify the token using only the public key.
   */
  public static generateAccessToken(userId: string, tenantId: string, sessionId: string): string {
    return jwt.sign({ userId, tenantId, sessionId }, PRIVATE_KEY!, {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: 'hpx-eigen-auth',
      audience: 'hpx-eigen-api',
    });
  }

  /**
   * Verifies the access token. 
   * Can be used by this service or exported to microservices.
   */
  public static verifyAccessToken(token: string): { userId: string; tenantId: string; sessionId: string } {
    return jwt.verify(token, PUBLIC_KEY!, {
      algorithms: ['RS256'],
      issuer: 'hpx-eigen-auth',
      audience: 'hpx-eigen-api',
    }) as { userId: string; tenantId: string; sessionId: string };
  }
}
