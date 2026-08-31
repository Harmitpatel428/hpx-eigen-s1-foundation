/**
 * Contract test: OWNER_SELECT must match the shape the frontend Lead.owner type expects.
 * Fails immediately (without a live DB) if the constant drifts from
 * { id, firstName, lastName }.
 */
import { OWNER_SELECT } from '../../src/routes/leads.router';

describe('OWNER_SELECT contract', () => {
  it('selects exactly the fields the frontend Lead.owner type expects', () => {
    expect(OWNER_SELECT).toEqual({ id: true, firstName: true, lastName: true });
  });

  it('does not expose sensitive user columns (e.g. passwordHash, email)', () => {
    const keys = Object.keys(OWNER_SELECT);
    expect(keys).not.toContain('passwordHash');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('tenantId');
  });

  it('contains all required owner fields', () => {
    expect(OWNER_SELECT).toHaveProperty('id', true);
    expect(OWNER_SELECT).toHaveProperty('firstName', true);
    expect(OWNER_SELECT).toHaveProperty('lastName', true);
  });
});
