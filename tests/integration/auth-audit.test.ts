import { PrismaClient, SessionStatus } from '@prisma/client';
import { AuthService } from '../../src/services/auth.service';
import { authMiddleware, AuthenticatedRequest } from '../../src/middleware/auth.middleware';
import { TokenService } from '../../src/services/token.service';
import { redisGet, redisSet, redisDel, redisKeys, redisClient } from '../../src/redis';
import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';

describe('Auth v1 Production Readiness Audit', () => {
  let prisma: PrismaClient;
  let authService: AuthService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    authService = new AuthService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redisClient.quit();
  });

  describe('Architecture & Redis Cache Fallback (Negative Test)', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let nextFunction: jest.Mock;
    
    beforeEach(() => {
      mockReq = { headers: {} };
      mockRes = { 
        status: jest.fn().mockReturnThis(), 
        json: jest.fn() 
      };
      nextFunction = jest.fn();
    });

    it('should fall back to DB if Redis key is missing but session is ACTIVE/CREATED', async () => {
      // 1. Create a dummy tenant and user
      const tenant = await prisma.tenant.create({ data: { name: 'Audit Tenant' } });
      const user = await prisma.user.create({
        data: {
          email: 'audit@example.com',
          password: 'hashed-password',
          tenantId: tenant.id,
          emailVerified: new Date()
        }
      });

      // 2. Create a session that is CREATED or ACTIVE
      const session = await prisma.session.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          status: SessionStatus.ACTIVE,
          refreshTokenHash: 'hash',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
      });

      // 3. Generate token
      const token = TokenService.generateAccessToken(user.id, tenant.id, session.id);
      
      // 4. Ensure Redis is EMPTY (simulate eviction or restart)
      await redisDel(redisKeys.sessionActive(session.id));

      mockReq.headers!.authorization = `Bearer ${token}`;

      // 5. Call Middleware
      await authMiddleware(mockReq as Request, mockRes as Response, nextFunction);

      // EXPECTATION: Since it is in DB, it should NOT throw SessionRevokedError.
      // Currently, it WILL throw because of the defect.
      if ((mockRes.status as jest.Mock).mock.calls.length > 0) {
        console.log("Middleware rejected request:", (mockRes.status as jest.Mock).mock.calls, (mockRes.json as jest.Mock).mock.calls);
      }
      
      expect(nextFunction).toHaveBeenCalled();
      
      // Cleanup
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
      await prisma.tenant.deleteMany({ where: { id: tenant.id } });
    });
  });
});
