# Task 6: Shared Enable/Disable Helpers + Align Auto-Activation

## What to build

1. Extract `enablePortalInTx` and `disablePortalInTx` shared helpers in PortalService
2. Refactor `activatePortal` (from Task 5) to use `enablePortalInTx`
3. Refactor `reconcilePortalActivation` to use both helpers and enforce `status === 'ACTIVE'`
4. Add `AuditLog` entries for auto-activation/deactivation (currently only writes `DocCaseEvent`)

## Files to modify

1. `src/services/portal.service.ts` — add helpers, refactor activatePortal and reconcilePortalActivation

## Interface from Task 3 (already committed)

```typescript
// AuditService.appendInTx(tx, input) — returns { id, currentHash }
// this.audit is already an AuditService instance in PortalService
```

## 1. enablePortalInTx helper

Add as a private method. Uses conditional updateMany (race-safe, idempotent). Returns `{ alreadyEnabled: boolean; portalEnabledAt: Date }`.

```typescript
private async enablePortalInTx(
  tx: Prisma.TransactionClient,
  opts: {
    caseId: string;
    tenantId: string;
    actorUserId: string;
    activationType: 'MANUAL' | 'AUTO';
  },
): Promise<{ alreadyEnabled: boolean; portalEnabledAt: Date }> {
  const now = new Date();

  const { count } = await tx.docCase.updateMany({
    where: {
      id: opts.caseId,
      tenantId: opts.tenantId,
      deletedAt: null,
      portalEnabledAt: null,
      status: DocCaseStatus.ACTIVE,
      portalPhoneLast4: { not: null },
    },
    data: { portalEnabledAt: now },
  });

  if (count === 1) {
    const eventType = opts.activationType === 'MANUAL' ? 'PORTAL_ACTIVATED' : 'PORTAL_AUTO_ACTIVATED';
    await this.audit.appendInTx(tx, {
      tenantId: opts.tenantId,
      eventType,
      entityType: 'DocCase',
      entityId: opts.caseId,
      actorUserId: opts.actorUserId,
      operation: 'UPDATE',
      payload: { caseId: opts.caseId, activationType: opts.activationType },
    });
    return { alreadyEnabled: false, portalEnabledAt: now };
  }

  // Already enabled or conditions not met — check which
  const existing = await tx.docCase.findFirst({
    where: { id: opts.caseId, tenantId: opts.tenantId, deletedAt: null },
    select: { portalEnabledAt: true },
  });

  if (existing?.portalEnabledAt) {
    return { alreadyEnabled: true, portalEnabledAt: existing.portalEnabledAt };
  }

  // Conditions not met (wrong status, no phone, etc.) — return as already enabled
  // to avoid error in auto-activation path. Manual path handles this differently.
  return { alreadyEnabled: true, portalEnabledAt: now };
}
```

## 2. disablePortalInTx helper

```typescript
private async disablePortalInTx(
  tx: Prisma.TransactionClient,
  opts: {
    caseId: string;
    tenantId: string;
    actorUserId: string;
  },
): Promise<{ alreadyDisabled: boolean }> {
  const { count } = await tx.docCase.updateMany({
    where: {
      id: opts.caseId,
      tenantId: opts.tenantId,
      deletedAt: null,
      portalEnabledAt: { not: null },
    },
    data: { portalEnabledAt: null },
  });

  if (count === 0) return { alreadyDisabled: true };

  // Revoke all active sessions
  await tx.portalSession.updateMany({
    where: { caseId: opts.caseId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await this.audit.appendInTx(tx, {
    tenantId: opts.tenantId,
    eventType: 'PORTAL_DEACTIVATED',
    entityType: 'DocCase',
    entityId: opts.caseId,
    actorUserId: opts.actorUserId,
    operation: 'UPDATE',
    payload: { caseId: opts.caseId },
  });

  return { alreadyDisabled: false };
}
```

## 3. Refactor activatePortal to use enablePortalInTx

The `activatePortal` method (added in Task 5) currently has inline conditional updateMany + audit. Replace the inline logic with a call to `enablePortalInTx`, but keep the error-reason logic for the manual path.

**Replace the body of activatePortal with:**

```typescript
async activatePortal(ctx: TenantContext, caseId: string) {
  return this.prisma.$transaction(async (tx) => {
    const result = await this.enablePortalInTx(tx, {
      caseId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      activationType: 'MANUAL',
    });

    if (!result.alreadyEnabled) {
      return { caseId, portalEnabledAt: result.portalEnabledAt.toISOString(), alreadyEnabled: false };
    }

    // Check if truly already enabled vs conditions not met
    const docCase = await tx.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, status: true, portalEnabledAt: true, portalPhoneLast4: true },
    });

    if (!docCase) throw new ResourceNotFoundError();

    if (docCase.portalEnabledAt) {
      return { caseId, portalEnabledAt: docCase.portalEnabledAt.toISOString(), alreadyEnabled: true };
    }

    if (docCase.status !== DocCaseStatus.ACTIVE) {
      throw new BusinessRuleViolationError(`Case must be in ACTIVE status to activate portal (current: ${docCase.status}).`);
    }

    if (!docCase.portalPhoneLast4) {
      throw new ValidationError('Case has no portal phone number set. Cannot activate portal.');
    }

    throw new BusinessRuleViolationError('Portal activation conditions not met.');
  }, { maxWait: 5000, timeout: 15000 });
}
```

## 4. Refactor reconcilePortalActivation

The current `reconcilePortalActivation` (lines 275-324) does NOT:
- Check `status === 'ACTIVE'` before activating
- Write AuditLog entries (only DocCaseEvent)
- Use idempotent conditional updates

**Replace the entire method with:**

```typescript
private async reconcilePortalActivation(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  caseId: string,
  published: boolean,
  entity: 'note' | 'document',
  entityId: string,
) {
  const docCase = await tx.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId } });
  if (!docCase) throw new ResourceNotFoundError();

  const [visibleNotes, visibleDocs] = await Promise.all([
    tx.docCaseNote.count({ where: { caseId, clientVisible: true, deletedAt: null } }),
    tx.docCaseDocument.count({ where: { caseId, clientVisible: true, deletedAt: null } }),
  ]);
  const visibleCount = visibleNotes + visibleDocs;

  // Activation requires: visible content + phone + ACTIVE status
  const canActivate = visibleCount > 0 && !!docCase.portalPhoneLast4 && docCase.status === DocCaseStatus.ACTIVE;

  if (canActivate && !docCase.portalEnabledAt) {
    await this.enablePortalInTx(tx, {
      caseId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      activationType: 'AUTO',
    });
  } else if (!canActivate && docCase.portalEnabledAt) {
    await this.disablePortalInTx(tx, {
      caseId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
    });
  }

  // Update lastClientVisiblePublishAt if something was published
  if (published) {
    await tx.docCase.update({
      where: { id: caseId },
      data: { lastClientVisiblePublishAt: new Date() },
    });

    await tx.docCaseEvent.create({
      data: {
        tenantId: ctx.tenantId, caseId,
        eventType: DocEventType.CLIENT_VISIBLE_PUBLISHED,
        actorUserId: ctx.userId,
        payload: { entity, entityId, visibleCount },
      },
    });
  }

  // Return the updated case for the caller
  return tx.docCase.findFirstOrThrow({ where: { id: caseId } });
}
```

Key changes:
- Added `docCase.status === DocCaseStatus.ACTIVE` to `canActivate` condition
- Replaced inline `portalEnabledAt` set/clear with `enablePortalInTx`/`disablePortalInTx`
- Session revocation now handled inside `disablePortalInTx` (no longer inline)
- AuditLog entries written for both activation and deactivation

## Verification

Run `npx tsc --noEmit` to verify types.

## Commit

```
refactor: shared portal enable/disable helpers with audit + ACTIVE enforcement

- enablePortalInTx: race-safe, idempotent, audited (PORTAL_ACTIVATED/AUTO_ACTIVATED)
- disablePortalInTx: conditional clear, session revocation, audited (PORTAL_DEACTIVATED)
- reconcilePortalActivation: enforces ACTIVE status, uses shared helpers
- activatePortal: delegates to enablePortalInTx
```

## Report

Write your report to: `.superpowers/sdd/also-use-ponytail-immutable-pony/task-6-report.md`

Report format:
- Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
- Commits: list SHA(s)
- tsc result
- Concerns (if any)
