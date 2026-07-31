import { prisma } from '../db';
import { Request, Response, NextFunction } from 'express';

export const prismaContext = (req: Request, res: Response, next: NextFunction) => {
  // Safety check: If route is public or auth failed, skip RLS context.
  if (!(req as any).user) return next();

  prisma.$transaction(async (tx) => {
    // 1. Set Postgres RLS variables
    await tx.$executeRaw`SET LOCAL app.current_tenant_id = ${(req as any).user.tenantId}::uuid`;
    await tx.$executeRaw`SET LOCAL app.current_department_id = ${(req as any).user.activeDepartmentId}::uuid`;
    await tx.$executeRaw`SET LOCAL app.is_superadmin = ${(req as any).user.isSuperAdmin}::boolean`;
    
    // 2. Attach transaction to request
    (req as any).db = tx;
    // Polyfill $transaction so services calling tx.$transaction don't crash
    (req as any).db.$transaction = async (cb: any) => cb(tx);

    // 3. Wait for the entire route to finish before allowing the transaction to commit
    await new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      res.on('error', reject);
      
      next(); // Pass control to the next middleware/controller
    });
  }).catch(next); // Propagate errors to Express error handler
};
