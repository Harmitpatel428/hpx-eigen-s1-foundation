import { PrismaClient, SessionStatus } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  SessionExpiredError,
  SessionRevokedError,
  AuthenticationFailedError
} from '../types/exceptions';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    tenantId: string;
    sessionId: string;
  };
}

const prisma = new PrismaClient();

/**
 * Auth middleware — validates session per S1.8a Session State Machine spec.
 *
 * Rules (production rules 1-8 from spec):
 * - status must be ACTIVE
 * - expiresAt must be > NOW()
 * - deletedAt must be NULL
 * - tenantId must match token claim
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'MISSING_TOKEN', message: 'Authorization token required.' });
      return;
    }

    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET not configured');
    }

    // Verify and decode JWT
    let payload: { sessionId: string; userId: string; tenantId: string };
    try {
      payload = jwt.verify(token, secret) as typeof payload;
    } catch {
      throw new AuthenticationFailedError();
    }

    const { sessionId, userId, tenantId } = payload;

    // Validate session per state machine spec:
    // Must be ACTIVE, not expired, not soft-deleted, tenant-scoped
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        tenantId,
        userId,
        status: { in: [SessionStatus.ACTIVE, SessionStatus.CREATED] },
        expiresAt: { gt: new Date() },
        deletedAt: null
      }
    });

    if (!session) {
      // Distinguish expired vs revoked for better error messages
      const anySession = await prisma.session.findFirst({
        where: { id: sessionId, deletedAt: null },
        select: { status: true, expiresAt: true }
      });

      if (!anySession) {
        throw new AuthenticationFailedError();
      }

      if (
        anySession.status === SessionStatus.EXPIRED ||
        anySession.expiresAt <= new Date()
      ) {
        throw new SessionExpiredError();
      }

      if (
        anySession.status === SessionStatus.REVOKED ||
        anySession.status === SessionStatus.INVALIDATED
      ) {
        throw new SessionRevokedError();
      }

      throw new AuthenticationFailedError();
    }

    // Touch lastActivityAt on every authenticated request
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() }
    });

    // Promote CREATED → ACTIVE on first authenticated request
    // (Per spec: CREATED transitions to ACTIVE on first successful request)
    if (session.status === SessionStatus.CREATED) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { status: SessionStatus.ACTIVE }
      });
    }

    (req as AuthenticatedRequest).user = { userId, tenantId, sessionId };

    next();
  } catch (err: unknown) {
    if (err instanceof AuthenticationFailedError ||
      err instanceof SessionExpiredError ||
      err instanceof SessionRevokedError) {
      const e = err as { httpStatus: number; code: string; message: string };
      res.status(e.httpStatus).json({ code: e.code, message: e.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  }
}
