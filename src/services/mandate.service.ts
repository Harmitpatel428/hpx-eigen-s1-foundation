import {
  PrismaClient,
  MandateRequestStatus,
  DocEventType,
  DocCaseStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import crypto from 'crypto';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import { emailService } from './email.service';
import { storageService } from './storage.service';
import { virusScanService } from './virus-scan.service';
import { checkMandateUploadAttempts } from './auth/RateLimitService';
import {
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ConflictError,
  ValidationError,
  ScannerUnavailableError,
  InfectedFileError,
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
      select: { id: true, tenantId: true, status: true, tokenExpiresAt: true, maxFileSizeBytes: true, allowedTypes: true },
    });
    if (!request) throw new ResourceNotFoundError();

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
    if (virusScanService.isEnabled()) {
      let scan;
      try {
        scan = await virusScanService.scan(stagedBytes);
      } catch {
        // Unreachable / timeout / misconfigured — leave staging + PENDING_UPLOAD for retry.
        throw new ScannerUnavailableError();
      }
      if (!scan.clean) {
        await this.handleInfectedUpload(request, stagingKey, uploadId, safeName, ip, userAgent);
        throw new InfectedFileError();
      }
    } else if (process.env.NODE_ENV === 'production') {
      // Production must never accept an unscanned upload.
      throw new ScannerUnavailableError();
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
    await storageService.deleteObject(stagingKey);

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
        payload: { uploadId, reason: 'FAILED_SECURITY_SCAN', fileName: safeName },
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