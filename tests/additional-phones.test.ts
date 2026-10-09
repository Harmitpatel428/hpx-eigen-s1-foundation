/**
 * Task 3 — Lead Backup export "Additional Numbers" column. Pure unit test of the
 * dedupe / primary-exclusion contract in buildAdditionalPhones (no DB).
 */
import { buildAdditionalPhones } from '../src/routes/leads.router';

describe('buildAdditionalPhones', () => {
  it('returns [] when the lead has no contacts or phone history', () => {
    expect(buildAdditionalPhones({ phone: '9876543210' })).toEqual([]);
    expect(buildAdditionalPhones({ phone: null, contacts: [], phones: [] })).toEqual([]);
  });

  it('excludes the primary number even when a contact repeats it in another format', () => {
    const out = buildAdditionalPhones({
      phone: '9876543210',
      contacts: [{ phone: '+91 98765-43210' }], // same number, normalizes to primary → excluded
      phones: [],
    });
    expect(out).toEqual([]);
  });

  it('dedupes across contacts and LeadPhone history by normalized form, keeping originals', () => {
    const out = buildAdditionalPhones({
      phone: '9876543210',
      contacts: [{ phone: '9000000001' }, { phone: '9000000002' }],
      phones: [
        { phoneOriginal: '+91 90000 00001' }, // dup of a contact → excluded
        { phoneOriginal: '9000000003' },
      ],
    });
    expect(out).toEqual(['9000000001', '9000000002', '9000000003']);
  });

  it('skips null/empty numbers and trims the originals it keeps', () => {
    const out = buildAdditionalPhones({
      phone: null,
      contacts: [{ phone: null }, { phone: '  9000000009  ' }],
      phones: [{ phoneOriginal: '' }],
    });
    expect(out).toEqual(['9000000009']);
  });
});
