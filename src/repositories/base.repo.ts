import { PrismaClient, Prisma } from "@prisma/client";

export interface TenantContext {
  tenantId: string;
  userId: string;
  activeDepartmentId?: string | null;
}

export class BaseRepository {
  protected ctx: TenantContext;

  constructor(ctx: TenantContext) {
    this.ctx = ctx;
  }

  protected buildTenantFilter(tx: PrismaClient) {
    return {
      tenantId: this.ctx.tenantId,
      deletedAt: null
    };
  }
}
