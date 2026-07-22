import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from './auth.middleware';

const prisma = new PrismaClient();

export function requireRole(allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        return res.status(401).json({ error: 'UNAUTHORIZED', message: 'User not authenticated' });
      }

      const { userId, tenantId } = authReq.user;

      // Check if user has any of the allowed roles for this tenant
      const userRoles = await prisma.userRole.findMany({
        where: {
          userId,
          deletedAt: null,
          role: {
            tenantId,
            deletedAt: null,
            name: {
              in: allowedRoles
            }
          }
        }
      });

      if (userRoles.length === 0) {
        return res.status(403).json({ 
          error: 'FORBIDDEN', 
          message: `This action requires one of these roles: ${allowedRoles.join(', ')}` 
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
