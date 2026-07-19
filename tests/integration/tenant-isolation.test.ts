import { BaseRepository } from '../../src/repositories/base.repo';

describe('Tenant Isolation Query Governance', () => {
  it('should automatically include tenantId filter', () => {
    const repo = new BaseRepository({ tenantId: 'tenant-123', userId: 'user-456' });
    // @ts-ignore
    const filter = repo.buildTenantFilter();
    
    expect(filter).toHaveProperty('tenantId', 'tenant-123');
    expect(filter).toHaveProperty('deletedAt', null);
  });
});
