/** Guard: `user:password:reset` must never be granted to a preset (non-admin) role.
 *  Source-scanned rather than imported — prisma/seed-permissions.ts self-executes. */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const SEED = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'seed-permissions.ts'), 'utf8');

describe('user:password:reset is Organization-Admin exclusive in the seed', () => {
  it('is defined in the canonical permission list', () => {
    expect(SEED).toContain("slug: 'user:password:reset'");
  });

  it('appears exactly once — i.e. granted to no preset role anywhere in the seed', () => {
    const occurrences = SEED.split('user:password:reset').length - 1;
    expect(occurrences).toBe(1);
  });
});
