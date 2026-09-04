import * as fs from 'fs';
import * as path from 'path';

/**
 * reg #10 (WP-1 PR-1) guard. Impersonation (V10) was removed backend-side. Two failure modes
 * this test kills:
 *  1. Resurrection — the `user:impersonate` permission slug creeping back into the seed catalog
 *     or app code, which would silently undo the removal migration on the next seed run.
 *  2. Route re-add — the `/impersonate` or `/exit-impersonation` endpoints coming back.
 *
 * Scope note: prisma/migrations/** is intentionally EXCLUDED — applied migrations are immutable
 * history and legitimately contain the string (the original seed + this removal migration).
 */
const ROOT = path.join(__dirname, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'migrations' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe('impersonation removed (reg #10)', () => {
  it('no seed/catalog or src source references user:impersonate', () => {
    const files = [
      path.join(ROOT, 'prisma', 'seed-permissions.ts'),
      path.join(ROOT, 'prisma', 'seed.ts'),
      ...walk(path.join(ROOT, 'src')),
    ].filter((f) => fs.existsSync(f));

    const offenders = files.filter((f) => /user:impersonate/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('sessions router no longer registers the impersonation endpoints', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sessions.router.ts'), 'utf8');
    expect(src).not.toMatch(/'\/impersonate'/);
    expect(src).not.toMatch(/'\/exit-impersonation'/);
  });
});
