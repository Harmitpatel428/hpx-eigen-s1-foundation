export interface TenantContext {
  tenantId: string;
  userId: string;
}

export class BaseRepository {
  protected ctx: TenantContext;

  constructor(ctx: TenantContext) {
    this.ctx = ctx;
  }

  protected buildTenantFilter() {
    return {
      tenantId: this.ctx.tenantId,
      deletedAt: null
    };
  }
}
