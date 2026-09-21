import {
  PrismaClient,
  MandateRequestStatus,
  DocEventType,
  DocCaseStatus,
  NotificationType,
  UploadedByParty,
  DocumentSourceChannel,
  Prisma,
} from '@prisma/client';
import crypto from 'crypto';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import { emailService } from './email.service';
import { storageService } from './storage.service';
import { virusScanService } from './virus-scan.service';
import { logger } from '../utils/logger';
import { checkMandateUploadAttempts } from './auth/RateLimitService';
import {
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ConflictError,
  ValidationError,
  ScannerUnavailableError,
  InfectedFileError,
  CaseClosedError,
  AuthorizationError,
} from '../types/exceptions';
import {
  MANDATE_POLICY,
  generateUploadToken,
  hashUploadToken,
  tokenExpiry,
  isTokenExpired,
  sanitizeFileName,
  mandateStagingKey,
  mandateFinalKey,
  mandateFirmStagingKey,
  isAllowedContentType,
  maskEmail,
  matchesMagicBytes,
} from '../domain/mandate';
import type { TenantContext } from './documentation.service';

const OPEN_CASE_STATUSES: DocCaseStatus[] = [
  DocCaseStatus.INCOMING,
  DocCaseStatus.ACTIVE,
];

export class MandateService {
  private readonly audit: AuditService;
  private readonly notifications: NotificationService;

  constructor(private readonly prisma: PrismaClient) {
    this.audit = new AuditService(prisma);
    this.notifications = new NotificationService(prisma);
  }

  // ─── 7a. sendMandateRequest ────────────────────────────────────────────────

  async sendMandateRequest(
    ctx: TenantContext,
    caseId: string,
    input: { mandateType: string; description?: string; sendEmail?: boolean },
  ) {
    const rawToken = generateUploadToken();
    const uploadTokenHash = hashUploadToken(rawToken);
    const expiresAt = tokenExpiry();

    const result = await this.prisma.$transaction(async (tx) => {
      const docCase = await tx.docCase.findFirst({
        where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true, tenantId: true, caseNumber: true, lead: { select: { email: true, firstName: true } } },
      });
      if (!docCase) throw new ResourceNotFoundError();
      if (!OPEN_CASE_STATUSES.includes(docCase.status)) {
        throw new BusinessRuleViolationError('Mandates can only be sent for open cases.');
      }

      // A5: check for existing active request
      const existing = await tx.mandateRequest.findFirst({
        where: { caseId, tenantId: ctx.tenantId, status: { notIn: ['VERIFIED', 'SUPERSEDED', 'EXPIRED'] } },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        if (existing.status === MandateRequestStatus.UPLOADED) {
          throw new BusinessRuleViolationError('Verify or reject the existing upload before sending a new mandate.');
        }
        // PENDING_UPLOAD or REJECTED → supersede
        await tx.mandateRequest.update({
          where: { id: existing.id },
          data: { status: MandateRequestStatus.SUPERSEDED, supersededBy: caseId },
        });
        await tx.docCaseEvent.create({
          data: {
            tenantId: ctx.tenantId, caseId, eventType: DocEventType.MANDATE_SUPERSEDED,
            actorUserId: ctx.userId, payload: { supersededRequestId: existing.id } as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId, eventType: 'MANDATE_SUPERSEDED', entityType: 'MandateRequest',
          entityId: existing.id, actorUserId: ctx.userId, operation: 'UPDATE',
          payload: { supersededRequestId: existing.id, newStatus: 'SUPERSEDED' },
        });
      }

      const request = await tx.mandateRequest.create({
        data: {
          tenantId: ctx.tenantId,
          caseId,
          mandateType: input.mandateType,
          description: input.description,
          uploadTokenHash,
          tokenExpiresAt: expiresAt,
          sentByUserId: ctx.userId,
          sentToEmail: docCase.lead?.email ?? null,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId, eventType: DocEventType.MANDATE_SENT,
          actorUserId: ctx.userId,
          payload: { mandateRequestId: request.id, mandateType: input.mandateType, sentToEmail: docCase.lead?.email ? maskEmail(docCase.lead.email) : null } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, eventType: 'MANDATE_SENT', entityType: 'MandateRequest',
        entityId: request.id, actorUserId: ctx.userId, operation: 'CREATE',
        payload: { mandateType: input.mandateType, caseId, sentToEmail: docCase.lead?.email ? maskEmail(docCase.lead.email) : null },
      });

      return { request, docCase };
    });

    // After tx: send email if requested
    if (input.sendEmail !== false && result.docCase.lead?.email) {
      const uploadUrl = `${process.env.MANDATE_UPLOAD_BASE_URL || 'http://localhost:5173/mandate/upload'}?token=${rawToken}`;
      await emailService.sendMandateUploadEmail(result.docCase.lead.email, {
        clientName: result.docCase.lead.firstName ?? undefined,
        mandateType: input.mandateType,
        uploadUrl,
        expiresAt,
      }).catch(() => {});
    }

    return { mandateRequestId: result.request.id, uploadToken: rawToken, expiresAt };
  }

  // ─── 7b. generateUploadUrl ─────────────────────────────────────────────────

  async generateUploadUrl(
    tokenHash: string,
    fileInfo: { fileName: string; contentType: string; fileSizeBytes: number },
    ip: string,
  ) {
    await checkMandateUploadAttempts(tokenHash);

    const request = await this.prisma.mandateRequest.findUnique({
      where: { uploadTokenHash: tokenHash },
      select: { id: true, tenantId: true, caseId: true, status: true, tokenExpiresAt: true, maxFileSizeBytes: true, allowedTypes: true },
    });
    if (!request) throw new ResourceNotFoundError();

    // D5: a closed/cancelled/deleted parent case kills the upload link immediately.
    await this.assertCaseAcceptsUploads(request.caseId, request.tenantId);

    if (request.status !== MandateRequestStatus.PENDING_UPLOAD) {
      throw new BusinessRuleViolationError(
        request.status === MandateRequestStatus.UPLOADED ? 'Document already uploaded.' :
        request.status === MandateRequestStatus.VERIFIED ? 'This mandate has been verified.' :
        request.status === MandateRequestStatus.EXPIRED ? 'This upload link has expired.' :
        'This mandate request is no longer active.',
      );
    }
    if (isTokenExpired(request.tokenExpiresAt)) {
      throw new BusinessRuleViolationError('This upload link has expired.');
    }

    if (!request.allowedTypes.includes(fileInfo.contentType)) {
      throw new ValidationError(`File type ${fileInfo.contentType} is not accepted. Allowed: ${request.allowedTypes.join(', ')}`);
    }
    if (fileInfo.fileSizeBytes > request.maxFileSizeBytes) {
      throw new ValidationError(`File size exceeds the ${request.maxFileSizeBytes} byte limit.`);
    }

    const uploadId = crypto.randomUUID();
    const stagingKey = mandateStagingKey(request.tenantId, request.id, uploadId, fileInfo.fileName);
    const { url, expiresAt } = await storageService.generateUploadUrl(
      stagingKey, fileInfo.contentType, fileInfo.fileSizeBytes, MANDATE_POLICY.PRESIGNED_URL_SECONDS,
    );

    return { uploadUrl: url, uploadId, expiresAt };
  }

  // ─── 7c. confirmUpload ─────────────────────────────────────────────────────

  async confirmUpload(
    tokenHash: string,
    uploadId: string,
    fileName: string,
    ip: string,
    userAgent: string,
  ) {
    await checkMandateUploadAttempts(tokenHash);

    const request = await this.prisma.mandateRequest.findUnique({
      where: { uploadTokenHash: tokenHash },
      select: { id: true, tenantId: true, caseId: true, status: true, tokenExpiresAt: true, maxFileSizeBytes: true, allowedTypes: true },
    });
    if (!request) throw new ResourceNotFoundError();

    // D5: a closed/cancelled/deleted parent case kills the upload link immediately.
    await this.assertCaseAcceptsUploads(request.caseId, request.tenantId);

    if (request.status !== MandateRequestStatus.PENDING_UPLOAD || isTokenExpired(request.tokenExpiresAt)) {
      throw new BusinessRuleViolationError('This mandate request is no longer accepting uploads.');
    }

    const safeName = sanitizeFileName(fileName);
    const stagingKey = mandateStagingKey(request.tenantId, request.id, uploadId, safeName);
    const head = await storageService.headObject(stagingKey);
    if (!head.exists) throw new ConflictError();

    // A3: validate actual file properties from R2, not client-declared
    if (head.contentLength! > request.maxFileSizeBytes) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file exceeds the size limit.');
    }
    if (!request.allowedTypes.includes(head.contentType!)) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file type is not accepted.');
    }

    // Fetch staged bytes once — used for both magic-byte validation and virus scan.
    const stagedBytes = await storageService.getObjectBytes(stagingKey);

    // C9: magic-byte validation — reject files whose actual content doesn't match the
    // declared Content-Type. Catches renamed executables, polyglots, etc.
    if (!matchesMagicBytes(head.contentType!, stagedBytes)) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file content does not match its declared type.');
    }

    // Virus scan gate: scan the staged bytes BEFORE marking UPLOADED or promoting to
    // the final key. Fail closed — an unscanned file must never reach mandate-uploads/.
    // Virus scan when enabled (fail-closed on scanner failure), or an explicit
    // logged policy bypass when VIRUS_SCAN_ENABLED !== 'true'. Never silently skips.
    let scanOutcome;
    try {
      scanOutcome = await virusScanService.scanOrBypass(stagedBytes);
    } catch {
      // Enabled but unreachable / timeout / misconfigured — leave staging + PENDING_UPLOAD for retry.
      throw new ScannerUnavailableError();
    }
    if (scanOutcome.isInfected) {
      // Server-side only: record the scanner verdict/signature for observability.
      // Never sent to the client, audit payload, case event, or notification.
      logger.warn({ mandateRequestId: request.id, uploadId, signature: scanOutcome.signature }, 'Mandate upload rejected by virus scanner (FOUND)');
      await this.handleInfectedUpload(request, stagingKey, uploadId, safeName, ip, userAgent);
      throw new InfectedFileError();
    }

    // A3: race-safe conditional transition
    const updated = await this.prisma.mandateRequest.updateMany({
      where: { id: request.id, tenantId: request.tenantId, status: MandateRequestStatus.PENDING_UPLOAD },
      data: { status: MandateRequestStatus.UPLOADED },
    });

    if (updated.count !== 1) {
      // Concurrent confirm won — do not insert MandateUpload
      return { uploadId, status: 'CONFLICT' as const };
    }

    // A4: promote from staging to final key
    const finalKey = mandateFinalKey(request.tenantId, request.id, uploadId, safeName);
    await storageService.copyObject(stagingKey, finalKey);
    await storageService.deleteObject(stagingKey);

    // Insert MandateUpload with R2's real values
    await this.prisma.$transaction(async (tx) => {
      await tx.mandateUpload.create({
        data: {
          tenantId: request.tenantId,
          mandateRequestId: request.id,
          storageKey: finalKey,
          fileName: safeName,
          contentType: head.contentType!,
          fileSizeBytes: head.contentLength!,
          uploadIp: ip,
          uploadUserAgent: userAgent,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: request.tenantId, caseId: request.caseId, eventType: DocEventType.MANDATE_UPLOADED,
          payload: { mandateRequestId: request.id, uploadId, fileName: safeName, fileSizeBytes: head.contentLength } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: request.tenantId, eventType: 'MANDATE_UPLOADED', entityType: 'MandateRequest',
        entityId: request.id, actorIp: ip, actorUserAgent: userAgent, operation: 'UPDATE',
        payload: { uploadId, fileName: safeName, contentType: head.contentType, fileSizeBytes: head.contentLength },
      });
    });

    // Notify staff
    const docCase = await this.prisma.docCase.findUnique({
      where: { id: request.caseId },
      select: { assignedTo: true, caseNumber: true },
    });
    if (docCase?.assignedTo) {
      await this.notifications.create({
        tenantId: request.tenantId,
        recipientUserId: docCase.assignedTo,
        type: NotificationType.MANDATE_UPLOAD_RECEIVED,
        title: 'Mandate uploaded',
        message: `A mandate document was uploaded for case ${docCase.caseNumber || request.caseId}.`,
        actionUrl: `/documentation/cases/${request.caseId}`,
      });
    }

    return { uploadId, status: 'UPLOADED' as const };
  }

  // ─── 7b-firm. firmUploadUrl (staff direct upload) ──────────────────────────

  /** Staff presigned PUT for a firm-uploaded mandate. No DB write; no token. */
  async firmUploadUrl(
    ctx: TenantContext,
    caseId: string,
    fileInfo: { fileName: string; contentType: string; fileSizeBytes: number },
  ) {
    // 404 for a missing / cross-tenant case (no existence leak); 410 only when closed.
    const exists = await this.prisma.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } });
    if (!exists) throw new ResourceNotFoundError();
    await this.assertCaseAcceptsUploads(caseId, ctx.tenantId);

    if (!isAllowedContentType(fileInfo.contentType)) {
      throw new ValidationError(`File type ${fileInfo.contentType} is not accepted. Allowed: ${MANDATE_POLICY.ALLOWED_CONTENT_TYPES.join(', ')}`);
    }
    if (fileInfo.fileSizeBytes > MANDATE_POLICY.MAX_FILE_SIZE_BYTES) {
      throw new ValidationError(`File size exceeds the ${MANDATE_POLICY.MAX_FILE_SIZE_BYTES} byte limit.`);
    }

    const uploadId = crypto.randomUUID();
    const stagingKey = mandateFirmStagingKey(ctx.tenantId, caseId, uploadId, fileInfo.fileName);
    const { url, expiresAt } = await storageService.generateUploadUrl(
      stagingKey, fileInfo.contentType, fileInfo.fileSizeBytes, MANDATE_POLICY.PRESIGNED_URL_SECONDS,
    );
    return { uploadUrl: url, uploadId, expiresAt };
  }

  // ─── 7c-firm. firmConfirmUpload (staff direct upload) ──────────────────────

  /**
   * Confirm a firm-uploaded mandate. Reuses the client pipeline (headObject →
   * magic bytes → scan → promote) but is staff-authed, tokenless, and always
   * supersedes the transition-legal set of prior requests (never blocks; a prior
   * VERIFIED request is retained as history — domain forbids VERIFIED→SUPERSEDED).
   * `canVerify` is resolved by the router from the caller's mandate:verify permission.
   */
  async firmConfirmUpload(
    ctx: TenantContext,
    caseId: string,
    input: {
      uploadId: string;
      fileName: string;
      mandateType?: string;
      sourceChannel: DocumentSourceChannel;
      internalNote?: string;
      expiresAt?: Date | null;
      verify?: boolean;
    },
    canVerify: boolean,
  ) {
    // B1.2 replay (first-wins): a prior confirm for this uploadId returns unchanged.
    const replay = await this.prisma.mandateUpload.findFirst({
      where: { uploadId: input.uploadId, tenantId: ctx.tenantId },
      select: { mandateRequestId: true, mandateRequest: { select: { status: true } } },
    });
    if (replay) {
      return {
        mandateRequestId: replay.mandateRequestId,
        uploadId: input.uploadId,
        status: replay.mandateRequest.status === MandateRequestStatus.VERIFIED ? ('VERIFIED' as const) : ('UPLOADED' as const),
      };
    }

    // G4: verify-permission gate — after replay, before any object gate.
    if (input.verify === true && !canVerify) throw new AuthorizationError();

    const exists = await this.prisma.docCase.findFirst({ where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } });
    if (!exists) throw new ResourceNotFoundError();
    await this.assertCaseAcceptsUploads(caseId, ctx.tenantId);

    const safeName = sanitizeFileName(input.fileName);
    const stagingKey = mandateFirmStagingKey(ctx.tenantId, caseId, input.uploadId, safeName);
    const head = await storageService.headObject(stagingKey);
    if (!head.exists) throw new ConflictError();

    if (head.contentLength! > MANDATE_POLICY.MAX_FILE_SIZE_BYTES) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file exceeds the size limit.');
    }
    if (!isAllowedContentType(head.contentType!)) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file type is not accepted.');
    }

    const stagedBytes = await storageService.getObjectBytes(stagingKey);
    if (!matchesMagicBytes(head.contentType!, stagedBytes)) {
      await storageService.deleteObject(stagingKey);
      throw new ValidationError('Uploaded file content does not match its declared type.');
    }

    let scanOutcome;
    try {
      scanOutcome = await virusScanService.scanOrBypass(stagedBytes);
    } catch {
      throw new ScannerUnavailableError(); // leave staging for retry
    }
    if (scanOutcome.isInfected) {
      try {
        await storageService.deleteObject(stagingKey);
      } catch (err) {
        logger.error({ err, stagingKey, caseId }, 'Failed to delete infected firm-upload staging object — manual cleanup required');
      }
      logger.warn({ caseId, uploadId: input.uploadId, signature: scanOutcome.signature }, 'Firm mandate upload rejected by virus scanner (FOUND)');
      await this.audit.log({
        tenantId: ctx.tenantId, eventType: 'MANDATE_FIRM_UPLOAD_REJECTED_INFECTED', entityType: 'DocCase',
        entityId: caseId, actorUserId: ctx.userId, operation: 'CREATE',
        payload: { uploadId: input.uploadId, reason: 'FAILED_SECURITY_SCAN', fileName: safeName },
      });
      throw new InfectedFileError();
    }

    // Pre-generate the request id so the final key can be built before promotion
    // (storage ops stay OUT of the DB transaction). Orphan-on-tx-failure parity
    // with the client confirmUpload flow.
    const requestId = crypto.randomUUID();
    const finalKey = mandateFinalKey(ctx.tenantId, requestId, input.uploadId, safeName);
    await storageService.copyObject(stagingKey, finalKey);
    await storageService.deleteObject(stagingKey);

    const willVerify = input.verify === true && canVerify;
    const newStatus = willVerify ? MandateRequestStatus.VERIFIED : MandateRequestStatus.UPLOADED;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // B1.3: serialize concurrent staff writes on this case.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "DocCase" WHERE id = ${caseId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
        if (locked.length === 0) throw new ResourceNotFoundError();

        // F6: detect a prior VERIFIED request that will be retained (not supersedable).
        const retainedVerified = await tx.mandateRequest.findFirst({
          where: { caseId, tenantId: ctx.tenantId, status: MandateRequestStatus.VERIFIED },
          select: { id: true },
        });

        // E5: supersede only the transition-legal set (VERIFIED/SUPERSEDED excluded).
        await tx.mandateRequest.updateMany({
          where: { caseId, tenantId: ctx.tenantId, status: { in: [MandateRequestStatus.PENDING_UPLOAD, MandateRequestStatus.UPLOADED, MandateRequestStatus.REJECTED, MandateRequestStatus.EXPIRED] } },
          data: { status: MandateRequestStatus.SUPERSEDED, supersededBy: requestId },
        });

        const request = await tx.mandateRequest.create({
          data: {
            id: requestId,
            tenantId: ctx.tenantId,
            caseId,
            mandateType: input.mandateType?.trim() || 'Mandate',
            uploadTokenHash: hashUploadToken(crypto.randomUUID()), // random; never issued to a client
            tokenExpiresAt: new Date(), // immaterial: status is not PENDING_UPLOAD, the expiry worker ignores it
            sentByUserId: ctx.userId,
            status: newStatus,
            verifiedAt: willVerify ? new Date() : null,
            verifiedBy: willVerify ? ctx.userId : null,
          },
        });

        await tx.mandateUpload.create({
          data: {
            tenantId: ctx.tenantId,
            mandateRequestId: request.id,
            storageKey: finalKey,
            fileName: safeName,
            contentType: head.contentType!,
            fileSizeBytes: head.contentLength!,
            uploadId: input.uploadId,
            uploadedByParty: UploadedByParty.FIRM,
            sourceChannel: input.sourceChannel,
            uploadedByUserId: ctx.userId,
            internalNote: input.internalNote ?? null,
            expiresAt: input.expiresAt ?? null,
          },
        });

        await tx.docCaseEvent.create({
          data: {
            tenantId: ctx.tenantId, caseId, eventType: DocEventType.MANDATE_FIRM_UPLOADED, actorUserId: ctx.userId,
            payload: { mandateRequestId: request.id, uploadId: input.uploadId, fileName: safeName, sourceChannel: input.sourceChannel, verified: willVerify } as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.appendInTx(tx, {
          tenantId: ctx.tenantId, eventType: 'MANDATE_FIRM_UPLOADED', entityType: 'MandateRequest',
          entityId: request.id, actorUserId: ctx.userId, operation: 'CREATE',
          payload: { uploadId: input.uploadId, sourceChannel: input.sourceChannel, verified: willVerify, previousStatus: null, newStatus },
        });

        if (retainedVerified) {
          // F6: coexistence — a prior VERIFIED mandate is kept as history.
          await tx.docCaseEvent.create({
            data: {
              tenantId: ctx.tenantId, caseId, eventType: DocEventType.MANDATE_SUPERSEDED, actorUserId: ctx.userId,
              payload: { retainedVerifiedRequestId: retainedVerified.id, newRequestId: request.id, note: 'prior verified mandate retained as history; new request current' } as unknown as Prisma.InputJsonValue,
            },
          });
          await this.audit.appendInTx(tx, {
            tenantId: ctx.tenantId, eventType: 'MANDATE_VERIFIED_RETAINED', entityType: 'MandateRequest',
            entityId: retainedVerified.id, actorUserId: ctx.userId, operation: 'UPDATE',
            payload: { retainedVerifiedRequestId: retainedVerified.id, newRequestId: request.id },
          });
        }

        return { mandateRequestId: request.id };
      });

      // Notify the assigned staffer (best-effort, post-tx).
      const docCase = await this.prisma.docCase.findUnique({
        where: { id: caseId }, select: { assignedTo: true, caseNumber: true },
      });
      if (docCase?.assignedTo && docCase.assignedTo !== ctx.userId) {
        await this.notifications.create({
          tenantId: ctx.tenantId, recipientUserId: docCase.assignedTo,
          type: NotificationType.MANDATE_UPLOAD_RECEIVED,
          title: 'Mandate uploaded by firm',
          message: `A mandate document was uploaded for case ${docCase.caseNumber || caseId}.`,
          actionUrl: `/documentation/cases/${caseId}`,
        }).catch(() => {});
      }

      return { mandateRequestId: result.mandateRequestId, uploadId: input.uploadId, status: newStatus === MandateRequestStatus.VERIFIED ? ('VERIFIED' as const) : ('UPLOADED' as const) };
    } catch (err) {
      // B1.2 backstop: a concurrent confirm won the uploadId — return its result.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const won = await this.prisma.mandateUpload.findFirst({
          where: { uploadId: input.uploadId, tenantId: ctx.tenantId },
          select: { mandateRequestId: true, mandateRequest: { select: { status: true } } },
        });
        if (won) {
          return {
            mandateRequestId: won.mandateRequestId,
            uploadId: input.uploadId,
            status: won.mandateRequest.status === MandateRequestStatus.VERIFIED ? ('VERIFIED' as const) : ('UPLOADED' as const),
          };
        }
      }
      throw err;
    }
  }

  /** Infected upload: delete the staged object, reject the request, audit + notify.
   *  Never stores the file, never logs the clamd signature (client sees a generic error). */
  private async handleInfectedUpload(
    request: { id: string; tenantId: string; caseId: string },
    stagingKey: string,
    uploadId: string,
    safeName: string,
    ip: string,
    userAgent: string,
  ): Promise<void> {
    // Delete the infected staging object first — malware must never linger in R2.
    // If deletion fails, do NOT swallow it: still reject the request (client gets a
    // generic 422), but log an ERROR and flag the audit event so ops can manually
    // remove the orphaned staging object.
    let stagingDeleteFailed = false;
    try {
      await storageService.deleteObject(stagingKey);
    } catch (err) {
      stagingDeleteFailed = true;
      logger.error(
        { err, stagingKey, mandateRequestId: request.id },
        'Failed to delete infected staging object after virus scan — manual cleanup required',
      );
    }

    // Race-safe transition PENDING_UPLOAD -> REJECTED (a concurrent confirm may have moved it).
    const rejected = await this.prisma.mandateRequest.updateMany({
      where: { id: request.id, tenantId: request.tenantId, status: MandateRequestStatus.PENDING_UPLOAD },
      data: { status: MandateRequestStatus.REJECTED, rejectedAt: new Date(), rejectionReason: 'Uploaded file failed a security scan.' },
    });
    if (rejected.count !== 1) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.docCaseEvent.create({
        data: {
          tenantId: request.tenantId, caseId: request.caseId, eventType: DocEventType.MANDATE_REJECTED,
          payload: { mandateRequestId: request.id, uploadId, reason: 'FAILED_SECURITY_SCAN', fileName: safeName } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: request.tenantId, eventType: 'MANDATE_UPLOAD_REJECTED_INFECTED', entityType: 'MandateRequest',
        entityId: request.id, actorIp: ip, actorUserAgent: userAgent, operation: 'UPDATE',
        payload: { uploadId, reason: 'FAILED_SECURITY_SCAN', fileName: safeName, stagingDeleteFailed },
      });
    });

    const docCase = await this.prisma.docCase.findUnique({
      where: { id: request.caseId },
      select: { assignedTo: true, caseNumber: true },
    });
    if (docCase?.assignedTo) {
      await this.notifications.create({
        tenantId: request.tenantId,
        recipientUserId: docCase.assignedTo,
        type: NotificationType.MANDATE_UPLOAD_RECEIVED,
        title: 'Mandate upload rejected',
        message: `A mandate upload for case ${docCase.caseNumber || request.caseId} was rejected by the security scanner.`,
        actionUrl: `/documentation/cases/${request.caseId}`,
      });
    }
  }

  // ─── 7d. verifyMandate ─────────────────────────────────────────────────────

  async verifyMandate(ctx: TenantContext, mandateRequestId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.loadRequest(tx, ctx, mandateRequestId);
      if (request.status !== MandateRequestStatus.UPLOADED) {
        throw new BusinessRuleViolationError('Only uploaded mandates can be verified.');
      }
      this.assertSingleUpload(request);

      await tx.mandateRequest.update({
        where: { id: mandateRequestId },
        data: { status: MandateRequestStatus.VERIFIED, verifiedAt: new Date(), verifiedBy: ctx.userId },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: request.caseId, eventType: DocEventType.MANDATE_VERIFIED,
          actorUserId: ctx.userId,
          payload: { mandateRequestId } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, eventType: 'MANDATE_VERIFIED', entityType: 'MandateRequest',
        entityId: mandateRequestId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { mandateRequestId },
      });

      return { mandateRequestId, status: MandateRequestStatus.VERIFIED };
    });
  }

  // ─── 7e. rejectMandate ─────────────────────────────────────────────────────

  async rejectMandate(ctx: TenantContext, mandateRequestId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.loadRequest(tx, ctx, mandateRequestId);
      if (request.status !== MandateRequestStatus.UPLOADED) {
        throw new BusinessRuleViolationError('Only uploaded mandates can be rejected.');
      }
      this.assertSingleUpload(request);

      await tx.mandateRequest.update({
        where: { id: mandateRequestId },
        data: {
          status: MandateRequestStatus.REJECTED,
          rejectedAt: new Date(),
          rejectedBy: ctx.userId,
          rejectionReason: reason,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: request.caseId, eventType: DocEventType.MANDATE_REJECTED,
          actorUserId: ctx.userId,
          payload: { mandateRequestId, reason } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, eventType: 'MANDATE_REJECTED', entityType: 'MandateRequest',
        entityId: mandateRequestId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { mandateRequestId, reason },
      });

      // A14: plain reject notifies staff only — client email only via regenerateLink
      return { mandateRequestId, status: MandateRequestStatus.REJECTED };
    });
  }

  // ─── 7f. regenerateLink ────────────────────────────────────────────────────

  async regenerateLink(ctx: TenantContext, mandateRequestId: string) {
    const rawToken = generateUploadToken();
    const uploadTokenHash = hashUploadToken(rawToken);
    const expiresAt = tokenExpiry();

    const result = await this.prisma.$transaction(async (tx) => {
      const old = await this.loadRequest(tx, ctx, mandateRequestId);
      // D5: cannot regenerate a link for a closed/cancelled/deleted case.
      const parentCase = await tx.docCase.findFirst({
        where: { id: old.caseId, tenantId: ctx.tenantId },
        select: { status: true, deletedAt: true },
      });
      if (
        !parentCase || parentCase.deletedAt !== null ||
        parentCase.status === DocCaseStatus.CLOSED_NO_DOCS ||
        parentCase.status === DocCaseStatus.CLOSED ||
        parentCase.status === DocCaseStatus.CANCELLED
      ) {
        throw new BusinessRuleViolationError('Cannot regenerate a link for a closed case.');
      }
      if (!(old.status === MandateRequestStatus.PENDING_UPLOAD || old.status === MandateRequestStatus.EXPIRED || old.status === MandateRequestStatus.REJECTED)) {
        throw new BusinessRuleViolationError('Cannot regenerate link for this mandate request.');
      }

      const wasRejected = old.status === MandateRequestStatus.REJECTED;

      await tx.mandateRequest.update({
        where: { id: mandateRequestId },
        data: { status: MandateRequestStatus.SUPERSEDED },
      });

      const newRequest = await tx.mandateRequest.create({
        data: {
          tenantId: ctx.tenantId,
          caseId: old.caseId,
          mandateType: old.mandateType,
          description: old.description,
          uploadTokenHash,
          tokenExpiresAt: expiresAt,
          sentByUserId: ctx.userId,
          sentToEmail: old.sentToEmail,
        },
      });

      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: old.caseId, eventType: DocEventType.MANDATE_LINK_REGENERATED,
          actorUserId: ctx.userId,
          payload: { oldRequestId: mandateRequestId, newRequestId: newRequest.id } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.docCaseEvent.create({
        data: {
          tenantId: ctx.tenantId, caseId: old.caseId, eventType: DocEventType.MANDATE_SUPERSEDED,
          actorUserId: ctx.userId,
          payload: { supersededRequestId: mandateRequestId } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, eventType: 'MANDATE_LINK_REGENERATED', entityType: 'MandateRequest',
        entityId: newRequest.id, actorUserId: ctx.userId, operation: 'CREATE',
        payload: { oldRequestId: mandateRequestId, newRequestId: newRequest.id },
      });
      await this.audit.appendInTx(tx, {
        tenantId: ctx.tenantId, eventType: 'MANDATE_SUPERSEDED', entityType: 'MandateRequest',
        entityId: mandateRequestId, actorUserId: ctx.userId, operation: 'UPDATE',
        payload: { supersededBy: newRequest.id },
      });

      return { newRequest, wasRejected, rejectionReason: old.rejectionReason, sentToEmail: old.sentToEmail, caseId: old.caseId };
    });

    // A14: email client with new link; include rejection reason if old was REJECTED
    if (result.sentToEmail) {
      const uploadUrl = `${process.env.MANDATE_UPLOAD_BASE_URL || 'http://localhost:5173/mandate/upload'}?token=${rawToken}`;
      const docCase = await this.prisma.docCase.findUnique({
        where: { id: result.caseId },
        select: { lead: { select: { firstName: true } } },
      });

      if (result.wasRejected && result.rejectionReason) {
        await emailService.sendMandateRejectedEmail(result.sentToEmail, {
          clientName: docCase?.lead?.firstName ?? undefined,
          mandateType: result.newRequest.mandateType,
          reason: result.rejectionReason,
          uploadUrl,
          expiresAt,
        }).catch(() => {});
      } else {
        await emailService.sendMandateUploadEmail(result.sentToEmail, {
          clientName: docCase?.lead?.firstName ?? undefined,
          mandateType: result.newRequest.mandateType,
          uploadUrl,
          expiresAt,
        }).catch(() => {});
      }
    }

    return { mandateRequestId: result.newRequest.id, uploadToken: rawToken, expiresAt };
  }

  // ─── 7g. getViewUrl ────────────────────────────────────────────────────────

  async getViewUrl(ctx: TenantContext, uploadId: string) {
    const upload = await this.prisma.mandateUpload.findFirst({
      where: { id: uploadId, tenantId: ctx.tenantId },
    });
    if (!upload) throw new ResourceNotFoundError();

    const { url, expiresAt } = await storageService.generateViewUrl(upload.storageKey);
    // A9: no storageKey in response
    return { viewUrl: url, fileName: upload.fileName, contentType: upload.contentType, fileSizeBytes: upload.fileSizeBytes, expiresAt };
  }

  // ─── 7h. listForCase ──────────────────────────────────────────────────────

  async listForCase(ctx: TenantContext, caseId: string) {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!docCase) throw new ResourceNotFoundError();

    const requests = await this.prisma.mandateRequest.findMany({
      where: { caseId, tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        mandateType: true,
        status: true,
        sentToEmail: true,
        sentByUserId: true,
        verifiedAt: true,
        verifiedBy: true,
        rejectedAt: true,
        rejectedBy: true,
        rejectionReason: true,
        tokenExpiresAt: true,
        createdAt: true,
        uploads: {
          select: {
            id: true,
            fileName: true,
            contentType: true,
            fileSizeBytes: true,
            uploadedAt: true,
            uploadedByParty: true,
            sourceChannel: true,
            uploadedByUserId: true,
            internalNote: true,
            expiresAt: true,
          },
        },
      },
    });

    // A9: mask email, exclude storageKey/uploadTokenHash/raw tokens
    return requests.map((r) => ({
      ...r,
      sentToEmail: r.sentToEmail ? maskEmail(r.sentToEmail) : null,
    }));
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** D5: reject public upload actions when the parent case is closed/cancelled/deleted. */
  private async assertCaseAcceptsUploads(caseId: string, tenantId: string): Promise<void> {
    const docCase = await this.prisma.docCase.findFirst({
      where: { id: caseId, tenantId },
      select: { status: true, deletedAt: true },
    });
    if (
      !docCase ||
      docCase.deletedAt !== null ||
      docCase.status === DocCaseStatus.CLOSED_NO_DOCS ||
      docCase.status === DocCaseStatus.CLOSED ||
      docCase.status === DocCaseStatus.CANCELLED
    ) {
      throw new CaseClosedError();
    }
  }

  private async loadRequest(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    mandateRequestId: string,
  ) {
    const request = await tx.mandateRequest.findFirst({
      where: { id: mandateRequestId, tenantId: ctx.tenantId },
      include: { uploads: { select: { id: true } } },
    });
    if (!request) throw new ResourceNotFoundError();
    return request;
  }

  // A3: verify/reject fail closed if multiple uploads exist
  private assertSingleUpload(request: { uploads: { id: string }[] }) {
    if (request.uploads.length > 1) {
      throw new Error('INVARIANT VIOLATION: multiple uploads for a single mandate request');
    }
  }
}