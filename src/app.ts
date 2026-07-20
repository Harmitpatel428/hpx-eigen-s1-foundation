import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { prisma } from './db';
import { AppException } from './types/exceptions';

// ─── Route Factories (S1) ─────────────────────────────────────────────────────
import { createAuthRouter } from './routes/auth.router';
import { createUsersRouter } from './routes/users.router';
import { createRolesRouter } from './routes/roles.router';
import { createSessionsRouter } from './routes/sessions.router';

// ─── Route Factories (S2 CRM Domain) ─────────────────────────────────────────
import { createLeadsRouter } from './routes/leads.router';
import { createContactsRouter } from './routes/contacts.router';
import { createOpportunitiesRouter } from './routes/opportunities.router';
import { createActivitiesRouter } from './routes/activities.router';
import { createPipelineRouter } from './routes/pipeline.router';

// ─── Route Factories (S3 Finance Domain) ───────────────────────────────────────
import { createInvoicesRouter } from './routes/invoices.router';
import { createPaymentsRouter } from './routes/payments.router';

// ─── Invitation Routes (legacy paths — kept for backward compat) ──────────────
import { authMiddleware, AuthenticatedRequest } from './middleware/auth.middleware';
import { InvitationService } from './services/invitation.service';

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allow frontend dev server (localhost:5173) and any configured origin
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin ?? '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-tenant-id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Domain Routers ───────────────────────────────────────────────────────────
app.use('/api/v1/auth', createAuthRouter(prisma));
app.use('/api/v1/users', createUsersRouter(prisma));
app.use('/api/v1/roles', createRolesRouter(prisma));
app.use('/api/v1/sessions', createSessionsRouter(prisma));

// ─── S2 CRM Domain Routers ────────────────────────────────────────────────────
app.use('/api/v1/leads', createLeadsRouter(prisma));
app.use('/api/v1/contacts', createContactsRouter(prisma));
app.use('/api/v1/opportunities', createOpportunitiesRouter(prisma));
app.use('/api/v1/activities', createActivitiesRouter(prisma));
app.use('/api/v1/analytics/pipeline', createPipelineRouter(prisma));

// ─── S3 Finance Domain Routers ────────────────────────────────────────────────
app.use('/api/v1/invoices', createInvoicesRouter(prisma));
app.use('/api/v1/payments', createPaymentsRouter(prisma));

// ─── Legacy Invitation Routes (backward compat) ───────────────────────────────
// These paths existed in S1 and may be relied on by existing tests.
// New canonical path is POST /api/users/invite (in users.router.ts).
const invitationService = new InvitationService(prisma);

/** POST /api/invitations */
app.post('/api/invitations', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, tenantId } = (req as AuthenticatedRequest).user;
    const { email, roleId } = req.body as { email: string; roleId: string };

    const invitation = await invitationService.createInvitation(tenantId, email, roleId, userId);
    res.status(201).json(invitation);
  } catch (err) {
    next(err);
  }
});

/** POST /api/invitations/accept */
app.post('/api/invitations/accept', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, tenantId } = (req as AuthenticatedRequest).user;
    const { token } = req.body as { token: string };

    const result = await invitationService.acceptInvitation(token, userId, tenantId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppException) {
    res.status(err.httpStatus).json({
      code: err.code,
      message: err.message,
      retryTag: err.retryTag
    });
    return;
  }

  console.error('[Unhandled Error]', err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
});

export default app;
