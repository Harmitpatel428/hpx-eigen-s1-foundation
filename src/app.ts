import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { prisma } from './db';
import { AppException } from './types/exceptions';
import { correlationMiddleware } from './middleware/correlation.middleware';
import { logger } from './utils/logger';
import { getCorrelationId } from './utils/requestContext';
// ─── Route Factories (S1) ─────────────────────────────────────────────────────
import { createAuthRouter } from './routes/auth.router';
import { createUsersRouter } from './routes/users.router';
import { createRolesRouter } from './routes/roles.router';
import { createSessionsRouter } from './routes/sessions.router';
import { createAuditRouter } from './routes/audit.router';

// ─── Route Factories (S2 CRM Domain) ─────────────────────────────────────────
import { createLeadsRouter } from './routes/leads.router';
import { createContactsRouter } from './routes/contacts.router';
import { createOpportunitiesRouter } from './routes/opportunities.router';
import { createActivitiesRouter } from './routes/activities.router';
import { createPipelineRouter } from './routes/pipeline.router';

// ─── Route Factories (S3 Finance Domain) ───────────────────────────────────────
import { createInvoicesRouter } from './routes/invoices.router';
import { createPaymentsRouter } from './routes/payments.router';
import { createOpportunityTypesRouter } from './routes/opportunity-types.router';

// ─── Route Factories (Org Hierarchy) ─────────────────────────────────────────
import { createDepartmentsRouter } from './routes/departments.router';
import { createTeamsRouter } from './routes/teams.router';

// ─── Invitation Routes (legacy paths — kept for backward compat) ──────────────
import { authMiddleware, AuthenticatedRequest } from './middleware/auth.middleware';
import { InvitationService } from './services/invitation.service';

import * as Sentry from '@sentry/node';

const app = express();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.2,
  beforeSend(event) {
    // Scrub Authorization and Department headers
    if (event.request && event.request.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['x-department-id'];
      delete event.request.headers['x-department-context'];
    }
    return event;
  }
});

app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// ─── Correlation Context (MUST BE FIRST) ──────────────────────────────────────
app.use(correlationMiddleware);


// ─── CORS ─────────────────────────────────────────────────────────────────────
// Strict whitelist for allowed origins
const allowedOrigins = [
  'https://hpx-eigen-frontend.vercel.app', // Production frontend
  'http://localhost:5173',                  // Local Vite dev server
  'http://localhost:3000',                  // Local backend testing (if applicable)
  'https://hpxeigen.com',                   // Custom production domain
  'https://www.hpxeigen.com'                // Custom production domain (www)
];

const corsOptions = {
  origin: true, // Reflects the request origin, allowing Vercel
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-department-id', 'x-department-context'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, _res: Response) => {
  throw new Error('Sentry Backend Test Error');
});

// ─── Domain Routers ───────────────────────────────────────────────────────────
app.use('/api/v1/auth', createAuthRouter(prisma));
app.use('/api/v1/users', createUsersRouter(prisma));
app.use('/api/v1/roles', createRolesRouter(prisma));
app.use('/api/v1/sessions', createSessionsRouter(prisma));
app.use('/api/v1/audit-logs', createAuditRouter(prisma));

// ─── S2 CRM Domain Routers ────────────────────────────────────────────────────
app.use('/api/v1/leads', createLeadsRouter(prisma));
app.use('/api/v1/contacts', createContactsRouter(prisma));
app.use('/api/v1/opportunities', createOpportunitiesRouter(prisma));
app.use('/api/v1/activities', createActivitiesRouter(prisma));
app.use('/api/v1/analytics/pipeline', createPipelineRouter(prisma));

// ─── S3 Finance Domain Routers ────────────────────────────────────────────────
app.use('/api/v1/invoices', createInvoicesRouter(prisma));
app.use('/api/v1/payments', createPaymentsRouter(prisma));

// ─── Settings Domain Routers ──────────────────────────────────────────────────
app.use('/api/v1/settings/opportunity-types', createOpportunityTypesRouter(prisma));

// ─── Org Hierarchy Routers ────────────────────────────────────────────────────
app.use('/api/v1/departments', createDepartmentsRouter(prisma));
app.use('/api/v1/teams', createTeamsRouter(prisma));

// ─── Dashboard Router ─────────────────────────────────────────────────────────
import { createDashboardRouter } from './routes/dashboard.router';
app.use('/api/v1/dashboard', authMiddleware, createDashboardRouter(prisma));

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
app.use(Sentry.Handlers.errorHandler());

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const correlationId = getCorrelationId() ?? 'unknown';

  if (err instanceof AppException) {
    // Use logger.warn for expected business errors, not logger.error
    logger.warn({ err, correlationId, path: _req.path }, 'Application exception thrown');
    res.status(err.httpStatus).json({
      code: err.code,
      message: err.message,
      retryTag: err.retryTag,
      correlationId
    });
    return;
  }

  // logger.error for unexpected system failures
  logger.error({ err, correlationId, path: _req.path }, 'Unhandled application error');
  
  res.status(500).json({ 
    code: 'INTERNAL_ERROR', 
    message: 'An unexpected error occurred.',
    correlationId
  });
});

export default app;
