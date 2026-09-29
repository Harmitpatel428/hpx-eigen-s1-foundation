/**
 * Shared integration harness for the Case Field Catalog suites.
 * Mirrors crm-settings-case-engine.test.ts: real Postgres, inline fixtures,
 * role grant + invalidatePermissionCache. Requires seeded permissions
 * (integration-bootstrap.js runs seed-permissions.ts).
 */
import * as crypto from 'crypto';
import * as http from 'http';
import * as bcryptjs from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction, Router } from 'express';
import { PrismaClient, ScopeType, UserStatus } from '@prisma/client';
import { PermissionService } from '../../../src/services/permission.service';
import { AppException } from '../../../src/types/exceptions';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

export function uid(): string {
  return crypto.randomUUID();
}

export interface Actor {
  id: string;
  token: string;
}

export interface ProvisionedTenant {
  tenantId: string;
  deptId: string;
  manage: Actor; // case-field:view + case-field:manage
  view: Actor;   // case-field:view only
  none: Actor;   // no case-field perms
}

export function makeApp(mounts: Array<[string, Router]>): express.Express {
  const app = express();
  app.use(express.json());
  for (const [path, r] of mounts) app.use(path, r);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });
  return app;
}

export async function startServer(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, baseUrl };
}

export function makeReq(baseUrl: string) {
  return async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let body: any;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
}

async function makeUser(prisma: PrismaClient, tenantId: string): Promise<{ id: string }> {
  const pwHash = await bcryptjs.hash('Password1!', 10);
  return prisma.user.create({
    data: { id: uid(), tenantId, email: `cf-${uid()}@test.invalid`, password: pwHash, status: UserStatus.ACTIVE },
    select: { id: true },
  });
}

async function makeSession(prisma: PrismaClient, userId: string, tenantId: string): Promise<string> {
  const sessionId = uid();
  await prisma.session.create({
    data: {
      id: sessionId, userId, tenantId, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 3_600_000),
      ipAddress: '127.0.0.1',
      refreshTokenHash: crypto.createHash('sha256').update(uid()).digest('hex'),
    },
  });
  return jwt.sign({ sessionId, userId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

async function permId(prisma: PrismaClient, slug: string): Promise<string> {
  const p = await prisma.permission.findFirst({ where: { slug } });
  if (!p) throw new Error(`Permission '${slug}' not seeded. Run seed-permissions.ts first.`);
  return p.id;
}

async function grant(prisma: PrismaClient, tenantId: string, permIds: string[]): Promise<Actor> {
  const user = await makeUser(prisma, tenantId);
  const role = await prisma.role.create({ data: { tenantId, name: `CFRole-${uid().slice(0, 8)}` } });
  if (permIds.length) {
    await prisma.rolePermission.createMany({ data: permIds.map((permissionId) => ({ roleId: role.id, permissionId })) });
  }
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: ScopeType.ORGANIZATION } });
  return { id: user.id, token: await makeSession(prisma, user.id, tenantId) };
}

export async function provisionTenant(
  prisma: PrismaClient,
  permissionService: PermissionService,
  opts: { engineEnabled: boolean },
): Promise<ProvisionedTenant> {
  const tenantId = uid();
  await prisma.tenant.create({ data: { id: tenantId, name: `CF-${tenantId.slice(0, 8)}` } });
  if (opts.engineEnabled) {
    await prisma.tenantSettings.create({ data: { tenantId, caseOperationsEngineEnabled: true } });
  }
  const dept = await prisma.department.create({ data: { tenantId, name: 'Documentation' }, select: { id: true } });

  const viewPerm = await permId(prisma, 'case-field:view');
  const managePerm = await permId(prisma, 'case-field:manage');

  const manage = await grant(prisma, tenantId, [viewPerm, managePerm]);
  const view = await grant(prisma, tenantId, [viewPerm]);
  const none = await grant(prisma, tenantId, []);

  await permissionService.invalidatePermissionCache(tenantId);
  return { tenantId, deptId: dept.id, manage, view, none };
}

export async function cleanupTenants(prisma: PrismaClient, tenantIds: string[]): Promise<void> {
  for (const tenantId of tenantIds) {
    // FK-safe order: rules -> options -> definitions -> department -> auth rows -> tenant.
    await prisma.caseFieldRule.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseFieldOption.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.caseFieldDefinition.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.department.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.session.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.userRole.deleteMany({ where: { user: { tenantId } } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }).catch(() => {});
    await prisma.role.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenantSettings.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
}
