import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { ValidationError, ResourceNotFoundError } from '../types/exceptions';

const RESERVED_KEYS = new Set([
  'id', 'tenantId', 'firstName', 'lastName', 'email', 'phone', 'company',
  'source', 'status', 'stage', 'score', 'expectedValue', 'priority',
  'expectedCloseDate', 'country', 'state', 'city', 'area', 'postalCode',
  'ownerId', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'freeformAddress',
]);

function toKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function validateDef(name: unknown, type: unknown, options: unknown): void {
  if (typeof name !== 'string' || !name.trim()) throw new ValidationError('name is required.');
  if (name.trim().length > 50) throw new ValidationError('name must be 50 characters or fewer.');
  const key = toKey(name as string);
  if (!key) throw new ValidationError('name must contain at least one alphanumeric character.');
  if (RESERVED_KEYS.has(key)) throw new ValidationError(`"${name}" is a reserved field name.`);
  const validTypes = ['text', 'number', 'date', 'dropdown'];
  if (!validTypes.includes(type as string)) throw new ValidationError(`type must be one of: ${validTypes.join(', ')}.`);
  if (type === 'dropdown') {
    if (!Array.isArray(options) || (options as unknown[]).length === 0) {
      throw new ValidationError('dropdown fields require at least one option.');
    }
    if ((options as unknown[]).length > 20) throw new ValidationError('dropdown fields may have at most 20 options.');
    for (const opt of options as unknown[]) {
      if (typeof opt !== 'string' || !opt.trim()) throw new ValidationError('dropdown options must be non-empty strings.');
      if ((opt as string).length > 200) throw new ValidationError('dropdown option must be 200 characters or fewer.');
    }
  }
}

export function createLeadFieldsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use(authMiddleware);

  // GET /api/v1/lead-fields — list all custom field defs for this tenant
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const fields = await (prisma as any).leadFieldDef.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ success: true, data: fields });
    } catch (err) { next(err); }
  });

  // POST /api/v1/lead-fields — create a custom field def
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { name, type, options = [], required = false } = req.body as {
        name?: string; type?: string; options?: string[]; required?: boolean;
      };

      validateDef(name, type, options);
      const key = toKey(name!);

      const count = await (prisma as any).leadFieldDef.count({ where: { tenantId } });
      if (count >= 20) throw new ValidationError('Maximum 20 custom fields per tenant.');

      // Check for duplicate key within tenant
      const existing = await (prisma as any).leadFieldDef.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      if (existing) throw new ValidationError(`A field with key "${key}" already exists.`);

      const field = await (prisma as any).leadFieldDef.create({
        data: { tenantId, name: name!.trim(), key, type, options, required },
      });
      res.status(201).json({ success: true, data: field });
    } catch (err) { next(err); }
  });

  // PATCH /api/v1/lead-fields/:id — update a custom field def
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { id } = req.params;
      const { name, type, options, required } = req.body as {
        name?: string; type?: string; options?: string[]; required?: boolean;
      };

      const existing = await (prisma as any).leadFieldDef.findFirst({
        where: { id, tenantId },
      });
      if (!existing) throw new ResourceNotFoundError();

      if (name !== undefined || type !== undefined || options !== undefined) {
        validateDef(name ?? existing.name, type ?? existing.type, options ?? existing.options);
      }

      const newKey = name !== undefined ? toKey(name) : undefined;
      if (newKey && newKey !== existing.key) {
        const conflict = await (prisma as any).leadFieldDef.findUnique({
          where: { tenantId_key: { tenantId, key: newKey } },
        });
        if (conflict) throw new ValidationError(`A field with key "${newKey}" already exists.`);
      }

      const field = await (prisma as any).leadFieldDef.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name: name.trim(), key: newKey } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(options !== undefined ? { options } : {}),
          ...(required !== undefined ? { required } : {}),
        },
      });
      res.json({ success: true, data: field });
    } catch (err) { next(err); }
  });

  // DELETE /api/v1/lead-fields/:id — remove a custom field def
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = (req as AuthenticatedRequest).user;
      const { id } = req.params;
      const existing = await (prisma as any).leadFieldDef.findFirst({ where: { id, tenantId } });
      if (!existing) throw new ResourceNotFoundError();
      await (prisma as any).leadFieldDef.delete({ where: { id } });
      res.json({ success: true, data: { id } });
    } catch (err) { next(err); }
  });

  return router;
}
