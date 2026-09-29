/**
 * Case Field Catalog — definitions & options — Integration Tests (Phase 2).
 * Real Postgres. Covers feature-flag gate, RBAC, tenant isolation, duplicate keys,
 * lifecycle transitions, hard-delete-unused-only, option rules, and audit trail.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as http from 'http';
import { PrismaClient } from '@prisma/client';

import { createCaseFieldsRouter } from '../../src/routes/case-fields.router';
import { PermissionService } from '../../src/services/permission.service';
import {
  makeApp, startServer, makeReq, provisionTenant, cleanupTenants,
  ProvisionedTenant,
} from './_shared/case-field-harness';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

let server: http.Server;
let req: ReturnType<typeof makeReq>;

let enabled: ProvisionedTenant;   // engine ON
let disabled: ProvisionedTenant;  // engine OFF
let other: ProvisionedTenant;     // engine ON, isolation checks
const tracked: string[] = [];

const BASE = '/api/v1/case-fields';

async function newField(t: ProvisionedTenant, overrides: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await req('POST', BASE, {
    token: t.manage.token,
    body: {
      key: `f_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Field',
      type: 'TEXT',
      owningDepartmentId: t.deptId,
      ...overrides,
    },
  });
  expect(status).toBe(201);
  return body.data;
}

beforeAll(async () => {
  enabled = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  disabled = await provisionTenant(prisma, permissionService, { engineEnabled: false });
  other = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  tracked.push(enabled.tenantId, disabled.tenantId, other.tenantId);

  const app = makeApp([[BASE, createCaseFieldsRouter(prisma)]]);
  const started = await startServer(app);
  server = started.server;
  req = makeReq(started.baseUrl);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanupTenants(prisma, tracked);
  await prisma.$disconnect();
}, 30_000);

describe('Auth & feature flag', () => {
  it('no token → 401', async () => {
    const { status } = await req('GET', BASE);
    expect(status).toBe(401);
  });

  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const { status, body } = await req('GET', BASE, { token: disabled.manage.token });
    expect(status).toBe(403);
    expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });

  it('flag disabled blocks writes too → 403', async () => {
    const { status, body } = await req('POST', BASE, {
      token: disabled.manage.token,
      body: { key: 'x', name: 'X', type: 'TEXT', owningDepartmentId: disabled.deptId },
    });
    expect(status).toBe(403);
    expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
});

describe('Permissions', () => {
  it('no case-field perm → 403 on list', async () => {
    const { status } = await req('GET', BASE, { token: enabled.none.token });
    expect(status).toBe(403);
  });
  it('view-only can list', async () => {
    const { status } = await req('GET', BASE, { token: enabled.view.token });
    expect(status).toBe(200);
  });
  it('view-only cannot create → 403', async () => {
    const { status } = await req('POST', BASE, {
      token: enabled.view.token,
      body: { key: 'nope', name: 'N', type: 'TEXT', owningDepartmentId: enabled.deptId },
    });
    expect(status).toBe(403);
  });
});

describe('Create + duplicate key', () => {
  it('creates a DRAFT field', async () => {
    const f = await newField(enabled, { key: 'primary_contact', name: 'Primary Contact' });
    expect(f.status).toBe('DRAFT');
    expect(f.key).toBe('primary_contact');
  });
  it('duplicate key → 409', async () => {
    const { status, body } = await req('POST', BASE, {
      token: enabled.manage.token,
      body: { key: 'primary_contact', name: 'Dup', type: 'TEXT', owningDepartmentId: enabled.deptId },
    });
    expect(status).toBe(409);
  });
  it('rejects a department from another tenant', async () => {
    const { status } = await req('POST', BASE, {
      token: enabled.manage.token,
      body: { key: 'other_dept', name: 'X', type: 'TEXT', owningDepartmentId: other.deptId },
    });
    expect(status).toBe(400);
  });
});

describe('Tenant isolation', () => {
  it("cannot GET another tenant's field → 404", async () => {
    const f = await newField(enabled, { key: 'iso_field' });
    const { status } = await req('GET', `${BASE}/${f.id}`, { token: other.manage.token });
    expect(status).toBe(404);
  });
});

describe('Lifecycle transitions', () => {
  it('activate DRAFT→ACTIVE, then illegal re-activate → 422', async () => {
    const f = await newField(enabled, { key: 'lc_activate' });
    const a = await req('POST', `${BASE}/${f.id}/activate`, { token: enabled.manage.token });
    expect(a.status).toBe(200);
    expect(a.body.data.status).toBe('ACTIVE');
    expect(a.body.data.isActive).toBe(true);
    const again = await req('POST', `${BASE}/${f.id}/activate`, { token: enabled.manage.token });
    expect(again.status).toBe(422);
  });

  it('read-only only from ACTIVE; update on READ_ONLY → 422', async () => {
    const f = await newField(enabled, { key: 'lc_ro' });
    // read-only from DRAFT is illegal
    expect((await req('POST', `${BASE}/${f.id}/read-only`, { token: enabled.manage.token })).status).toBe(422);
    await req('POST', `${BASE}/${f.id}/activate`, { token: enabled.manage.token });
    const ro = await req('POST', `${BASE}/${f.id}/read-only`, { token: enabled.manage.token });
    expect(ro.status).toBe(200);
    expect(ro.body.data.status).toBe('READ_ONLY');
    const upd = await req('PATCH', `${BASE}/${f.id}`, { token: enabled.manage.token, body: { name: 'nope' } });
    expect(upd.status).toBe(422);
  });

  it('archive → ARCHIVED, then update → 422', async () => {
    const f = await newField(enabled, { key: 'lc_archive' });
    const arch = await req('POST', `${BASE}/${f.id}/archive`, { token: enabled.manage.token });
    expect(arch.status).toBe(200);
    expect(arch.body.data.status).toBe('ARCHIVED');
    const upd = await req('PATCH', `${BASE}/${f.id}`, { token: enabled.manage.token, body: { name: 'x' } });
    expect(upd.status).toBe(422);
  });

  it('key and type are immutable', async () => {
    const f = await newField(enabled, { key: 'lc_immutable' });
    expect((await req('PATCH', `${BASE}/${f.id}`, { token: enabled.manage.token, body: { key: 'changed' } })).status).toBe(400);
    expect((await req('PATCH', `${BASE}/${f.id}`, { token: enabled.manage.token, body: { type: 'NUMBER' } })).status).toBe(400);
  });
});

describe('Hard delete — unused only', () => {
  it('DRAFT + unused → 200', async () => {
    const f = await newField(enabled, { key: 'del_ok' });
    expect((await req('DELETE', `${BASE}/${f.id}`, { token: enabled.manage.token })).status).toBe(200);
    expect((await req('GET', `${BASE}/${f.id}`, { token: enabled.manage.token })).status).toBe(404);
  });
  it('ACTIVE (unused) → 422', async () => {
    const f = await newField(enabled, { key: 'del_active' });
    await req('POST', `${BASE}/${f.id}/activate`, { token: enabled.manage.token });
    expect((await req('DELETE', `${BASE}/${f.id}`, { token: enabled.manage.token })).status).toBe(422);
  });
  it('DRAFT with an option → 422', async () => {
    const f = await newField(enabled, { key: 'del_hasopt', type: 'SELECT' });
    const opt = await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'a', label: 'A' } });
    expect(opt.status).toBe(201);
    expect((await req('DELETE', `${BASE}/${f.id}`, { token: enabled.manage.token })).status).toBe(422);
  });
});

describe('Options', () => {
  it('rejects options on a non-select field → 422', async () => {
    const f = await newField(enabled, { key: 'opt_nonselect', type: 'TEXT' });
    const { status } = await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'x', label: 'X' } });
    expect(status).toBe(422);
  });
  it('creates options and blocks a duplicate key → 409', async () => {
    const f = await newField(enabled, { key: 'opt_select', type: 'SELECT' });
    expect((await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'red', label: 'Red' } })).status).toBe(201);
    expect((await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'red', label: 'Red2' } })).status).toBe(409);
  });
  it('blocks a parent-option cycle → 400', async () => {
    const f = await newField(enabled, { key: 'opt_cycle', type: 'SELECT' });
    const a = (await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'a', label: 'A' } })).body.data;
    const b = (await req('POST', `${BASE}/${f.id}/options`, { token: enabled.manage.token, body: { key: 'b', label: 'B', parentOptionId: a.id } })).body.data;
    // point a's parent at b → a->b->a cycle
    const { status } = await req('PATCH', `${BASE}/${f.id}/options/${a.id}`, { token: enabled.manage.token, body: { parentOptionId: b.id } });
    expect(status).toBe(400);
  });
});

describe('Archived filtering', () => {
  it('default list excludes archived; includeArchived=true includes it', async () => {
    const f = await newField(enabled, { key: 'arch_filter' });
    await req('POST', `${BASE}/${f.id}/archive`, { token: enabled.manage.token });
    const def = await req('GET', BASE, { token: enabled.manage.token });
    expect(def.body.data.some((x: any) => x.id === f.id)).toBe(false);
    const inc = await req('GET', `${BASE}?includeArchived=true`, { token: enabled.manage.token });
    expect(inc.body.data.some((x: any) => x.id === f.id)).toBe(true);
  });
});

describe('Audit trail', () => {
  it('every field mutation writes an AuditLog row', async () => {
    const f = await newField(enabled, { key: 'audited_field' });
    await req('POST', `${BASE}/${f.id}/activate`, { token: enabled.manage.token });
    await req('POST', `${BASE}/${f.id}/archive`, { token: enabled.manage.token });
    for (const eventType of ['CASE_FIELD_CREATED', 'CASE_FIELD_ACTIVATED', 'CASE_FIELD_ARCHIVED']) {
      const row = await prisma.auditLog.findFirst({
        where: { tenantId: enabled.tenantId, eventType, entityId: f.id },
      });
      expect(row).toBeTruthy();
      expect(row?.entityType).toBe('CaseFieldDefinition');
    }
  });
});
