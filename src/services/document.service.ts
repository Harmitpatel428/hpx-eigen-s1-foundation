import {
  PrismaClient,
  DocumentCategory,
  DocumentStatus,
  DocumentSourceChannel,
  UploadedByParty,
  DocDocumentStatus,
  DocEventType,
  Prisma,
} from '@prisma/client';
import crypto from 'crypto';
import { AuditService } from './audit.service';
import { storageService } from './storage.service';
import { virusScanService } from './virus-scan.service';
import { logger } from '../utils/logger';
import {
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ConflictError,
  ValidationError,
  ScannerUnavailableError,
  InfectedFileError,
  AuthorizationError,
  AppException,
  RetryTag,
} from '../types/exceptions';
import {
  MANDATE_POLICY,
  sanitizeFileName,
  isAllowedContentType,
  matchesMagicBytes,
} from '../domain/mandate';
import { DocumentationService, type TenantContext } from './documentation.service';

/** A 409 Conflict carrying a specific, human-readable message (ConflictError is fixed-message). */
function conflict(message: string): AppException {
  return new AppException('CONFLICT', message, RetryTag.USER_ACTION_REQUIRED, 409);
}

// Document files reuse the mandate policy (5 MB; pdf/jpeg/png — the magic-byte
// gate covers exactly these three; broader types are deferred pending gate work).
const DOCUMENT_POLICY = MANDATE_POLICY;

// R4/E3: file-lifecycle status machine for the unified Document. Distinct from the
// requirement workflow (DocDocumentStatus). EXPIRED is manual-only; no background writer.
export const DOCUMENT_STATUS_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  UPLOADING:        ['SCANNING', 'RECEIVED', 'MALWARE_DETECTED'], // transient (not persisted in the sync pipeline)
  SCANNING:         ['RECEIVED', 'MALWARE_DETECTED'],
  RECEIVED:         ['UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'ARCHIVED'],
  UNDER_REVIEW:     ['VERIFIED', 'REJECTED', 'EXPIRED', 'ARCHIVED'],
  VERIFIED:         ['EXPIRED', 'ARCHIVED'],
  REJECTED:         [], // no in-place change; new version via replace only
  EXPIRED:          ['ARCHIVED'],
  ARCHIVED:         [],
  MALWARE_DETECTED: [], // never persisted (infected → reject, no row)
};

function docStagingKey(tenantId: string, caseId: string, uploadId: string, fileName: string): string {
  return `doc-staging/${tenantId}/${caseId}/${uploadId}/${sanitizeFileName(fileName)}`;
}
function docFinalKey(tenantId: string, caseId: string, documentId: string, fileName: string): string {
  return `doc-uploads/${tenantId}/${caseId}/${documentId}/${sanitizeFileName(fileName)}`;
}

type ConfirmInput = {
  uploadId: string;
  fileName: string;
  category: 'REQUIREMENT' | 'GENERAL';
  name?: string;
  requirementId?: string;
  sourceChannel: DocumentSourceChannel;
  internalNote?: string;
  clientVisible?: boolean;
  expiresAt?: Date | null;
  receivedAt?: Date | null;
  verify?: boolean;
  requirementStatus?: DocDocumentStatus;
};

type ReplaceInput = {
  uploadId: string;
  fileName: string;
  sourceChannel: DocumentSourceChannel;
  internalNote?: string;
  clientVisible?: boolean;
  verify?: boolean;
  name?: string;
  receivedAt?: Date | null;
  expiresAt?: Date | null;
};

export class DocumentService {
  private readonly audit: AuditService;
  private readonly docs: DocumentationService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
    this.docs = new DocumentationService(prisma);
  }

  // ─── presign ──────────────────────────────────────────────────────────────

  async uploadUrl(
    ctx: TenantContext,
    caseId: string,
    fileInfo: { fileName: string; contentType: string; fileSizeBytes: number },
  ) {
    await this.assertCaseExists(caseId, ctx.tenantId);
    if (!isAllowedContentType(fileInfo.contentType)) {
      throw new ValidationError(`File type ${fileInfo.contentType} is not accepted. Allowed: ${DOCUMENT_POLICY.ALLOWED_CONTENT_TYPES.join(', ')}`);
    }
    if (fileInfo.fileSizeBytes > DOCUMENT_POLICY.MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(`File size exceeds the ${DOCUMENT_POLICY.MAX_FILE_SIZE_BYTES} byte limit.`);
    }
    const uploadId = crypto.randomUUID();
    const stagingKey = docStagingKey(ctx.tenantId, caseId, uploadId, fileInfo.fileName);
    const { url, expiresAt } = await storageService.generateUploadUrl(
      stagingKey, fileInfo.contentType, fileInfo.fileSizeBytes, DOCUMENT_POLICY.PRESIGNED_URL_SECONDS,
    );
    return { uploadUrl: url, uploadId, expiresAt };
  }

  // ─── confirm ──────────────────────────────────────────────────────────────

  async confirmUpload(ctx: TenantContext, caseId: string, input: ConfirmInput, canVerify: boolean) {
    // B1.2 replay (first-wins)
    const replay = await this.prisma.document.findFirst({
      where: { uploadId: input.uploadId, tenantId: ctx.tenantId },
      select: { id: true, status: true },
    });
    if (replay) return { documentId: replay.id, status: replay.status };

    const safeName = sanitizeFileName(input.fileName);
    const stagingKey = docStagingKey(ctx.tenantId, caseId, input.uploadId, safeName);

    // G4/G2: verify gate — after replay, before object gates. On reject, drop the staged
    // object so a permission failure does not leave an orphan (symmetry with the mandate path).
    if (input.verify === true && !canVerify) {
      await storageService.deleteObject(stagingKey).catch(() => {});
      throw new AuthorizationError();
    }

    await this.assertCaseExists(caseId, ctx.tenantId);
    const { bytes, head } = await this.gateStagedObject(stagingKey, { caseId, uploadId: input.uploadId });
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');

    // Resolve the requirement (case-scoped, E2) and its default name up-front.
    let resolvedName = input.name?.trim();
    if (input.category === 'REQUIREMENT') {
      if (!input.requirementId) throw new ValidationError('requirementId is required for a REQUIREMENT document.');
      const requirement = await this.prisma.docCaseDocument.findFirst({
        where: { id: input.requirementId, tenantId: ctx.tenantId, caseId, deletedAt: null },
        select: { name: true },
      });
      if (!requirement) throw new ResourceNotFoundError();
      if (!resolvedName) resolvedName = requirement.name;
    }
    if (!resolvedName) throw new ValidationError('name is required for a GENERAL document.');

    const willVerify = input.verify === true && canVerify;
    const status: DocumentStatus = willVerify ? DocumentStatus.VERIFIED : DocumentStatus.RECEIVED;
    // I1: effective clientVisible default — REQUIREMENT true, GENERAL false; explicit wins.
    const clientVisible = input.clientVisible ?? (input.category === 'REQUIREMENT');

    const documentId = crypto.randomUUID();
    const finalKey = docFinalKey(ctx.tenantId, caseId, documentId, safeName);
    await storageService.copyObject(stagingKey, finalKey);
    await storageService.deleteObject(stagingKey);

    const now = new Date();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // B1.3 case lock
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "DocCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) throw new ResourceNotFoundError();

        const doc = await tx.document.create({
          data: {
            id: documentId,
            tenantId: ctx.tenantId,
            caseId,
            requirementId: input.category === 'REQUIREMENT' ? input.requirementId! : null,
            uploadId: input.uploadId,
            category: input.category as DocumentCategory,
            name: resolvedName!,
            originalFilename: input.fileName,
            storageKey: finalKey,
            mimeType: head.contentType!,
            sizeBytes: head.contentLength!,
            checksum,
            status,
            sourceChannel: input.sourceChannel,
            uploadedByParty: UploadedByParty.FIRM,
            uploadedByUserId: ctx.userId,
            internalNote: input.internalNote ?? null,
            clientVisible,
            receivedAt: input.receivedAt ?? now,
            verifiedAt: willVerify ? now : null,
            verifiedByUserId: willVerify ? ctx.userId : null,
            expiresAt: input.expiresAt ?? null,
          },
        });

        // Requirement status effect (I3/I6). verify → APPROVED; else requirementStatus; else RECEIVED.
        if (input.category === 'REQUIREMENT' && input.requirementId) {
          const target: DocDocumentStatus = input.requirementStatus
            ?? (willVerify ? DocDocumentStatus.APPROVED : DocDocumentStatus.RECEIVED);
          const outcome = await this.docs.transitionRequirementInTx(tx, ctx, input.requirementId, target);
          if (outcome === 'unreachable') {
            await tx.docCaseEvent.create({
              data: {
                tenantId: ctx.tenantId, caseId, eventType: DocEventType.DOCUMENT_STATUS_CHANGED,
                actorUserId: ctx.userId,
                payload: { fileId: documentId, divergence: true, note: `file attached; requirement status left unchanged (no valid transition to ${target})`, requirementId: input.requirementId, target } as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }

        await tx.docCaseEvent.create({
          data: {
            tenantId: ctx.tenantId, caseId, eventType: DocEventType.DOCUMENT_UPLOADED, actorUserId: ctx.userId,
            payload: { fileId: documentId, category: input.category, name: resolvedName, sourceChannel: input.sourceChannel, verified: willVerify, requirementId: input.requirementId ?? null } as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId, actorUserId: ctx.userId,
          eventType: 'DOCUMENT_UPLOADED', entityType: 'Document', entityId: documentId, operation: 'CREATE',
          payload: { category: input.category, sourceChannel: input.sourceChannel, verified: willVerify, caseId, requirementId: input.requirementId ?? null },
        });

        return doc;
      });
      return { documentId: created.id, status: created.status };
    } catch (err) {
      // B1.2 backstop: concurrent confirm won this uploadId.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | string | undefined) ?? '';
        const isUploadIdClash = Array.isArray(target) ? target.includes('uploadId') : String(target).includes('uploadId');
        if (isUploadIdClash) {
          const won = await this.prisma.document.findFirst({
            where: { uploadId: input.uploadId, tenantId: ctx.tenantId }, select: { id: true, status: true },
          });
          if (won) return { documentId: won.id, status: won.status };
        }
        // B1.4: an active REQUIREMENT document already exists.
        logger.warn({ caseId, uploadId: input.uploadId, requirementId: input.requirementId ?? null, reason: 'duplicate_active_requirement', code: 409 }, 'Document upload rejected: active requirement document already exists');
        throw conflict('An active document already exists for this requirement; replace it instead.');
      }
      throw err;
    }
  }

  // ─── view-url ─────────────────────────────────────────────────────────────

  /** E6: inactive/replaced docs stay viewable for history; soft-deleted → 404. */
  async getViewUrl(ctx: TenantContext, documentId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
      select: { storageKey: true, name: true, mimeType: true, sizeBytes: true },
    });
    if (!doc) throw new ResourceNotFoundError();
    const { url, expiresAt } = await storageService.generateViewUrl(doc.storageKey, DOCUMENT_POLICY.PRESIGNED_URL_SECONDS);
    // storageKey deliberately omitted (R5).
    return { viewUrl: url, fileName: doc.name, contentType: doc.mimeType, sizeBytes: doc.sizeBytes, expiresAt };
  }

  // ─── status PATCH (G1) ──────────────────────────────────────────────────────

  async updateStatus(
    ctx: TenantContext,
    documentId: string,
    input: { status: DocumentStatus; rejectionReason?: string },
    canVerify: boolean,
  ) {
    if (input.status === DocumentStatus.VERIFIED && !canVerify) throw new AuthorizationError();
    if (input.status === DocumentStatus.REJECTED && !input.rejectionReason?.trim()) {
      throw new ValidationError('rejectionReason is required when rejecting a document.');
    }
    return this.prisma.$transaction(async (tx) => {
      // B1.3 case lock (via the document's case)
      const doc = await tx.document.findFirst({
        where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, caseId: true, status: true, isActive: true },
      });
      if (!doc) throw new ResourceNotFoundError();
      await tx.$queryRaw`SELECT id FROM "DocCase" WHERE id = ${doc.caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      // Re-read fresh under the lock.
      const fresh = await tx.document.findFirst({ where: { id: documentId }, select: { status: true, isActive: true, verifiedAt: true } });
      if (!fresh) throw new ResourceNotFoundError();
      if (!fresh.isActive) throw conflict('Document has been replaced; act on the current version.');

      const allowed = DOCUMENT_STATUS_TRANSITIONS[fresh.status];
      if (!allowed.includes(input.status)) {
        logger.warn({ documentId, tenantId: ctx.tenantId, from: fresh.status, to: input.status, reason: 'invalid_transition', code: 422 }, 'Document status change rejected: invalid transition');
        throw new BusinessRuleViolationError(`Invalid status transition ${fresh.status} → ${input.status}. Allowed: ${allowed.join(', ') || '(none)'}`);
      }

      const now = new Date();
      // E3: lifecycle-timestamp symmetry.
      const data: Prisma.DocumentUpdateInput = { status: input.status };
      if (input.status === DocumentStatus.VERIFIED) { data.verifiedAt = now; data.verifiedByUserId = ctx.userId; }
      if (input.status === DocumentStatus.REJECTED || input.status === DocumentStatus.EXPIRED) {
        if (fresh.status === DocumentStatus.VERIFIED) { data.verifiedAt = null; data.verifiedByUserId = null; }
      }
      if (input.status === DocumentStatus.REJECTED) { data.rejectedAt = now; data.rejectedByUserId = ctx.userId; data.rejectionReason = input.rejectionReason!.trim(); }

      const updated = await tx.document.update({ where: { id: documentId }, data, select: { id: true, status: true } });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: doc.caseId, eventType: DocEventType.DOCUMENT_STATUS_CHANGED,
          actorUserId: ctx.userId, payload: { fileId: documentId, fromStatus: fresh.status, toStatus: input.status } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOCUMENT_STATUS_CHANGED', entityType: 'Document', entityId: documentId, operation: 'UPDATE',
        payload: { fromStatus: fresh.status, toStatus: input.status },
        beforeState: { status: fresh.status }, afterState: { status: input.status },
      });
      return { documentId: updated.id, status: updated.status };
    });
  }

  // ─── replace (R3) ─────────────────────────────────────────────────────────

  async replace(ctx: TenantContext, documentId: string, input: ReplaceInput, canVerify: boolean) {
    // B1.2 replay
    const replay = await this.prisma.document.findFirst({
      where: { uploadId: input.uploadId, tenantId: ctx.tenantId }, select: { id: true, status: true, versionOfId: true },
    });
    if (replay) return { documentId: replay.id, versionOfId: replay.versionOfId, status: replay.status };

    if (input.verify === true && !canVerify) throw new AuthorizationError();

    const target = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null },
      select: {
        id: true, caseId: true, category: true, requirementId: true, name: true, clientVisible: true, isActive: true,
      },
    });
    if (!target) throw new ResourceNotFoundError();

    const safeName = sanitizeFileName(input.fileName);
    // stage/confirm reuse: the client PUTs to a fresh doc-staging key under the same case.
    const stagingKey = docStagingKey(ctx.tenantId, target.caseId, input.uploadId, safeName);
    const { bytes, head } = await this.gateStagedObject(stagingKey, { caseId: target.caseId, uploadId: input.uploadId });
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');

    const willVerify = input.verify === true && canVerify;
    const status: DocumentStatus = willVerify ? DocumentStatus.VERIFIED : DocumentStatus.RECEIVED;
    const newId = crypto.randomUUID();
    const finalKey = docFinalKey(ctx.tenantId, target.caseId, newId, safeName);
    await storageService.copyObject(stagingKey, finalKey);
    await storageService.deleteObject(stagingKey);

    const now = new Date();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DocCase" WHERE id = ${target.caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
        // Re-read target under the lock; must still be active.
        const fresh = await tx.document.findFirst({ where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null }, select: { isActive: true } });
        if (!fresh) throw new ResourceNotFoundError();
        if (!fresh.isActive) throw conflict('Document has already been replaced.');

        // Deactivate old BEFORE inserting the new (keeps the active-requirement partial index satisfied).
        await tx.document.update({ where: { id: documentId }, data: { isActive: false } });

        const doc = await tx.document.create({
          data: {
            id: newId,
            tenantId: ctx.tenantId,
            caseId: target.caseId,
            requirementId: target.requirementId,
            uploadId: input.uploadId,
            category: target.category,
            name: input.name?.trim() || target.name,
            originalFilename: input.fileName,
            storageKey: finalKey,
            mimeType: head.contentType!,
            sizeBytes: head.contentLength!,
            checksum,
            status,
            sourceChannel: input.sourceChannel,
            uploadedByParty: UploadedByParty.FIRM,
            uploadedByUserId: ctx.userId,
            internalNote: input.internalNote ?? null,
            clientVisible: input.clientVisible ?? target.clientVisible,
            versionOfId: documentId,
            receivedAt: input.receivedAt ?? now,
            verifiedAt: willVerify ? now : null,
            verifiedByUserId: willVerify ? ctx.userId : null,
            expiresAt: input.expiresAt ?? null,
          },
        });

        if (target.category === 'REQUIREMENT' && target.requirementId) {
          const targetStatus: DocDocumentStatus = willVerify ? DocDocumentStatus.APPROVED : DocDocumentStatus.RECEIVED;
          const outcome = await this.docs.transitionRequirementInTx(tx, ctx, target.requirementId, targetStatus);
          if (outcome === 'unreachable') {
            await tx.docCaseEvent.create({
              data: {
                tenantId: ctx.tenantId, caseId: target.caseId, eventType: DocEventType.DOCUMENT_STATUS_CHANGED,
                actorUserId: ctx.userId,
                payload: { fileId: newId, divergence: true, note: `replacement attached; requirement status left unchanged (no valid transition to ${targetStatus})`, requirementId: target.requirementId, target: targetStatus } as unknown as Prisma.InputJsonValue,
              },
            });
          }
        }

        await tx.docCaseEvent.create({
          data: {
            tenantId: ctx.tenantId, caseId: target.caseId, eventType: DocEventType.DOCUMENT_REPLACED, actorUserId: ctx.userId,
            payload: { fileId: newId, oldId: documentId, newId, sourceChannel: input.sourceChannel } as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId, actorUserId: ctx.userId,
          eventType: 'DOCUMENT_REPLACED', entityType: 'Document', entityId: newId, operation: 'CREATE',
          payload: { oldId: documentId, newId, caseId: target.caseId },
        });
        return doc;
      });
      return { documentId: created.id, versionOfId: documentId, status: created.status };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const won = await this.prisma.document.findFirst({
          where: { uploadId: input.uploadId, tenantId: ctx.tenantId }, select: { id: true, status: true, versionOfId: true },
        });
        if (won) return { documentId: won.id, versionOfId: won.versionOfId, status: won.status };
        throw conflict('An active document already exists for this requirement; replace it instead.');
      }
      throw err;
    }
  }

  // ─── soft delete (G1) ───────────────────────────────────────────────────────

  async softDelete(ctx: TenantContext, documentId: string) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.findFirst({
        where: { id: documentId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true, caseId: true },
      });
      if (!doc) throw new ResourceNotFoundError();
      await tx.$queryRaw`SELECT id FROM "DocCase" WHERE id = ${doc.caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      await tx.document.update({ where: { id: documentId }, data: { deletedAt: new Date(), isActive: false } });
      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: doc.caseId, eventType: DocEventType.DOCUMENT_REMOVED, actorUserId: ctx.userId,
          payload: { fileId: documentId } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, actorUserId: ctx.userId,
        eventType: 'DOCUMENT_REMOVED', entityType: 'Document', entityId: documentId, operation: 'DELETE',
        payload: { caseId: doc.caseId },
      });
      return { documentId, deleted: true };
    });
  }

  // ─── shared gates ───────────────────────────────────────────────────────────

  private async assertCaseExists(caseId: string, tenantId: string): Promise<void> {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId, deletedAt: null }, select: { id: true },
    });
    if (!docCase) throw new ResourceNotFoundError();
  }

  /**
   * headObject re-check → magic bytes → virus scan. Deletes staging on reject (I7/G2).
   * M4: every rejection emits a structured log keyed by uploadId+caseId (never the
   * presigned URL or storage key alone) so ops can trace a rejected upload.
   */
  private async gateStagedObject(
    stagingKey: string,
    ctx: { caseId: string; uploadId: string },
  ): Promise<{ bytes: Buffer; head: { exists: boolean; contentLength?: number; contentType?: string } }> {
    const head = await storageService.headObject(stagingKey);
    if (!head.exists) {
      logger.warn({ ...ctx, reason: 'staging_missing', code: 409 }, 'Document upload rejected: staging object missing');
      throw new ConflictError();
    }
    if (head.contentLength! > DOCUMENT_POLICY.MAX_FILE_SIZE_BYTES) {
      await storageService.deleteObject(stagingKey);
      logger.warn({ ...ctx, reason: 'oversize', code: 400, sizeBytes: head.contentLength }, 'Document upload rejected: oversize');
      throw new ValidationError('Uploaded file exceeds the size limit.');
    }
    if (!isAllowedContentType(head.contentType!)) {
      await storageService.deleteObject(stagingKey);
      logger.warn({ ...ctx, reason: 'content_type', code: 400 }, 'Document upload rejected: content type not accepted');
      throw new ValidationError('Uploaded file type is not accepted.');
    }
    const bytes = await storageService.getObjectBytes(stagingKey);
    if (!matchesMagicBytes(head.contentType!, bytes)) {
      await storageService.deleteObject(stagingKey);
      logger.warn({ ...ctx, reason: 'magic_byte', code: 400 }, 'Document upload rejected: magic-byte mismatch');
      throw new ValidationError('Uploaded file content does not match its declared type.');
    }
    let scan;
    try {
      scan = await virusScanService.scanOrBypass(bytes);
    } catch {
      throw new ScannerUnavailableError(); // leave staging for retry
    }
    if (scan.isInfected) {
      try { await storageService.deleteObject(stagingKey); }
      catch (err) { logger.error({ err, ...ctx }, 'Failed to delete infected document staging object'); }
      // M4 infected>0 alert hook: error-level + `alert` field is the greppable marker
      // ops alerting keys on. Signature stays server-side only (never client/audit/event).
      // ponytail: log-based alert, wire a pager rule to `alert:'VIRUS_DETECTED'` if paging is needed.
      logger.error({ alert: 'VIRUS_DETECTED', ...ctx, reason: 'infected', code: 422, signature: scan.signature }, 'Document upload rejected by virus scanner (FOUND)');
      throw new InfectedFileError();
    }
    return { bytes, head };
  }
}
