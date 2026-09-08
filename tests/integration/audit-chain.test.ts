/**
 * Audit chain integrity — integration tests.
 *
 * Exercises AuditService directly against real PostgreSQL: genesis creation,
 * sequential/concurrent chaining, cross-tenant isolation, and detection of
 * tampering, branching, duplicate hashes, and disconnected rows.
 */
import 'dotenv/config';
import { describe, it, afterAll, expect } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { AuditService } from '../../src/services/audit.service';

const prisma = new PrismaClient();

function tenantId() { return crypto.randomUUID(); }

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
