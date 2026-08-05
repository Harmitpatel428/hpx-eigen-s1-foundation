import crypto from 'crypto';
import { PrismaClient, VerificationToken } from '@prisma/client';
import { ValidationError } from '../../types/exceptions';

export class TokenService {
  constructor(private readonly prisma: PrismaClient) {}

  generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }
  
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
  
  async validateVerificationToken(tokenHash: string): Promise<VerificationToken> {
    const token = await this.prisma.verificationToken.findFirst({
      where: {
        tokenHash,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        deletedAt: null
      }
    });
    
    if (!token) throw new ValidationError('Invalid or expired verification token');
    return token;
  }
  
  async revokeOldTokens(userId: string): Promise<void> {
    await this.prisma.verificationToken.updateMany({
      where: { userId, status: 'PENDING', deletedAt: null },
      data: { status: 'REVOKED', revokedAt: new Date() }
    });
  }
}
