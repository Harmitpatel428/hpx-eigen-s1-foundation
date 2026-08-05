import { PrismaClient, Prisma } from '@prisma/client';
import { getRequestContext } from './context/request-context';

// Singleton pattern — one PrismaClient per process
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const basePrisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = basePrisma;
}

// Models that are tenant-scoped and require automatic tenant isolation
const tenantScopedModels = [
  'Lead',
  'Contact',
  'Opportunity',
  'Invoice',
  'Payment',
  'Activity',
  'AuditLog',
  'Session',
  'Pipeline',
  'OrganizationMembership', // v2
  'Assignment', // v2
  'MembershipRole' // v2
] as const;

type TenantScopedModel = (typeof tenantScopedModels)[number];

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const queryArgs = (args || {}) as Record<string, unknown>;
        if (!tenantScopedModels.includes(model as TenantScopedModel)) {
          return query(args);
        }

        let ctx;
        try {
          ctx = getRequestContext();
        } catch {
          // Allow pass-through for seeds/scripts if context is not bound
          return query(queryArgs);
        }

        if (
          operation === 'findUnique' ||
          operation === 'findFirst' ||
          operation === 'findMany' ||
          operation === 'count' ||
          operation === 'aggregate' ||
          operation === 'update' ||
          operation === 'delete'
        ) {
          queryArgs.where = {
            ...(queryArgs.where as object || {}),
            tenantId: ctx.tenantId,
            deletedAt: { equals: null }
          };
        } else if (operation === 'create') {
          queryArgs.data = {
            ...(queryArgs.data as object || {}),
            tenantId: ctx.tenantId
          };
        } else if (operation === 'upsert') {
          queryArgs.where = {
            ...(queryArgs.where as object || {}),
            tenantId: ctx.tenantId
          };
          queryArgs.create = {
            ...(queryArgs.create as object || {}),
            tenantId: ctx.tenantId
          };
          queryArgs.update = {
            ...(queryArgs.update as object || {}),
            tenantId: ctx.tenantId
          };
        }

        return query(queryArgs);
      }
    }
  }
}) as unknown as PrismaClient;

// Since repositories currently expect the base PrismaClient type in their constructor,
// we export the extended type so they can use it.
export type ExtendedPrismaClient = typeof prisma;
