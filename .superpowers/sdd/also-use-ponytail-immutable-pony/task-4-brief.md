# Task 4: Refactor All 8 Direct AuditLog Writers to Safe Path

## What to build

Refactor every direct `auditLog.create` call and every `previousHashOverride` usage to go through the AuditService safe path (`appendInTx` or `log`). After this task, NO code outside `audit.service.ts` should call `auditLog.create` directly.

## Files to modify

1. `src/routes/auth.router.ts` — 4 writers (registration, login, email verify, invitation)
2. `src/services/OrgInitService.ts` — 1 writer (inline createAuditLog helper)
3. `src/services/lead.service.ts` — 2 callers using `previousHashOverride`

## Interface from Task 3 (already committed)

```typescript
// From src/services/audit.service.ts:
export class AuditService {
  constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}
  async appendInTx(tx: Prisma.TransactionClient, input: AuditAppendInput): Promise<{ id: string; currentHash: string }>;
  async log(input: AuditAppendInput): Promise<void>;
}

export interface AuditAppendInput {
  tenantId: string; eventType: string; entityType: string; entityId: string;
  actorUserId?: string; actorIp?: string; actorUserAgent?: string;
  operation: string; payload: Record<string, unknown>;
  beforeState?: Record<string, unknown> | null; afterState?: Record<string, unknown> | null;
}
```

## Refactor #1: auth.router.ts — Registration (lines 89-121)

The registration handler is inside a `prisma.$transaction(async (tx) => { ... })` that already holds an advisory lock on the email.

**Current code (lines 89-121):**
```typescript
const lastAudit = await tx.auditLog.findFirst({
  orderBy: { createdAt: 'desc' },
  select: { currentHash: true },
});
const previousHash = lastAudit?.currentHash ?? null;
const currentHash = crypto.createHash('sha256')
  .update(JSON.stringify({ eventType: 'USER_REGISTERED', ... }) + (previousHash || ''))
  .digest('hex');
await tx.auditLog.create({ data: { ... previousHash, currentHash } });
await orgInitService.initializeOrgRBACWithinTx(tx, tenant.id, user.id, {
  previousAuditHash: currentHash,
});
```

**Replace with:**
```typescript
const auditRecord = await auditService.appendInTx(tx, {
  tenantId: tenant.id,
  eventType: 'USER_REGISTERED',
  entityType: 'User',
  entityId: user.id,
  actorUserId: user.id,
  operation: 'CREATE',
  payload: { email, emailVerified: false },
});
await orgInitService.initializeOrgRBACWithinTx(tx, tenant.id, user.id, {
  previousAuditHash: auditRecord.currentHash,
});
```

The `auditService` is already instantiated at the top of `createAuthRouter` (line 27): `const auditService = new AuditService(prisma);`

## Refactor #2: auth.router.ts — Login (lines 233-244)

**Current code:**
```typescript
await prisma.auditLog.create({
  data: {
    tenantId: user.tenantId, eventType: 'USER_LOGIN', entityType: 'Session',
    entityId: session.id, actorUserId: user.id, operation: 'CREATE',
    payload: { sessionId: session.id },
    currentHash: crypto.randomBytes(32).toString('hex')
  }
});
```

**Replace with:**
```typescript
await auditService.log({
  tenantId: user.tenantId,
  eventType: 'USER_LOGIN',
  entityType: 'Session',
  entityId: session.id,
  actorUserId: user.id,
  operation: 'CREATE',
  payload: { sessionId: session.id },
});
```

No outer transaction needed — `log()` creates its own.

## Refactor #3: auth.router.ts — Email Verify (lines 347-359)

This is inside a `prisma.$transaction(async (tx) => { ... })`.

**Current code:**
```typescript
await tx.auditLog.create({
  data: {
    tenantId: user.tenantId, eventType: 'EMAIL_VERIFIED', entityType: 'User',
    entityId: user.id, actorUserId: user.id, operation: 'UPDATE',
    payload: { email: user.email },
    currentHash: crypto.randomBytes(32).toString('hex')
  }
});
```

**Replace with:**
```typescript
await auditService.appendInTx(tx, {
  tenantId: user.tenantId,
  eventType: 'EMAIL_VERIFIED',
  entityType: 'User',
  entityId: user.id,
  actorUserId: user.id,
  operation: 'UPDATE',
  payload: { email: user.email },
});
```

## Refactor #4: auth.router.ts — Invitation Session (lines 812-823)

**Current code:**
```typescript
await prisma.auditLog.create({
  data: {
    tenantId, eventType: 'INVITATION_SESSION_CREATED', entityType: 'Session',
    entityId: session.id, actorUserId: userId, operation: 'CREATE',
    payload: { invitationId, sessionId: session.id },
    currentHash: crypto.randomBytes(32).toString('hex')
  }
});
```

**Replace with:**
```typescript
await auditService.log({
  tenantId,
  eventType: 'INVITATION_SESSION_CREATED',
  entityType: 'Session',
  entityId: session.id,
  actorUserId: userId,
  operation: 'CREATE',
  payload: { invitationId, sessionId: session.id },
});
```

## Refactor #5: OrgInitService.ts (lines 111-169)

The entire inline `generateHash` + `createAuditLog` helper and 5 sequential audit writes must be replaced with `appendInTx` calls.

**Current code (lines 111-168):**
The function defines `generateHash()` and `createAuditLog()` inline, then chains 5 audit entries manually.

**Replace the entire block (lines 111-168) with:**
```typescript
const auditSvc = new AuditService(tx as any);

const audit1 = await auditSvc.appendInTx(tx, {
  tenantId, eventType: 'department_created', entityType: 'Department',
  entityId: department.id, actorUserId: userId,
  actorIp: '0.0.0.0', actorUserAgent: 'hpx-eigen-api',
  operation: 'CREATE', payload: { name: departmentName },
});

const audit2 = await auditSvc.appendInTx(tx, {
  tenantId, eventType: 'team_created', entityType: 'Team',
  entityId: team.id, actorUserId: userId,
  actorIp: '0.0.0.0', actorUserAgent: 'hpx-eigen-api',
  operation: 'CREATE', payload: { name: teamName, departmentId: department.id },
});

const audit3 = await auditSvc.appendInTx(tx, {
  tenantId, eventType: 'role_created', entityType: 'Role',
  entityId: role.id, actorUserId: userId,
  actorIp: '0.0.0.0', actorUserAgent: 'hpx-eigen-api',
  operation: 'CREATE', payload: { name: DEFAULT_ADMIN_ROLE_NAME, level: 'ORGANIZATION' },
});

const audit4 = await auditSvc.appendInTx(tx, {
  tenantId, eventType: 'role_assigned', entityType: 'UserRole',
  entityId: `${userId}_${role.id}`, actorUserId: userId,
  actorIp: '0.0.0.0', actorUserAgent: 'hpx-eigen-api',
  operation: 'CREATE', payload: { userId, roleId: role.id, scopeType: 'ORGANIZATION' },
});

const audit5 = await auditSvc.appendInTx(tx, {
  tenantId, eventType: 'permissions_initialized', entityType: 'Permission',
  entityId: role.id, actorUserId: userId,
  actorIp: '0.0.0.0', actorUserAgent: 'hpx-eigen-api',
  operation: 'CREATE', payload: { roleId: role.id, permissionCount: allPermissions.length },
});
```

**Also update the return value (line 164-169):**
```typescript
return {
  departmentId: department.id,
  teamId: team.id,
  roleId: role.id,
  lastAuditHash: audit5.currentHash,
};
```

**Add import at the top of OrgInitService.ts:**
```typescript
import { AuditService } from './audit.service';
```

**Remove the `crypto` import** since it's no longer needed (the inline hash function is gone).

## Refactor #6 & #7: lead.service.ts — MANUAL (line 1076) and AUTO (line 1150)

Both paths pre-read the audit hash OUTSIDE the transaction (TOCTOU race) and pass it via `previousHashOverride`.

**MANUAL path — remove pre-read (lines 1035-1040) and refactor audit call (lines 1075-1084):**

Delete the pre-read block:
```typescript
const prevAuditRecord = await this.prisma.auditLog.findFirst({ ... });
const previousAuditHash = prevAuditRecord?.currentHash ?? null;
```

Replace the audit call inside the transaction:
```typescript
// OLD:
const txAudit = new AuditService(tx as any);
await txAudit.log({
  ...
}, previousAuditHash);

// NEW:
const txAudit = new AuditService(tx as any);
await txAudit.appendInTx(tx, {
  tenantId: ctx.tenantId,
  eventType: 'LEADS_BULK_ASSIGNED',
  entityType: 'Lead',
  entityId: `bulk:${count}`,
  actorUserId: ctx.userId,
  operation: 'UPDATE',
  payload: { mode: 'MANUAL', targetUserId: input.userId, count },
});
```

**AUTO path — same pattern. Remove pre-read (lines 1110-1115) and refactor (lines 1149-1158):**

Delete the pre-read block. Replace:
```typescript
const txAudit = new AuditService(tx as any);
await txAudit.appendInTx(tx, {
  tenantId: ctx.tenantId,
  eventType: 'LEADS_BULK_ASSIGNED',
  entityType: 'Lead',
  entityId: `bulk:${count}`,
  actorUserId: ctx.userId,
  operation: 'UPDATE',
  payload: { mode: 'AUTO', departmentId: input.departmentId, count },
});
```

Note: the `ponytail:` TOCTOU comments above the pre-read blocks can be deleted — the TOCTOU is now fixed by the advisory lock inside `appendInTx`.

## Verification

Run `npx tsc --noEmit` — this verifies all callers match the new interface.

Run `grep -rn "auditLog.create" src/` — should return ONLY hits in `src/services/audit.service.ts`.

## Commit

```
refactor: route all audit writes through AuditService.appendInTx

- Registration: inline hash+create → appendInTx
- Login, email verify, invitation: random hash → auditService.log
- OrgInitService: inline generateHash/createAuditLog → appendInTx
- Lead assignment: remove TOCTOU pre-read, use appendInTx inside tx
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-4-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- tsc result
- grep result (auditLog.create locations)
- Concerns (if any)
