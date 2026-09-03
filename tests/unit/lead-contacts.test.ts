/**
 * Unit tests for lead-contacts router handlers.
 * Model v2: isMain drives lead cache. No personContactId guard.
 */
import { Request, Response, NextFunction } from 'express';
import { createLeadContactsRouter } from '../../src/routes/lead-contacts.router';

function makePrismaMock() {
  const txMock: any = {
    contact: {
      create: jest.fn().mockResolvedValue({ id: 'c-new' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    lead: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    leadPhone: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const mock: any = {
    lead: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    contact: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
    },
    leadPhone: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn: any) => fn(txMock)),
  };
  return { mock, txMock };
}

const TENANT = 'tenant-1';
const LEAD_ID = 'lead-1';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { leadId: LEAD_ID },
    body: {},
    user: { tenantId: TENANT, userId: 'user-1' },
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return res as Response;
}

function getHandler(router: any, method: string, path: string) {
  const layers = router.stack;
  const layer = layers.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('lead-contacts router', () => {
  describe('POST — IDOR guard', () => {
    it('throws ResourceNotFoundError when lead belongs to another tenant', async () => {
      const { mock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue(null);

      const handler = getHandler(createLeadContactsRouter(mock), 'post', '/');
      const req = makeReq({ body: { firstName: 'Jane', lastName: 'Doe' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.constructor.name).toBe('ResourceNotFoundError');
    });

    it('creates contact when lead belongs to same tenant', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, tenantId: TENANT });
      txMock.contact.create.mockResolvedValue({ id: 'c-1' });
      mock.contact.findMany.mockResolvedValue([
        { id: 'c-existing', firstName: 'Old', isMain: true },
        { id: 'c-1', firstName: 'Jane', isMain: false },
      ]);

      const handler = getHandler(createLeadContactsRouter(mock), 'post', '/');
      const req = makeReq({ body: { firstName: 'Jane', lastName: 'Doe' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data).toHaveLength(2);
    });
  });

  describe('POST — isMain toggle', () => {
    it('clears isMain on existing contacts when new contact is primary', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, tenantId: TENANT });
      txMock.contact.create.mockResolvedValue({ id: 'c-new' });
      mock.contact.findMany.mockResolvedValue([{ id: 'c-new', isMain: true }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'post', '/');
      const req = makeReq({ body: { firstName: 'New', lastName: 'Main', isMain: true } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(txMock.contact.updateMany).toHaveBeenCalledWith({
        where: { leadId: LEAD_ID, tenantId: TENANT, deletedAt: null },
        data: { isMain: false },
      });
    });

    it('does not clear isMain when new contact is not primary', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, tenantId: TENANT });
      txMock.contact.create.mockResolvedValue({ id: 'c-new' });
      mock.contact.findMany.mockResolvedValue([
        { id: 'c-old', isMain: true },
        { id: 'c-new', isMain: false },
      ]);

      const handler = getHandler(createLeadContactsRouter(mock), 'post', '/');
      const req = makeReq({ body: { firstName: 'Side', lastName: 'Contact' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(txMock.contact.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('POST — validation', () => {
    it('throws ValidationError when firstName missing', async () => {
      const { mock } = makePrismaMock();
      const handler = getHandler(createLeadContactsRouter(mock), 'post', '/');
      const req = makeReq({ body: { lastName: 'Doe' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.constructor.name).toBe('ValidationError');
    });
  });

  // ─── S1: setMain copies PERSON_FIELDS (minus phone) to Lead ────────────────
  describe('PUT — setMain lead cache sync (B1)', () => {
    it('[S1] copies firstName/lastName/email/company to Lead (NOT phone)', async () => {
      const { mock, txMock } = makePrismaMock();
      const contactFields = {
        id: 'c-new-main', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'Harmit', lastName: 'Patel', email: 'h@test.com',
        phone: '9876543210', company: 'Acme', isMain: false,
      };
      mock.contact.findFirst.mockResolvedValue(contactFields);
      txMock.contact.findFirst.mockResolvedValue({
        firstName: 'Harmit', lastName: 'Patel', email: 'h@test.com', company: 'Acme',
      });
      mock.contact.findMany.mockResolvedValue([
        { ...contactFields, isMain: true },
      ]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({
        params: { leadId: LEAD_ID, contactId: 'c-new-main' },
        body: { isMain: true },
      });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // B1: lead.update called with person fields minus phone
      const leadUpdateCalls = txMock.lead.update.mock.calls;
      const b1Call = leadUpdateCalls.find((c: any) =>
        c[0]?.data?.firstName === 'Harmit' && c[0]?.data?.lastName === 'Patel'
      );
      expect(b1Call).toBeDefined();
      expect(b1Call[0].data).toEqual({
        firstName: 'Harmit', lastName: 'Patel', email: 'h@test.com', company: 'Acme',
      });
      expect(b1Call[0].data).not.toHaveProperty('phone');
    });

    it('[F4] does NOT copy email to Lead when another lead already owns it (P2002 guard)', async () => {
      const { mock, txMock } = makePrismaMock();
      const contactFields = {
        id: 'c-main', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'Test', lastName: 'BHAI', email: 'test@hpx.com',
        phone: '111', company: 'Co', isMain: false,
      };
      mock.contact.findFirst.mockResolvedValue(contactFields);
      txMock.contact.findFirst.mockResolvedValue({
        firstName: 'Test', lastName: 'BHAI', email: 'test@hpx.com', company: 'Co',
      });
      // Another lead in the tenant already caches this email → clash
      txMock.lead.findFirst.mockResolvedValue({ id: 'other-lead' });
      mock.contact.findMany.mockResolvedValue([{ ...contactFields, isMain: true }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({ params: { leadId: LEAD_ID, contactId: 'c-main' }, body: { isMain: true } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      const b1Call = txMock.lead.update.mock.calls.find((c: any) => c[0]?.data?.firstName === 'Test');
      expect(b1Call).toBeDefined();
      // name/company still copied, but colliding email is skipped (no P2002 / no 500)
      expect(b1Call[0].data.firstName).toBe('Test');
      expect(b1Call[0].data.company).toBe('Co');
      expect(b1Call[0].data).not.toHaveProperty('email');
    });

    it('[S8] copies null email/company to lead when main has nulls', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.contact.findFirst.mockResolvedValue({
        id: 'c-null', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'NoEmail', lastName: 'Contact', email: null,
        phone: null, company: null, isMain: false,
      });
      txMock.contact.findFirst.mockResolvedValue({
        firstName: 'NoEmail', lastName: 'Contact', email: null, company: null,
      });
      mock.contact.findMany.mockResolvedValue([]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({
        params: { leadId: LEAD_ID, contactId: 'c-null' },
        body: { isMain: true },
      });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      const leadUpdateCalls = txMock.lead.update.mock.calls;
      const b1Call = leadUpdateCalls.find((c: any) => c[0]?.data?.firstName === 'NoEmail');
      expect(b1Call).toBeDefined();
      expect(b1Call[0].data.email).toBeNull();
      expect(b1Call[0].data.company).toBeNull();
      expect(b1Call[0].data).not.toHaveProperty('phone');
    });
  });

  // ─── B3: PUT reverse sync on main contact ──────────────────────────────────
  describe('PUT — reverse sync (B3)', () => {
    it('[S3] syncs lead fields when editing a contact that IS main', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.contact.findFirst.mockResolvedValue({
        id: 'c-main', leadId: LEAD_ID, tenantId: TENANT,
        phone: '111', email: 'a@b.com', isMain: true,
      });
      mock.contact.findMany.mockResolvedValue([{ id: 'c-main', isMain: true }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({
        params: { leadId: LEAD_ID, contactId: 'c-main' },
        body: { firstName: 'Updated', email: 'new@b.com' },
      });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(txMock.lead.update).toHaveBeenCalledWith({
        where: { id: LEAD_ID },
        data: expect.objectContaining({ firstName: 'Updated', email: 'new@b.com' }),
      });
    });

    it('[S4] does NOT sync lead fields when editing a non-main contact', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.contact.findFirst.mockResolvedValue({
        id: 'c-other', leadId: LEAD_ID, tenantId: TENANT,
        phone: '222', email: 'x@y.com', isMain: false,
      });
      mock.contact.findMany.mockResolvedValue([{ id: 'c-other', isMain: false }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({
        params: { leadId: LEAD_ID, contactId: 'c-other' },
        body: { firstName: 'Changed' },
      });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(txMock.lead.update).not.toHaveBeenCalled();
    });
  });

  // ─── B4: DELETE — auto-promote + resync ────────────────────────────────────
  describe('DELETE — auto-promote and lead resync (B4)', () => {
    it('[S5] promotes next contact and copies its fields to Lead (minus phone)', async () => {
      const { mock } = makePrismaMock();
      const deletedMain = {
        id: 'c-main', leadId: LEAD_ID, tenantId: TENANT,
        phone: '111', isMain: true,
      };
      const nextContact = {
        id: 'c-next', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'Next', lastName: 'One', email: 'next@test.com',
        phone: '222', company: 'NextCo', isMain: false,
      };
      mock.contact.findFirst
        .mockResolvedValueOnce(deletedMain)     // existing check
        .mockResolvedValueOnce(nextContact);     // auto-promote findFirst
      mock.contact.findMany.mockResolvedValue([{ ...nextContact, isMain: true }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'delete', '/:contactId');
      const req = makeReq({ params: { leadId: LEAD_ID, contactId: 'c-main' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // Promoted contact set as main
      expect(mock.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'c-next' }, data: { isMain: true } }),
      );
      // Lead fields synced (minus phone)
      expect(mock.lead.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LEAD_ID },
          data: { firstName: 'Next', lastName: 'One', email: 'next@test.com', company: 'NextCo' },
        }),
      );
    });

    it('[S5b] leaves Lead fields unchanged when no remaining contacts', async () => {
      const { mock } = makePrismaMock();
      mock.contact.findFirst
        .mockResolvedValueOnce({ id: 'c-only', leadId: LEAD_ID, tenantId: TENANT, phone: null, isMain: true })
        .mockResolvedValueOnce(null);  // no next contact
      mock.contact.findMany.mockResolvedValue([]);

      const handler = getHandler(createLeadContactsRouter(mock), 'delete', '/:contactId');
      const req = makeReq({ params: { leadId: LEAD_ID, contactId: 'c-only' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // lead.update should NOT be called (no null-wipe)
      expect(mock.lead.update).not.toHaveBeenCalled();
    });

    it('[S6] deleting non-main contact leaves lead untouched', async () => {
      const { mock } = makePrismaMock();
      mock.contact.findFirst.mockResolvedValue({
        id: 'c-side', leadId: LEAD_ID, tenantId: TENANT, phone: null, isMain: false,
      });
      mock.contact.findMany.mockResolvedValue([{ id: 'c-main', isMain: true }]);

      const handler = getHandler(createLeadContactsRouter(mock), 'delete', '/:contactId');
      const req = makeReq({ params: { leadId: LEAD_ID, contactId: 'c-side' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // No auto-promote, no lead update
      expect(mock.lead.update).not.toHaveBeenCalled();
    });

    it('any contact is deletable (no person contact guard)', async () => {
      const { mock } = makePrismaMock();
      mock.contact.findFirst
        .mockResolvedValueOnce({ id: 'c-main', leadId: LEAD_ID, tenantId: TENANT, phone: null, isMain: true })
        .mockResolvedValueOnce(null);
      mock.contact.findMany.mockResolvedValue([]);

      const handler = getHandler(createLeadContactsRouter(mock), 'delete', '/:contactId');
      const req = makeReq({ params: { leadId: LEAD_ID, contactId: 'c-main' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      // Soft-delete happened (no guard threw)
      expect(mock.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'c-main' }, data: { deletedAt: expect.any(Date) } }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── F3: setMain preserves sibling identity (EX1/EX2 regression) ──────────
  describe('PUT — setMain sibling identity regression', () => {
    it('[F3] setMain(EX2) updates Lead fields to EX2 but leaves EX1 contact row untouched', async () => {
      const { mock, txMock } = makePrismaMock();
      const ex1 = {
        id: 'c-ex1', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'Neel', lastName: 'Kumar', email: 'neel@test.com',
        phone: '1111111111', company: 'NeelCo', isMain: true,
      };
      const ex2 = {
        id: 'c-ex2', leadId: LEAD_ID, tenantId: TENANT,
        firstName: 'Harmit', lastName: 'Patel', email: 'harmit@test.com',
        phone: '2222222222', company: 'HarmitCo', isMain: false,
      };

      mock.contact.findFirst.mockResolvedValue(ex2);
      txMock.contact.findFirst.mockResolvedValue({
        firstName: 'Harmit', lastName: 'Patel', email: 'harmit@test.com', company: 'HarmitCo',
      });
      mock.contact.findMany.mockResolvedValue([
        { ...ex1, isMain: false },
        { ...ex2, isMain: true },
      ]);

      const handler = getHandler(createLeadContactsRouter(mock), 'put', '/:contactId');
      const req = makeReq({
        params: { leadId: LEAD_ID, contactId: 'c-ex2' },
        body: { isMain: true },
      });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      // Lead fields = EX2's person fields (B1)
      const leadData = txMock.lead.update.mock.calls.find(
        (c: any) => c[0]?.data?.firstName === 'Harmit'
      );
      expect(leadData).toBeDefined();
      expect(leadData[0].data).toEqual({
        firstName: 'Harmit', lastName: 'Patel', email: 'harmit@test.com', company: 'HarmitCo',
      });

      // EX1 contact row: only isMain flag changed (via updateMany), NOT person fields
      const contactUpdateCalls = txMock.contact.update.mock.calls;
      const ex1PersonOverwrite = contactUpdateCalls.find(
        (c: any) => c[0]?.where?.id === 'c-ex1' && c[0]?.data?.firstName
      );
      expect(ex1PersonOverwrite).toBeUndefined();

      // Response has both contacts (row-count preserved)
      const data = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(data).toHaveLength(2);
    });
  });

  // ─── F3: batch duplicate detection predicate (data repair guard) ──────────
  describe('data repair — batch detection predicate', () => {
    it('[F3-data] identifies batch-timestamp contacts with older siblings as duplicates', () => {
      const BATCH_TS = new Date('2026-09-02T16:35:54.432Z');
      const contacts = [
        { id: 'c-real', leadId: 'l1', createdAt: new Date('2026-08-15T10:00:00Z'), isMain: true, deletedAt: null },
        { id: 'c-batch', leadId: 'l1', createdAt: BATCH_TS, isMain: true, deletedAt: null },
      ];
      const batchContact = contacts.find(c => c.createdAt.getTime() === BATCH_TS.getTime());
      const olderSiblings = contacts.filter(
        c => c.leadId === batchContact!.leadId && c.deletedAt === null && c.createdAt < BATCH_TS
      );

      expect(batchContact).toBeDefined();
      expect(olderSiblings).toHaveLength(1);
      expect(olderSiblings[0].id).toBe('c-real');
    });

    it('[F3-data] keeps sole batch contacts (no older siblings)', () => {
      const BATCH_TS = new Date('2026-09-02T16:35:54.432Z');
      const contacts = [
        { id: 'c-batch-only', leadId: 'l2', createdAt: BATCH_TS, isMain: true, deletedAt: null },
      ];
      const batchContact = contacts[0];
      const olderSiblings = contacts.filter(
        c => c.leadId === batchContact.leadId && c.deletedAt === null && c.createdAt < BATCH_TS
      );
      expect(olderSiblings).toHaveLength(0);
    });
  });
});
