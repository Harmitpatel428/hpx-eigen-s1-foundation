/**
 * Case Field Catalog — rules — Integration Tests (Phase 2).
 * Covers flag gate, RBAC, tenant isolation, rule validation (fields / operators /
 * options / self-reference), archive, and audit trail.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as http from 'http';
import { PrismaClient } from '@prisma/client';

import { createCaseFieldsRouter } from '../../src/routes/case-fields.router';
import { createCaseFieldRulesRouter } from '../../src/routes/case-field-rules.router';
import { PermissionService } from '../../src/services/permission.service';
import {
  makeApp, startServer, makeReq, provisionTenant, cleanupTenants,
  ProvisionedTenant,
} from './_shared/case-field-harness';

const prisma = new PrismaClient();
const permissionService = new PermissionService(prisma);

let server: http.Server;
let req: ReturnType<typeof makeReq>;

let t: ProvisionedTenant;       // engine ON, main
let disabled: ProvisionedTenant;// engine OFF
let other: ProvisionedTenant;   // engine ON, isolation
const tracked: string[] = [];

const FIELDS = '/api/v1/case-fields';
const RULES = '/api/v1/case-field-rules';

async function makeField(tt: ProvisionedTenant, key: string, type: string, activate = true): Promise<any> {
  const created = await req('POST', FIELDS, {
    token: tt.manage.token,
    body: { key, name: key, type, owningDepartmentId: tt.deptId },
  });
  expect(created.status).toBe(201);
  const f = created.body.data;
  if (activate) {
    const a = await req('POST', `${FIELDS}/${f.id}/activate`, { token: tt.manage.token });
    expect(a.status).toBe(200);
  }
  return f;
}

// Two active fields per tenant for building rules.
let condText: any, target: any, condSelect: any, selectOptA: any;

beforeAll(async () => {
  t = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  disabled = await provisionTenant(prisma, permissionService, { engineEnabled: false });
  other = await provisionTenant(prisma, permissionService, { engineEnabled: true });
  tracked.push(t.tenantId, disabled.tenantId, other.tenantId);

  const app = makeApp([
    [FIELDS, createCaseFieldsRouter(prisma)],
    [RULES, createCaseFieldRulesRouter(prisma)],
  ]);
  const started = await startServer(app);
  server = started.server;
  req = makeReq(started.baseUrl);

  condText = await makeField(t, 'cond_text', 'TEXT');
  target = await makeField(t, 'target_field', 'NUMBER');
  condSelect = await makeField(t, 'cond_select', 'SELECT');
  const opt = await req('POST', `${FIELDS}/${condSelect.id}/options`, {
    token: t.manage.token, body: { key: 'opt_a', label: 'A' },
  });
  expect(opt.status).toBe(201);
  selectOptA = opt.body.data;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanupTenants(prisma, tracked);
  await prisma.$disconnect();
}, 30_000);

describe('Auth / flag / permissions', () => {
  it('no token → 401', async () => {
    expect((await req('GET', RULES)).status).toBe(401);
  });
  it('flag disabled → 403 CASE_OPERATIONS_ENGINE_DISABLED', async () => {
    const { status, body } = await req('GET', RULES, { token: disabled.manage.token });
    expect(status).toBe(403);
    expect(body.code).toBe('CASE_OPERATIONS_ENGINE_DISABLED');
  });
  it('view-only cannot create → 403', async () => {
    const { status } = await req('POST', RULES, {
      token: t.view.token,
      body: { name: 'r', conditionFieldId: condText.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id },
    });
    expect(status).toBe(403);
  });
});

describe('Rule creation & validation', () => {
  it('creates a valid presence rule (IS_NOT_EMPTY)', async () => {
    const { status, body } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'require target', conditionFieldId: condText.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id },
    });
    expect(status).toBe(201);
    expect(body.data.effectType).toBe('REQUIRE_FIELD');
  });

  it('self-referencing rule → 422', async () => {
    const { status } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'self', conditionFieldId: condText.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: condText.id },
    });
    expect(status).toBe(422);
  });

  it('cross-tenant condition field → 404', async () => {
    const otherField = await makeField(other, 'foreign', 'TEXT');
    const { status } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'x', conditionFieldId: otherField.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id },
    });
    expect(status).toBe(404);
  });

  it('operator incompatible with field type → 400', async () => {
    // GREATER_THAN is invalid for a TEXT condition field
    const { status } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'bad-op', conditionFieldId: condText.id, conditionOperator: 'GREATER_THAN', conditionValue: 'x', targetFieldId: target.id },
    });
    expect(status).toBe(400);
  });

  it('scalar conditionValue type mismatch → 400', async () => {
    // NUMBER target used as condition, string value
    const numField = await makeField(t, 'num_cond', 'NUMBER');
    const { status } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'bad-val', conditionFieldId: numField.id, conditionOperator: 'EQUALS', conditionValue: 'not-a-number', targetFieldId: target.id },
    });
    expect(status).toBe(400);
  });

  it('SELECT EQUALS requires a valid conditionOptionId', async () => {
    const missing = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'sel-missing', conditionFieldId: condSelect.id, conditionOperator: 'EQUALS', targetFieldId: target.id },
    });
    expect(missing.status).toBe(400);

    const ok = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'sel-ok', conditionFieldId: condSelect.id, conditionOperator: 'EQUALS', conditionOptionId: selectOptA.id, targetFieldId: target.id },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.conditionOptionId).toBe(selectOptA.id);
  });

  it('IS_EMPTY with a value → 400 is not enforced, but presence op clears value/option', async () => {
    const { status, body } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'presence', conditionFieldId: condText.id, conditionOperator: 'IS_EMPTY', conditionValue: 'ignored', targetFieldId: target.id },
    });
    expect(status).toBe(201);
    expect(body.data.conditionValue).toBeNull();
    expect(body.data.conditionOptionId).toBeNull();
  });

  it('rule referencing an archived field is rejected', async () => {
    const tmp = await makeField(t, 'to_archive', 'TEXT', false);
    await req('POST', `${FIELDS}/${tmp.id}/archive`, { token: t.manage.token });
    const { status } = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'arch-ref', conditionFieldId: tmp.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id },
    });
    expect([400, 404, 422]).toContain(status); // archived → not usable
  });
});

describe('Archive + audit', () => {
  it('archives a rule and writes audit rows for create + archive', async () => {
    const created = await req('POST', RULES, {
      token: t.manage.token,
      body: { name: 'to-archive', conditionFieldId: condText.id, conditionOperator: 'IS_NOT_EMPTY', targetFieldId: target.id },
    });
    expect(created.status).toBe(201);
    const ruleId = created.body.data.id;
    const arch = await req('POST', `${RULES}/${ruleId}/archive`, { token: t.manage.token });
    expect(arch.status).toBe(200);

    for (const eventType of ['CASE_FIELD_RULE_CREATED', 'CASE_FIELD_RULE_ARCHIVED']) {
      const row = await prisma.auditLog.findFirst({ where: { tenantId: t.tenantId, eventType, entityId: ruleId } });
      expect(row).toBeTruthy();
      expect(row?.entityType).toBe('CaseFieldRule');
    }
  });
});
