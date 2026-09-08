# Task 5: Portal Activate Endpoint + Permission Migration

## What to build

1. A permission seed migration for `portal:activate`
2. A new `POST /:caseId/portal/activate` route in the cases router
3. An `activatePortal()` method in PortalService using race-safe conditional updateMany

## Files to create/modify

1. **Create:** `prisma/migrations/20260908030000_seed_portal_activate_permission/migration.sql`
2. **Modify:** `src/routes/handoff.router.ts` — add route in `createCasesRouter`
3. **Modify:** `src/services/portal.service.ts` — add `activatePortal` method

## 1. Permission Migration

```sql
INSERT INTO "Permission" ("id", "slug", "module", "description")
VALUES (gen_random_uuid(), 'portal:activate', 'Client Portal', 'Activate client portal access for a DocCase')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" = 'Organization Admin'
  AND p."slug" = 'portal:activate'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
```

## 2. Route in handoff.router.ts

Add after the `portal-sessions/revoke` route (after line 122), before `return router`:

```typescript
/** POST /api/v1/cases/:caseId/portal/activate */
router.post('/:caseId/portal/activate', authMiddleware, permissionMiddleware('portal:activate'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, userId } = (req as AuthenticatedRequest).user;
      const caseId = req.params.caseId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) {
        throw new ValidationError('Invalid caseId format.');
      }
      res.json({ success: true, data: await portal.activatePortal({ tenantId, userId }, caseId) });
    } catch (err) { next(err); }
  });
```

You need to add `permissionMiddleware` to the imports at the top of the file. The existing imports are:
```typescript
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
```
Check if `permissionMiddleware` is already imported — it is (line 3). Good.

## 3. PortalService.activatePortal method

Add this method to the `PortalService` class. Place it after the `revokeSessions` method and before the `reconcilePortalActivation` method.

The method uses a race-safe conditional `updateMany` pattern (Amendment 5): instead of read-then-check-then-update (TOCTOU), it updates only if ALL conditions are met in a single atomic statement. If count=0, it reads the case to determine the specific rejection reason.

```typescript
async activatePortal(ctx: TenantContext, caseId: string) {
  return this.prisma.$transaction(async (tx) => {
    const now = new Date();

    // Race-safe: conditional update succeeds only if ALL activation invariants hold.
    // If another request already set portalEnabledAt, count will be 0 (idempotent).
    const { count } = await tx.docCase.updateMany({
      where: {
        id: caseId,
        tenantId: ctx.tenantId,
        deletedAt: null,
        portalEnabledAt: null,
        status: DocCaseStatus.ACTIVE,
        portalPhoneLast4: { not: null },
      },
      data: { portalEnabledAt: now },
    });

    if (count === 1) {
      // Activation succeeded — audit it
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId,
        eventType: 'PORTAL_ACTIVATED',
        entityType: 'DocCase',
        entityId: caseId,
        actorUserId: ctx.userId,
        operation: 'UPDATE',
        payload: { caseId, activationType: 'MANUAL' },
      });

      return { caseId, portalEnabledAt: now.toISOString(), alreadyEnabled: false };
    }

    // count === 0 — determine why
    const docCase = await tx.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, status: true, portalEnabledAt: true, portalPhoneLast4: true },
    });

    if (!docCase) throw new ResourceNotFoundError();

    // Already enabled — idempotent success, no duplicate audit
    if (docCase.portalEnabledAt) {
      return { caseId, portalEnabledAt: docCase.portalEnabledAt.toISOString(), alreadyEnabled: true };
    }

    // Wrong status
    if (docCase.status !== DocCaseStatus.ACTIVE) {
      throw new BusinessRuleViolationError(`Case must be in ACTIVE status to activate portal (current: ${docCase.status}).`);
    }

    // No phone
    if (!docCase.portalPhoneLast4) {
      throw new ValidationError('Case has no portal phone number set. Cannot activate portal.');
    }

    // Should not reach here, but fail safe
    throw new BusinessRuleViolationError('Portal activation conditions not met.');
  }, { maxWait: 5000, timeout: 15000 });
}
```

**CRITICAL:** The response does NOT include `portalPhoneSnapshot`. The audit metadata includes `portalPhoneLast4` — but wait, the plan says "Do not log full phone numbers in audit metadata." `portalPhoneLast4` is only 4 digits, not a full number. It's acceptable to include in audit metadata. However, do NOT include it in the API response either — just `caseId`, `portalEnabledAt`, and `alreadyEnabled`.

Actually, looking at this more carefully: the audit payload should NOT include portalPhoneLast4. Keep audit metadata to `{ caseId, activationType: 'MANUAL' }` only.

## Important: AuditService import change

The `PortalService` already imports and constructs `AuditService` at lines 9 and 52-55:
```typescript
import { AuditService } from './audit.service';
// ...
constructor(private readonly prisma: PrismaClient) {
  this.audit = new AuditService(prisma);
}
```

The `appendInTx` method is called via `this.audit.appendInTx(tx, ...)`. This works because `AuditService` constructor now accepts `PrismaClient | Prisma.TransactionClient`, and `appendInTx` takes the tx explicitly.

## Verification

Run `npx tsc --noEmit` to verify types.

## Commit

```
feat: add POST /cases/:caseId/portal/activate endpoint

- Race-safe conditional updateMany activation
- Idempotent (returns alreadyEnabled:true if already set)
- Audit PORTAL_ACTIVATED event via appendInTx
- Permission: portal:activate seeded for Organization Admin
- Enforces: ACTIVE status + portalPhoneLast4 + not deleted
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-5-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- tsc result
- Concerns (if any)
