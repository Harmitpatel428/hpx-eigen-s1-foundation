/**
 * Unit tests for lead-contacts router handlers.
 * Mock Prisma, verify IDOR guard + contact creation + isMain toggle.
 */
import { Request, Response, NextFunction } from 'express';
import { createLeadContactsRouter } from '../../src/routes/lead-contacts.router';

function makePrismaMock() {
  const txMock: any = {
    contact: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const mock: any = {
    lead: { findFirst: jest.fn() },
    contact: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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

describe('lead-contacts router', () => {
  describe('POST — IDOR guard', () => {
    it('throws ResourceNotFoundError when lead belongs to another tenant', async () => {
      const { mock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue(null);

      const router = createLeadContactsRouter(mock);
      const layers = (router as any).stack;
      const postLayer = layers.find((l: any) => l.route?.path === '/' && l.route?.methods?.post);
      const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

      const req = makeReq({ body: { firstName: 'Jane', lastName: 'Doe' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(mock.lead.findFirst).toHaveBeenCalledWith({
        where: { id: LEAD_ID, tenantId: TENANT, deletedAt: null },
      });
      expect(next).toHaveBeenCalled();
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err).toBeDefined();
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

      const router = createLeadContactsRouter(mock);
      const layers = (router as any).stack;
      const postLayer = layers.find((l: any) => l.route?.path === '/' && l.route?.methods?.post);
      const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

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

      const router = createLeadContactsRouter(mock);
      const layers = (router as any).stack;
      const postLayer = layers.find((l: any) => l.route?.path === '/' && l.route?.methods?.post);
      const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

      const req = makeReq({ body: { firstName: 'New', lastName: 'Main', isMain: true } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(txMock.contact.updateMany).toHaveBeenCalledWith({
        where: { leadId: LEAD_ID, tenantId: TENANT, deletedAt: null },
        data: { isMain: false },
      });
      expect(txMock.contact.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isMain: true }),
        }),
      );
    });

    it('does not clear isMain when new contact is not primary', async () => {
      const { mock, txMock } = makePrismaMock();
      mock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, tenantId: TENANT });
      txMock.contact.create.mockResolvedValue({ id: 'c-new' });
      mock.contact.findMany.mockResolvedValue([
        { id: 'c-old', isMain: true },
        { id: 'c-new', isMain: false },
      ]);

      const router = createLeadContactsRouter(mock);
      const layers = (router as any).stack;
      const postLayer = layers.find((l: any) => l.route?.path === '/' && l.route?.methods?.post);
      const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

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
      const router = createLeadContactsRouter(mock);
      const layers = (router as any).stack;
      const postLayer = layers.find((l: any) => l.route?.path === '/' && l.route?.methods?.post);
      const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

      const req = makeReq({ body: { lastName: 'Doe' } });
      const res = makeRes();
      const next: NextFunction = jest.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      const err = (next as jest.Mock).mock.calls[0][0];
      expect(err.constructor.name).toBe('ValidationError');
    });
  });
});
