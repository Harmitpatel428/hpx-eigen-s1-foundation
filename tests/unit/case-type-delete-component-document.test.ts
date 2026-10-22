/** deleteComponentDocument — P2003 (FK Restrict race) maps to the "archive instead" business error, never a 500. */
import { describe, it, expect } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { CaseTypeService } from '../../src/services/case-type.service';
import { BusinessRuleViolationError } from '../../src/types/exceptions';

describe('CaseTypeService.deleteComponentDocument', () => {
  it('maps a P2003 from delete() (source row created after the count) to BusinessRuleViolationError', async () => {
    const tx: any = {
      caseType: { findFirst: async () => ({ id: 't1', status: 'DRAFT', deletedAt: null }) },
      caseTypeComponent: { findFirst: async () => ({ id: 'c1', isActive: true, deletedAt: null }) },
      caseTypeComponentDocument: {
        findFirst: async () => ({ id: 'd1', name: 'PAN', isActive: true }),
        delete: async () => { throw new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }); },
      },
      docCaseDocumentComponentSource: { count: async () => 0 },
    };
    const prisma: any = { $transaction: async (fn: any) => fn(tx) };
    const svc = new CaseTypeService(prisma);
    const p = svc.deleteComponentDocument({ tenantId: 'x', userId: 'u' }, 't1', 'c1', 'd1');
    await expect(p).rejects.toBeInstanceOf(BusinessRuleViolationError);
    await expect(svc.deleteComponentDocument({ tenantId: 'x', userId: 'u' }, 't1', 'c1', 'd1')).rejects.toThrow(/archive it instead/);
  });
});
