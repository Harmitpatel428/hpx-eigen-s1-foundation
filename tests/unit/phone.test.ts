import { normalizePhone, isPhoneLikeTerm } from '../../src/utils/phone.util';
import { PhoneService } from '../../src/services/phone.service';
import { phoneSearchCondition } from '../../src/utils/phone-search.util';

// ─── N1: normalizePhone ───────────────────────────────────────────────────────
describe('normalizePhone', () => {
  it('strips non-digits and normalizes 91-prefixed 12-digit to 10', () => {
    expect(normalizePhone('919876543210')).toBe('9876543210');
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('91-9876543210')).toBe('9876543210');
    expect(normalizePhone('9876543210')).toBe('9876543210');
  });

  it('returns null for malformed (< 6 digits)', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('leaves non-91 numbers untouched', () => {
    expect(normalizePhone('441234567890')).toBe('441234567890');
    expect(normalizePhone('1234567890')).toBe('1234567890');
  });

  it('handles 91-prefix only when exactly 12 digits', () => {
    expect(normalizePhone('9198765432101')).toBe('9198765432101');
    expect(normalizePhone('91987654321')).toBe('91987654321');
  });
});

describe('isPhoneLikeTerm', () => {
  it('returns true for >= 6 digits', () => {
    expect(isPhoneLikeTerm('987654')).toBe(true);
    expect(isPhoneLikeTerm('+91 98765 43210')).toBe(true);
  });

  it('returns false for < 6 digits', () => {
    expect(isPhoneLikeTerm('12345')).toBe(false);
    expect(isPhoneLikeTerm('John')).toBe(false);
  });
});

// ─── Shared mock ──────────────────────────────────────────────────────────────
function makeTxMock() {
  const store: any[] = [];
  const tx: any = {
    leadPhone: {
      findFirst: jest.fn(async ({ where }: any) => {
        return store.find((r) =>
          (where.leadId ? r.leadId === where.leadId : true) &&
          (where.phoneNormalized ? r.phoneNormalized === where.phoneNormalized : true) &&
          (where.status ? r.status === where.status : true) &&
          (where.isPrimary !== undefined ? r.isPrimary === where.isPrimary : true)
        ) ?? null;
      }),
      findMany: jest.fn(async () => store),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `lp-${store.length}`, ...data };
        store.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of store) {
          if (r.leadId === where.leadId && (where.isPrimary === undefined || r.isPrimary === where.isPrimary)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
    },
    lead: {
      update: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  return { tx, store };
}

// ─── N2/N3: PhoneService core ─────────────────────────────────────────────────
describe('PhoneService', () => {
  it('attach creates a new phone row', async () => {
    const { tx, store } = makeTxMock();
    const svc = new PhoneService({} as any);
    await svc.attach(tx, 'lead-1', 'tenant-1', '9876543210', { isPrimary: true, source: 'MANUAL' });
    expect(store).toHaveLength(1);
    expect(store[0].phoneNormalized).toBe('9876543210');
    expect(store[0].isPrimary).toBe(true);
    expect(store[0].status).toBe('ACTIVE');
  });

  it('attach is idempotent — reactivates INACTIVE row', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'existing-1', leadId: 'lead-1', phoneNormalized: '9876543210',
      phoneOriginal: '9876543210', status: 'INACTIVE', isPrimary: false,
      tenantId: 'tenant-1', source: 'MANUAL',
    });
    const svc = new PhoneService({} as any);
    await svc.attach(tx, 'lead-1', 'tenant-1', '9876543210', { isPrimary: true, source: 'MANUAL' });
    expect(store[0].status).toBe('ACTIVE');
    expect(store[0].isPrimary).toBe(true);
    expect(store).toHaveLength(1);
  });

  it('deactivate keeps the row with INACTIVE status', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'existing-1', leadId: 'lead-1', phoneNormalized: '9876543210',
      phoneOriginal: '9876543210', status: 'ACTIVE', isPrimary: true,
      tenantId: 'tenant-1', source: 'MANUAL',
    });
    const svc = new PhoneService({} as any);
    await svc.deactivate(tx, 'lead-1', '9876543210');
    expect(store[0].status).toBe('INACTIVE');
    expect(store[0].isPrimary).toBe(false);
    expect(store[0].deactivatedAt).toBeDefined();
  });

  it('syncLeadPhone updates lead.phone to primary', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'lp-1', leadId: 'lead-1', phoneNormalized: '9876543210',
      phoneOriginal: '+91 98765 43210', status: 'ACTIVE', isPrimary: true,
      tenantId: 'tenant-1', source: 'MANUAL',
    });
    const svc = new PhoneService({} as any);
    await svc.syncLeadPhone(tx, 'lead-1');
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { phone: '+91 98765 43210' },
    });
  });

  it('syncLeadPhone sets null when no primary', async () => {
    const { tx } = makeTxMock();
    const svc = new PhoneService({} as any);
    await svc.syncLeadPhone(tx, 'lead-1');
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { phone: null },
    });
  });

  it('attach updates existing ACTIVE row in place (no duplicate)', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'existing-1', leadId: 'lead-1', phoneNormalized: '9876543210',
      phoneOriginal: '9876543210', status: 'ACTIVE', isPrimary: true,
      tenantId: 'tenant-1', source: 'IMPORT',
    });
    const svc = new PhoneService({} as any);
    await svc.attach(tx, 'lead-1', 'tenant-1', '9876543210', { isPrimary: true, source: 'IMPORT' });
    expect(store).toHaveLength(1);
    expect(tx.leadPhone.create).not.toHaveBeenCalled();
    expect(store[0].status).toBe('ACTIVE');
  });

  it('deactivate + attach simulates contact phone change', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'lp-old', leadId: 'lead-1', phoneNormalized: '1111111111',
      phoneOriginal: '1111111111', status: 'ACTIVE', isPrimary: false,
      tenantId: 'tenant-1', source: 'MANUAL',
    });
    const svc = new PhoneService({} as any);
    await svc.deactivate(tx, 'lead-1', '1111111111');
    expect(store[0].status).toBe('INACTIVE');
    await svc.attach(tx, 'lead-1', 'tenant-1', '2222222222', { isPrimary: false, source: 'MANUAL' });
    expect(store).toHaveLength(2);
    expect(store[1].phoneNormalized).toBe('2222222222');
    expect(store[1].status).toBe('ACTIVE');
  });

  // R9: auto-primary when lead has no active primary
  it('attach auto-promotes to primary when lead has no active primary', async () => {
    const { tx, store } = makeTxMock();
    const svc = new PhoneService({} as any);
    // No isPrimary passed — should auto-promote since lead has no phones
    await svc.attach(tx, 'lead-1', 'tenant-1', '3333333333', { source: 'MANUAL' });
    expect(store[0].isPrimary).toBe(true);
  });

  it('attach does NOT auto-promote when lead already has a primary', async () => {
    const { tx, store } = makeTxMock();
    store.push({
      id: 'existing-primary', leadId: 'lead-1', phoneNormalized: '1111111111',
      phoneOriginal: '1111111111', status: 'ACTIVE', isPrimary: true,
      tenantId: 'tenant-1', source: 'MANUAL',
    });
    const svc = new PhoneService({} as any);
    await svc.attach(tx, 'lead-1', 'tenant-1', '3333333333', { source: 'MANUAL' });
    // New row should NOT be primary
    const newRow = store.find(r => r.phoneNormalized === '3333333333');
    expect(newRow.isPrimary).toBe(false);
  });

  // R4a: setPrimary flips isPrimary
  it('setPrimary flips isPrimary to target phone', async () => {
    const { tx, store } = makeTxMock();
    store.push(
      { id: 'lp-1', leadId: 'lead-1', phoneNormalized: '1111111111', phoneOriginal: '1111111111', status: 'ACTIVE', isPrimary: true, tenantId: 'tenant-1' },
      { id: 'lp-2', leadId: 'lead-1', phoneNormalized: '2222222222', phoneOriginal: '2222222222', status: 'ACTIVE', isPrimary: false, tenantId: 'tenant-1' },
    );
    const svc = new PhoneService({} as any);
    await svc.setPrimary(tx, 'lead-1', '2222222222');
    expect(store.find(r => r.id === 'lp-1')!.isPrimary).toBe(false);
    expect(store.find(r => r.id === 'lp-2')!.isPrimary).toBe(true);
  });

  // R4b: lead.phone mirror follows setPrimary
  it('syncLeadPhone after setPrimary reflects new primary', async () => {
    const { tx, store } = makeTxMock();
    store.push(
      { id: 'lp-1', leadId: 'lead-1', phoneNormalized: '1111111111', phoneOriginal: '1111111111', status: 'ACTIVE', isPrimary: false, tenantId: 'tenant-1' },
      { id: 'lp-2', leadId: 'lead-1', phoneNormalized: '2222222222', phoneOriginal: '2222222222', status: 'ACTIVE', isPrimary: true, tenantId: 'tenant-1' },
    );
    const svc = new PhoneService({} as any);
    await svc.syncLeadPhone(tx, 'lead-1');
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { phone: '2222222222' },
    });
  });
});

// ─── R1/R2: phoneSearchCondition ──────────────────────────────────────────────
describe('phoneSearchCondition', () => {
  // R2a: uses equals, not contains
  it('returns equals-based condition for phone-like terms', () => {
    const result = phoneSearchCondition('9876543210', 'tenant-1');
    expect(result).toEqual({
      phones: { some: { tenantId: 'tenant-1', phoneNormalized: { equals: '9876543210' } } },
    });
  });

  // R1a: no status filter — deactivated number resolves
  it('does NOT filter by status (historical search spans ACTIVE + INACTIVE)', () => {
    const result = phoneSearchCondition('9876543210', 'tenant-1');
    expect(result).not.toHaveProperty('phones.some.status');
  });

  it('normalizes 91-prefix before building condition', () => {
    const result = phoneSearchCondition('+91 98765 43210', 'tenant-1') as any;
    expect(result.phones.some.phoneNormalized.equals).toBe('9876543210');
  });

  it('returns null for non-phone terms', () => {
    expect(phoneSearchCondition('John', 'tenant-1')).toBeNull();
    expect(phoneSearchCondition('12345', 'tenant-1')).toBeNull();
  });

  it('returns null for empty/short digit strings', () => {
    expect(phoneSearchCondition('abc', 'tenant-1')).toBeNull();
  });

  it('name/email search regression — non-phone terms yield null', () => {
    expect(phoneSearchCondition('john@example.com', 'tenant-1')).toBeNull();
    expect(phoneSearchCondition('Jane Doe', 'tenant-1')).toBeNull();
  });
});
