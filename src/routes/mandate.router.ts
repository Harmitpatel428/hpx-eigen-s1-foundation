import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, permissionMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { MandateService } from '../services/mandate.service';
import { hashUploadToken, MANDATE_POLICY, isAllowedContentType } from '../domain/mandate';
import {
  ValidationError,
  ResourceNotFoundError,
  BusinessRuleViolationError,
  ConflictError,
  RateLimitExceededError,
  TemporaryServiceError,
  ConfigurationError,
  ScannerUnavailableError,
  InfectedFileError,
  CaseClosedError,
} from '../types/exceptions';

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function mapError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof ValidationError) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: err.message });
  } else if (err instanceof ConfigurationError) {
    res.status(503).json({
      code: 'STORAGE_NOT_CONFIGURED',
      message: 'Document storage is not configured. Uploads are temporarily unavailable.',
    });
  } else if (err instanceof ScannerUnavailableError) {
    res.status(503).json({ code: 'SCANNER_UNAVAILABLE', message: (err as Error).message });
  } else if (err instanceof InfectedFileError) {
    res.status(422).json({ code: 'FILE_REJECTED', message: (err as Error).message });
  } else if (err instanceof RateLimitExceededError) {
    res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again later.' });
  } else if (err instanceof TemporaryServiceError) {
    res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Temporary service issue. Try again shortly.' });
  } else if (err instanceof ResourceNotFoundError) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Resource not found.' });
  } else if (err instanceof ConflictError) {
    res.status(409).json({ code: 'CONFLICT', message: (err as Error).message });
  } else if (err instanceof CaseClosedError) {
    res.status(410).json({ code: 'CASE_CLOSED', message: (err as Error).message });
  } else if (err instanceof BusinessRuleViolationError) {
    const msg = (err as Error).message;
    if (msg.includes('expired')) {
      res.status(410).json({ code: 'GONE', message: msg });
    } else if (msg.includes('no longer active') || msg.includes('no longer accepting')) {
      res.status(410).json({ code: 'GONE', message: msg });
    } else if (msg.includes('size') || msg.includes('exceeds')) {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: msg });
    } else if (msg.includes('type') && msg.includes('not accepted')) {
      res.status(415).json({ code: 'UNSUPPORTED_MEDIA_TYPE', message: msg });
    } else {
      res.status(422).json({ code: 'BUSINESS_RULE_VIOLATION', message: msg });
    }
  } else {
    next(err);
  }
}

export function createMandateRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = new MandateService(prisma);

  const clientIp = (req: Request): string =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || 'unknown';

  // ─── Staff authenticated routes ─────────────────────────────────────────

  /** POST /cases/:caseId/mandate/send — staff sends mandate request */
  router.post('/cases/:caseId/mandate/send', authMiddleware, permissionMiddleware('mandate:send'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { mandateType, description, sendEmail } = req.body as {
          mandateType?: string; description?: string; sendEmail?: boolean;
        };
        if (!mandateType || typeof mandateType !== 'string' || mandateType.length < 1 || mandateType.length > 200) {
          throw new ValidationError('mandateType is required (1-200 characters).');
        }
        if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) {
          throw new ValidationError('description must be a string of at most 1000 characters.');
        }
        if (!isUuid(req.params.caseId)) throw new ValidationError('Invalid caseId.');

        const result = await svc.sendMandateRequest(
          { tenantId, userId },
          req.params.caseId,
          { mandateType: mandateType.trim(), description: description?.trim(), sendEmail },
        );
        res.status(201).json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** POST /mandate/:id/verify — staff verifies uploaded mandate */
  router.post('/mandate/:id/verify', authMiddleware, permissionMiddleware('mandate:verify'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!isUuid(req.params.id)) throw new ValidationError('Invalid mandate request id.');
        const result = await svc.verifyMandate({ tenantId, userId }, req.params.id);
        res.json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** POST /mandate/:id/reject — staff rejects uploaded mandate */
  router.post('/mandate/:id/reject', authMiddleware, permissionMiddleware('mandate:verify'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        const { reason } = req.body as { reason?: string };
        if (!isUuid(req.params.id)) throw new ValidationError('Invalid mandate request id.');
        if (!reason || typeof reason !== 'string' || reason.length < 1 || reason.length > 1000) {
          throw new ValidationError('reason is required (1-1000 characters).');
        }
        const result = await svc.rejectMandate({ tenantId, userId }, req.params.id, reason.trim());
        res.json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** POST /mandate/:id/regenerate-link — staff regenerates upload link */
  router.post('/mandate/:id/regenerate-link', authMiddleware, permissionMiddleware('mandate:send'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!isUuid(req.params.id)) throw new ValidationError('Invalid mandate request id.');
        const result = await svc.regenerateLink({ tenantId, userId }, req.params.id);
        res.status(201).json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** GET /mandate/uploads/:uploadId/view-url — staff gets presigned view URL */
  router.get('/mandate/uploads/:uploadId/view-url', authMiddleware, permissionMiddleware('mandate:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!isUuid(req.params.uploadId)) throw new ValidationError('Invalid upload id.');
        const result = await svc.getViewUrl({ tenantId, userId }, req.params.uploadId);
        res.json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** GET /cases/:caseId/mandate — staff lists mandate requests for a case */
  router.get('/cases/:caseId/mandate', authMiddleware, permissionMiddleware('mandate:view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, userId } = (req as AuthenticatedRequest).user;
        if (!isUuid(req.params.caseId)) throw new ValidationError('Invalid caseId.');
        const result = await svc.listForCase({ tenantId, userId }, req.params.caseId);
        res.json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  // ─── Public routes (token-based auth) ───────────────────────────────────

  /** POST /mandate/upload-url — client requests a presigned upload URL */
  router.post('/mandate/upload-url',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { token, fileName, contentType, fileSizeBytes } = req.body as {
          token?: string; fileName?: string; contentType?: string; fileSizeBytes?: number;
        };
        if (!token || typeof token !== 'string' || !isUuid(token)) {
          throw new ValidationError('A valid token is required.');
        }
        if (!fileName || typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) {
          throw new ValidationError('fileName is required (1-255 characters).');
        }
        if (!contentType || !isAllowedContentType(contentType)) {
          throw new ValidationError(`contentType must be one of: ${MANDATE_POLICY.ALLOWED_CONTENT_TYPES.join(', ')}`);
        }
        if (typeof fileSizeBytes !== 'number' || !Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
          throw new ValidationError('fileSizeBytes must be a positive integer.');
        }
        if (fileSizeBytes > MANDATE_POLICY.MAX_FILE_SIZE_BYTES) {
          throw new ValidationError(`fileSizeBytes exceeds the ${MANDATE_POLICY.MAX_FILE_SIZE_BYTES} byte limit.`);
        }

        const tokenHash = hashUploadToken(token);
        const result = await svc.generateUploadUrl(tokenHash, { fileName, contentType, fileSizeBytes }, clientIp(req));
        res.json({ success: true, data: result });
      } catch (err) { mapError(err, res, next); }
    }
  );

  /** POST /mandate/confirm-upload — client confirms upload completed */
  router.post('/mandate/confirm-upload',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { token, uploadId, fileName } = req.body as {
          token?: string; uploadId?: string; fileName?: string;
        };
        if (!token || typeof token !== 'string' || !isUuid(token)) {
          throw new ValidationError('A valid token is required.');
        }
        if (!uploadId || typeof uploadId !== 'string' || !isUuid(uploadId)) {
          throw new ValidationError('A valid uploadId is required.');
        }
        if (!fileName || typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) {
          throw new ValidationError('fileName is required (1-255 characters).');
        }

        const tokenHash = hashUploadToken(token);
        const result = await svc.confirmUpload(tokenHash, uploadId, fileName, clientIp(req), req.headers['user-agent'] || '');

        if (result.status === 'CONFLICT') {
          res.status(409).json({ code: 'CONFLICT', message: 'Upload already confirmed.' });
          return;
        }
        res.json({ success: true, data: { uploadId: result.uploadId, status: result.status } });
      } catch (err) { mapError(err, res, next); }
    }
  );

  return router;
}