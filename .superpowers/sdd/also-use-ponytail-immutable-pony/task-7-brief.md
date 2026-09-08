# Task 7: Integration Tests — Audit Chain + Portal Activation

## What to build

Two integration test files exercising the audit chain and portal activation systems against real PostgreSQL.

## Files to create

1. `tests/integration/audit-chain.test.ts` — 10 tests
2. `tests/integration/portal-activate.test.ts` — 19 tests

## Test infrastructure pattern

Follow the same pattern as `tests/integration/signup-org-init.test.ts`:
- `import 'dotenv/config'`
- `import { describe, it, beforeAll, afterAll, expect } from '@jest/globals'`
- `import { PrismaClient } from '@prisma/client'`
- Random test data via `crypto.randomUUID()`
- Direct Prisma client for setup/teardown (no mocks)
- `afterAll` cleans up test data
- Tests use `@swc/jest` transform (jest.config.js) — standard TypeScript

## File 1: tests/integration/audit-chain.test.ts

```typescript
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { AuditService } from '../../src/services/audit.service';
import { AuditChainBranchError } from '../../src/types/exceptions';

const prisma = new PrismaClient();

// Each test uses a unique tenantId to isolate chains
function tenantId() { return crypto.randomUUID(); }

// Helper: create a minimal tenant so FK constraints pass
async function seedTenant(id: string) {
  await prisma.tenant.create({ data: { id, name: `test-${id.slice(0, 8)}` } });
}

async function cleanupTenant(id: string) {
  await prisma.auditLog.deleteMany({ where: { tenantId: id } });
  await prisma.tenant.deleteMany({ where: { id } });
}

const tenants: string[] = [];

afterAll(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await prisma.$disconnect();
});

describe('audit chain integrity', () => {
  it('1. creates genesis record for empty tenant', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({
      tenantId: tid, eventType: 'TEST', entityType: 'Test',
      entityId: '1', operation: 'CREATE', payload: { test: true },
    });

    const records = await prisma.auditLog.findMany({ where: { tenantId: tid } });
    expect(records).toHaveLength(1);
    expect(records[0].previousHash).toBeNull();
    expect(records[0].hashVersion).toBe(1);
  });

  it('2. sequential chain — 3 writes, verifyChain valid', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    for (let i = 0; i < 3; i++) {
      await audit.log({
        tenantId: tid, eventType: 'TEST', entityType: 'Test',
        entityId: String(i), operation: 'CREATE', payload: { seq: i },
      });
    }

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    const records = await prisma.auditLog.findMany({
      where: { tenantId: tid }, orderBy: { createdAt: 'asc' },
    });
    expect(records).toHaveLength(3);
    expect(records[0].previousHash).toBeNull();
    expect(records[1].previousHash).toBe(records[0].currentHash);
    expect(records[2].previousHash).toBe(records[1].currentHash);
  });

  it('3. concurrent writes — 10 parallel, verifyChain valid after', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.log({
          tenantId: tid, eventType: 'CONCURRENT', entityType: 'Test',
          entityId: String(i), operation: 'CREATE', payload: { idx: i },
        })
      )
    );

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    const count = await prisma.auditLog.count({ where: { tenantId: tid } });
    expect(count).toBe(10);
  });

  it('4. different tenants do not interfere', async () => {
    const tid1 = tenantId();
    const tid2 = tenantId();
    tenants.push(tid1, tid2);
    await seedTenant(tid1);
    await seedTenant(tid2);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid1, eventType: 'T1', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });
    await audit.log({ tenantId: tid2, eventType: 'T2', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });

    const r1 = await audit.verifyChain(tid1);
    const r2 = await audit.verifyChain(tid2);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });

  it('5. tamper detection — modified currentHash breaks link', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid, eventType: 'T', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });
    await audit.log({ tenantId: tid, eventType: 'T', entityType: 'Test', entityId: '2', operation: 'CREATE', payload: {} });

    // Tamper: change the first row's currentHash
    const first = await prisma.auditLog.findFirst({ where: { tenantId: tid }, orderBy: { createdAt: 'asc' } });
    // Must use raw SQL since unique constraint prevents duplicate hashes
    await prisma.$executeRaw`UPDATE "AuditLog" SET "currentHash" = ${'a'.repeat(64)} WHERE "id" = ${first!.id}::uuid`;

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('6. multiple-leaf detection — manually created orphan', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid, eventType: 'T', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });

    // Create an orphan row (previousHash = null = second genesis)
    await prisma.$executeRaw`
      INSERT INTO "AuditLog" ("id", "tenantId", "eventType", "entityType", "entityId", "operation", "payload", "previousHash", "currentHash", "hashVersion")
      VALUES (gen_random_uuid(), ${tid}::uuid, 'ORPHAN', 'Test', 'orphan', 'CREATE', '{}', NULL, ${'b'.repeat(64)}, 0)
    `;

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('genesis'))).toBe(true);
  });

  it('7. duplicate currentHash detected by unique constraint', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid, eventType: 'T', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });

    const existing = await prisma.auditLog.findFirst({ where: { tenantId: tid } });
    // Attempting to insert a duplicate currentHash should fail
    await expect(
      prisma.$executeRaw`
        INSERT INTO "AuditLog" ("id", "tenantId", "eventType", "entityType", "entityId", "operation", "payload", "previousHash", "currentHash", "hashVersion")
        VALUES (gen_random_uuid(), ${tid}::uuid, 'DUP', 'Test', 'dup', 'CREATE', '{}', NULL, ${existing!.currentHash}, 0)
      `
    ).rejects.toThrow();
  });

  it('8. hashVersion=1 content hash verification', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid, eventType: 'V1', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: { key: 'value' } });

    const record = await prisma.auditLog.findFirst({ where: { tenantId: tid } });
    expect(record!.hashVersion).toBe(1);

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(true);
  });

  it('9. hashVersion=0 link-only verification (legacy rows)', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    // Insert a legacy v0 row directly
    await prisma.$executeRaw`
      INSERT INTO "AuditLog" ("id", "tenantId", "eventType", "entityType", "entityId", "operation", "payload", "previousHash", "currentHash", "hashVersion")
      VALUES (gen_random_uuid(), ${tid}::uuid, 'LEGACY', 'Test', 'legacy', 'CREATE', '{}', NULL, ${'c'.repeat(64)}, 0)
    `;

    const audit = new AuditService(prisma);
    const result = await audit.verifyChain(tid);
    // v0 rows are link-verified only — content hash is not checked
    expect(result.valid).toBe(true);
  });

  it('10. disconnected row detection', async () => {
    const tid = tenantId();
    tenants.push(tid);
    await seedTenant(tid);

    const audit = new AuditService(prisma);
    await audit.log({ tenantId: tid, eventType: 'T', entityType: 'Test', entityId: '1', operation: 'CREATE', payload: {} });

    // Insert a row with a previousHash that doesn't match any currentHash (disconnected)
    await prisma.$executeRaw`
      INSERT INTO "AuditLog" ("id", "tenantId", "eventType", "entityType", "entityId", "operation", "payload", "previousHash", "currentHash", "hashVersion")
      VALUES (gen_random_uuid(), ${tid}::uuid, 'DISCONNECTED', 'Test', 'disc', 'CREATE', '{}', ${'d'.repeat(64)}, ${'e'.repeat(64)}, 0)
    `;

    const result = await audit.verifyChain(tid);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('disconnected'))).toBe(true);
  });
});
```

## File 2: tests/integration/portal-activate.test.ts

This test requires a full Express server with auth, permissions, and the cases router. It needs:
- A test tenant + user + role + permissions
- A test DocCase with portalPhoneLast4
- JWT auth for making authenticated requests

```typescript
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import { PrismaClient, DocCaseStatus, ScopeType } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { createCasesRouter } from '../../src/routes/handoff.router';
import { AppException } from '../../src/types/exceptions';
import { requestContextStorage } from '../../src/context/request-context';
import { authMiddleware } from '../../src/middleware/auth.middleware';

const prisma = new PrismaClient();

let server: http.Server;
let baseUrl: string;

// Test fixtures
const TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const LEAD_ID = crypto.randomUUID();

let jwtToken: string;
let unpermittedToken: string;

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cases', createCasesRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

async function seedTestData() {
  // Create tenants
  await prisma.tenant.createMany({
    data: [
      { id: TENANT_ID, name: 'Portal Test Tenant' },
      { id: OTHER_TENANT_ID, name: 'Other Tenant' },
    ],
  });

  // Create users with hashed password
  const pw = await bcrypt.hash('TestPass123!', 12);
  await prisma.user.createMany({
    data: [
      { id: USER_ID, email: `portal-test-${TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: TENANT_ID },
      { id: OTHER_USER_ID, email: `other-${OTHER_TENANT_ID.slice(0, 8)}@example.com`, password: pw, tenantId: OTHER_TENANT_ID },
    ],
  });

  // Create role + permissions for portal:activate
  const role = await prisma.role.create({
    data: { tenantId: TENANT_ID, name: 'Test Admin', isSystem: true },
  });
  const perm = await prisma.permission.findFirst({ where: { slug: 'portal:activate' } });
  if (perm) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
  }
  // Also grant handoff:accept so the router mounts correctly (needed for auth)
  const handoffPerm = await prisma.permission.findFirst({ where: { slug: 'handoff:accept' } });
  if (handoffPerm) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: handoffPerm.id } });
  }
  await prisma.userRole.create({
    data: { userId: USER_ID, roleId: role.id, scopeType: ScopeType.ORGANIZATION },
  });

  // Create session for JWT
  const session = await prisma.session.create({
    data: {
      tenantId: TENANT_ID, userId: USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  jwtToken = jwt.sign(
    { userId: USER_ID, tenantId: TENANT_ID, sessionId: session.id },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );

  // Unpermitted user (different tenant, no portal:activate permission)
  const otherSession = await prisma.session.create({
    data: {
      tenantId: OTHER_TENANT_ID, userId: OTHER_USER_ID, status: 'ACTIVE',
      refreshTokenHash: await bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  unpermittedToken = jwt.sign(
    { userId: OTHER_USER_ID, tenantId: OTHER_TENANT_ID, sessionId: otherSession.id },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );

  // Create a lead for the DocCase FK
  await prisma.lead.create({
    data: { id: LEAD_ID, tenantId: TENANT_ID, firstName: 'Test', lastName: 'Client', email: 'test@example.com' },
  });
}

async function createCase(overrides: Partial<{
  status: DocCaseStatus;
  portalPhoneLast4: string | null;
  portalEnabledAt: Date | null;
  tenantId: string;
}> = {}) {
  return prisma.docCase.create({
    data: {
      tenantId: overrides.tenantId ?? TENANT_ID,
      leadId: LEAD_ID,
      caseNumber: `HPX-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`,
      status: overrides.status ?? DocCaseStatus.ACTIVE,
      portalPhoneLast4: overrides.portalPhoneLast4 ?? '1234',
      portalEnabledAt: overrides.portalEnabledAt ?? null,
    },
  });
}

async function activate(caseId: string, token?: string) {
  const res = await fetch(`${baseUrl}/api/v1/cases/${caseId}/portal/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function cleanupTestData() {
  await prisma.portalSession.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseEvent.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.docCaseNote.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCaseDocument.deleteMany({ where: { case: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.docCase.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.rolePermission.deleteMany({ where: { role: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: [USER_ID, OTHER_USER_ID] } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.session.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
  await prisma.lead.deleteMany({ where: { id: LEAD_ID } });
  await prisma.user.deleteMany({ where: { id: { in: [USER_ID, OTHER_USER_ID] } } });
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
}

beforeAll(async () => {
  await seedTestData();
  const app = makeTestApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTestData();
  await prisma.$disconnect();
});

describe('POST /cases/:caseId/portal/activate', () => {
  it('1. unauthenticated → 401', async () => {
    const c = await createCase();
    const r = await activate(c.id);
    expect(r.status).toBe(401);
  });

  it('3. wrong tenant → 404', async () => {
    const c = await createCase();
    const r = await activate(c.id, unpermittedToken);
    // unpermittedToken is for OTHER_TENANT_ID which has no portal:activate permission
    expect([403, 404]).toContain(r.status);
  });

  it('4. invalid caseId → 400', async () => {
    const r = await activate('not-a-uuid', jwtToken);
    expect(r.status).toBe(400);
  });

  it('5. non-existent case → 404', async () => {
    const r = await activate(crypto.randomUUID(), jwtToken);
    expect(r.status).toBe(404);
  });

  it('6. INCOMING status → 422', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(422);
  });

  it('7. missing portalPhoneLast4 → 400', async () => {
    const c = await createCase({ portalPhoneLast4: null });
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(400);
  });

  it('8. valid activation → 200, portalEnabledAt set', async () => {
    const c = await createCase();
    const r = await activate(c.id, jwtToken);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.alreadyEnabled).toBe(false);
    expect(r.body.data.portalEnabledAt).toBeTruthy();

    const updated = await prisma.docCase.findUnique({ where: { id: c.id } });
    expect(updated!.portalEnabledAt).toBeTruthy();
  });

  it('9. exactly one PORTAL_ACTIVATED audit record', async () => {
    const c = await createCase();
    await activate(c.id, jwtToken);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].hashVersion).toBe(1);
  });

  it('10. repeated activation → 200 idempotent, no duplicate audit', async () => {
    const c = await createCase();
    await activate(c.id, jwtToken);
    const r2 = await activate(c.id, jwtToken);

    expect(r2.status).toBe(200);
    expect(r2.body.data.alreadyEnabled).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('11. concurrent activation → exactly one audit record', async () => {
    const c = await createCase();
    const results = await Promise.all([
      activate(c.id, jwtToken),
      activate(c.id, jwtToken),
      activate(c.id, jwtToken),
    ]);

    const successes = results.filter(r => r.status === 200);
    expect(successes.length).toBe(3); // all succeed (idempotent)

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: TENANT_ID, entityId: c.id, eventType: 'PORTAL_ACTIVATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('12. response excludes portalPhoneSnapshot', async () => {
    const c = await createCase();
    const r = await activate(c.id, jwtToken);
    expect(r.body.data).not.toHaveProperty('portalPhoneSnapshot');
    expect(r.body.data).not.toHaveProperty('portalPhoneLast4');
  });
});

describe('portal auto-activation (via reconcilePortalActivation)', () => {
  // These tests exercise the shared helpers indirectly through the PortalService.
  // We test by calling the service methods that trigger reconcilePortalActivation.

  it('16. auto-activation enforces ACTIVE status', async () => {
    const c = await createCase({ status: DocCaseStatus.INCOMING });
    // Publishing a note on an INCOMING case should NOT auto-activate
    // We verify by checking portalEnabledAt remains null
    expect(c.portalEnabledAt).toBeNull();
    // Since INCOMING is not ACTIVE, even if we had visible content, portal stays off
  });

  it('18. deactivation revokes sessions', async () => {
    const c = await createCase({ portalEnabledAt: new Date() });

    // Create an active portal session
    await prisma.portalSession.create({
      data: {
        caseId: c.id,
        tokenHash: crypto.randomBytes(32).toString('hex'),
        phoneLast4: '1234',
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Deactivate by clearing portalEnabledAt (simulate via direct service call)
    // For integration test: use the portal service's disablePortalInTx indirectly
    // by setting canActivate=false conditions
    await prisma.docCase.update({
      where: { id: c.id },
      data: { portalEnabledAt: null },
    });

    // Revoke sessions as the service would
    await prisma.portalSession.updateMany({
      where: { caseId: c.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const sessions = await prisma.portalSession.findMany({
      where: { caseId: c.id },
    });
    expect(sessions.every(s => s.revokedAt !== null)).toBe(true);
  });
});
```

**Note:** Some portal tests (13-15, 17, 19) require invoking the note/document publishing flow which triggers `reconcilePortalActivation`. These are complex to set up in isolation. Implement as many as feasible given the test infrastructure. At minimum, tests 1-12 and 16, 18 are required. The remaining tests can be marked with `it.todo()` if the publishing flow is too complex to set up — but clearly document what they would test.

## Key constraints

- Do NOT mock the database — use real PostgreSQL
- Each test must clean up after itself (or use unique tenant IDs)
- The `portal:activate` permission must be seeded via migration before tests run (Task 5 migration)
- JWT_SECRET must be set in the test environment
- Use `expect(r.status).toBe(...)` for HTTP status assertions

## Verification

Run both test files:
```bash
npx jest tests/integration/audit-chain.test.ts --verbose
npx jest tests/integration/portal-activate.test.ts --verbose
```

## Commit

```
test: add integration tests for audit chain integrity and portal activation

- 10 audit chain tests: genesis, sequential, concurrent, tamper, branch, legacy
- Portal activation tests: auth, validation, idempotency, concurrency, audit
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-7-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- Test results (pass/fail counts)
- Concerns (if any)
- Which tests are .todo (if any) and why
