import { resolveDocAssignee } from '../src/utils/doc-assignee.helper';

// Pure unit test — no DB. Covers the Assigned-column resolution precedence + the legacy date gate.
describe('resolveDocAssignee', () => {
  const owner    = { id: 'owner',    firstName: 'Owen', lastName: 'Ner' };
  const assignee = { id: 'assignee', firstName: 'Ash',  lastName: 'Ignee' };
  const userMap  = new Map([['owner', owner], ['assignee', assignee]]);

  const RELEASE = new Date('2026-11-19T00:00:00Z');
  const LEGACY  = new Date('2026-11-01T00:00:00Z'); // before release → historical
  const MODERN  = new Date('2026-11-20T00:00:00Z'); // on/after release → modern

  it('owner present and resolvable → owner (formal assignment wins, any date)', () => {
    expect(resolveDocAssignee('owner', null, MODERN, userMap, RELEASE)).toBe(owner);
  });

  it('legacy case, only assignedTo → assignedTo user (the historical fix)', () => {
    expect(resolveDocAssignee(null, 'assignee', LEGACY, userMap, RELEASE)).toBe(assignee);
  });

  it('modern case, only assignedTo → null (preserves the 8dab098 invariant)', () => {
    expect(resolveDocAssignee(null, 'assignee', MODERN, userMap, RELEASE)).toBeNull();
  });

  it('both present and conflicting → owner wins, never shadowed by fallback', () => {
    expect(resolveDocAssignee('owner', 'assignee', LEGACY, userMap, RELEASE)).toBe(owner);
  });

  it('legacy owner set but unresolvable (deactivated/cross-tenant) → null, not a stale name', () => {
    expect(resolveDocAssignee('ghost', 'assignee', LEGACY, userMap, RELEASE)).toBeNull();
  });

  it('neither present → null (truly unassigned)', () => {
    expect(resolveDocAssignee(null, null, LEGACY, userMap, RELEASE)).toBeNull();
    expect(resolveDocAssignee(undefined, undefined, MODERN, userMap, RELEASE)).toBeNull();
  });
});
