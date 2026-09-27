/**
 * Permission Reconciliation — Integration Tests (Phase 1, Task A)
 *
 * Guards against the permission "split-brain": several legacy slugs
 * (handoff:*, portal:*, cases:*, mandate:*) were seeded only via raw-SQL
 * migrations and were never added to prisma/seed-permissions.ts's PERMISSIONS
 * array. A fresh environment that seeds permissions from seed-permissions.ts
 * alone (without replaying every historical migration) would be missing them.
 *
 * This test does NOT seed any missing permission itself — it only reads what
 * is already in the DB (via the shared jest globalSetup, which runs
 * `prisma migrate deploy` then `seed-permissions.ts`) and in the seed-file
 * source text. If either the migration or the seed array regresses and drops
 * a slug, this test fails.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { ENGINE_PERMISSION_SLUGS } from './_shared/engine-permission-slugs';

const prisma = new PrismaClient();

async function getPermId(slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded. Run seed-permissions.ts first.`);
  return p.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Permission reconciliation — 35 slugs (19 legacy + 16 Case Engine)', () => {
  it.each(ENGINE_PERMISSION_SLUGS)("getPermId resolves for '%s'", async (slug) => {
    await expect(getPermId(slug)).resolves.toEqual(expect.any(String));
  });

  // seed-permissions.ts is NOT side-effect-free to import — its main() runs on
  // import (module top level) and would perform a real seed run / process.exit
  // as a side effect of merely loading the module in a test file. So instead of
  // `import`-ing it, read it as text and assert each slug appears as a quoted
  // string literal in the PERMISSIONS array. This is a text-fallback assertion,
  // not a full parse — it verifies the slug string is present in the source,
  // not that it's well-formed as an object entry.
  it('seed-permissions.ts source contains every slug as a quoted literal', () => {
    const seedFilePath = path.resolve(__dirname, '../../prisma/seed-permissions.ts');
    const source = fs.readFileSync(seedFilePath, 'utf8');

    for (const slug of ENGINE_PERMISSION_SLUGS) {
      const singleQuoted = `'${slug}'`;
      const doubleQuoted = `"${slug}"`;
      const found = source.includes(singleQuoted) || source.includes(doubleQuoted);
      expect(found).toBe(true);
    }
  });
});
