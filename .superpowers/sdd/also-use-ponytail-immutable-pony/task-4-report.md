# Task 4 Report — Refactor all direct AuditLog writers to safe path

## Status
DONE_WITH_CONCERNS

## Commits
- `34dc711` — refactor: route all audit writes through AuditService.appendInTx
  - `src/routes/auth.router.ts`: registration (inline hash+create → `auditService.appendInTx`), login (random hash → `auditService.log`), email verify (random hash → `auditService.appendInTx`), invitation session (random hash → `auditService.log`)
  - `src/services/OrgInitService.ts`: removed inline `generateHash`/`createAuditLog` helpers and the 5 sequential manual-hash writes; replaced with 5 `auditSvc.appendInTx(tx, ...)` calls; removed the now-unused `crypto` import; added `import { AuditService } from './audit.service'`
  - `src/services/lead.service.ts`: MANUAL and AUTO bulk-assign paths — deleted the pre-transaction `auditLog.findFirst` TOCTOU pre-reads (and their explanatory/ponytail comments, since the TOCTOU is now closed by the advisory lock inside `appendInTx`), and switched `txAudit.log(input, previousHash)` (which no longer matched the Task 3 interface) to `txAudit.appendInTx(tx, input)`

## tsc result
`npx tsc --noEmit` — clean, 0 errors.

## grep result (auditLog.create locations)
```
H:\HPX Eigen Reborn\hpx-eigen-s1-foundation\src\services\audit.service.ts:92:    const record = await tx.auditLog.create({
```
Only hit is inside `audit.service.ts`, as required.

## Concerns
- **Pre-existing latent bug, out of scope for this task**: `src/services/lead.service.ts` has two other call sites (`LEAD_CREATED` at ~line 303 and `LEAD_UPDATED` at ~line 533) that do `const txAudit = new AuditService(tx as any); await txAudit.log({...})` — i.e. they construct `AuditService` with the **transaction client** but then call `.log()`, which internally does `(this.prisma as PrismaClient).$transaction(...)`. Since `tx` (a `Prisma.TransactionClient`) has no `$transaction` method, this will throw at runtime and get swallowed into `AuditWriteFailureError` on every lead create/update. These two sites were not listed in the Task 4 brief's file/line scope (brief only named 4 auth.router.ts writers + 1 OrgInitService + 2 lead.service.ts bulk-assign writers = 7 refactors), and they already satisfy the letter of both constraints (no direct `auditLog.create`, and they compile against the Task 3 interface), so I left them untouched rather than scope-creep. Recommend a follow-up task to change these two to `txAudit.appendInTx(tx, {...})` the same way the bulk-assign paths were just fixed.
- `opts.previousAuditHash` on `OrgInitService.initializeOrgRBACWithinTx` is now dead — `appendInTx` computes the chain leaf itself under an advisory lock, so the value passed in by `auth.router.ts` registration (`previousAuditHash: auditRecord.currentHash`) is accepted but no longer consulted. Left the parameter in place (per brief, which didn't ask to remove it from the signature) since removing it would be a public-signature change beyond the brief's scope; harmless no-op today.
