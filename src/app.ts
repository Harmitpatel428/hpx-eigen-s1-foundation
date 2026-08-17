import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { prisma } from './db';
import { AppException } from './types/exceptions';
import { correlationMiddleware } from './middleware/correlation.middleware';
import { authMiddleware } from './middleware/auth.middleware';
import { logger } from './utils/logger';
import { getCorrelationId } from './utils/requestContext';
// ─── Route Factories (S1) ─────────────────────────────────────────────────────
import { createAuthRouter } from './routes/auth.router';
import { createUsersRouter } from './routes/users.router';
import { createRolesRouter } from './routes/roles.router';
import { createSessionsRouter } from './routes/sessions.router';
import { createAuditRouter } from './routes/audit.router';

import { createNotificationsRouter } from './routes/notifications.router';

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
import { createCrmSettingsRouter } from './routes/crm-settings.router';

// ─── Route Factories (Org Hierarchy) ─────────────────────────────────────────
import { createDepartmentsRouter } from './routes/departments.router';
import { createTeamsRouter } from './routes/teams.router';

// ─── Route Factories (S4 Documentation Tracker) ───────────────────────────────
import { createDocumentationRouter } from './routes/documentation.router';

// ─── Route Factories (Lead Tags + Lead Contacts + Lead Fields + Lead Notes) ───
import { createLeadTagsRouter } from './routes/lead-tags.router';
import { createLeadContactsRouter } from './routes/lead-contacts.router';
import { createLeadFieldsRouter } from './routes/lead-fields.router';
import { createLeadNotesRouter } from './routes/lead-notes.router';
import { createLeadActivitiesRouter } from './routes/lead-activities.router';

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
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin) || (origin && /^https:\/\/hpx-eigen-frontend[^.]*\.vercel\.app$/.test(origin))) { callback(null, true); }
    else { callback(new Error('CORS: origin not allowed')); }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-tenant-id', 'x-department-id', 'x-department-context'],
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

app.use(express.json({ limit: '512kb' }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || 'local',
    version: process.env.npm_package_version || 'unknown',
  });
});

// ─── Domain Routers ───────────────────────────────────────────────────────────
app.use('/api/v1/auth', createAuthRouter(prisma));
app.use('/api/v1/users', createUsersRouter(prisma));
app.use('/api/v1/roles', createRolesRouter(prisma));
app.use('/api/v1/sessions', createSessionsRouter(prisma));
app.use('/api/v1/audit-logs', createAuditRouter(prisma));
app.use('/api/v1/notifications', createNotificationsRouter(prisma));

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
app.use('/api/v1/settings/crm', createCrmSettingsRouter(prisma));

// ─── Org Hierarchy Routers ────────────────────────────────────────────────────
app.use('/api/v1/departments', createDepartmentsRouter(prisma));
app.use('/api/v1/teams', createTeamsRouter(prisma));

// ─── S4 Documentation Tracker ─────────────────────────────────────────────────
app.use('/api/v1/documentation', createDocumentationRouter(prisma));

// ─── Lead Tags + Lead Contacts + Lead Notes ────────────────────────────────────
app.use('/api/v1/lead-tags', createLeadTagsRouter(prisma));
app.use('/api/v1/lead-fields', createLeadFieldsRouter(prisma));
app.use('/api/v1/leads/:leadId/contacts', createLeadContactsRouter(prisma));
app.use('/api/v1/leads/:leadId/notes', createLeadNotesRouter(prisma));
app.use('/api/v1/leads/:leadId/activities', createLeadActivitiesRouter(prisma));

// ─── Dashboard Router ─────────────────────────────────────────────────────────
import { createDashboardRouter } from './routes/dashboard.router';
app.use('/api/v1/dashboard', authMiddleware, createDashboardRouter(prisma));

// POST /api/invitations and POST /api/invitations/accept removed —
// superseded by POST /api/v1/users/invite and POST /api/v1/auth/accept-invite.
// The legacy paths had no permission gate (any authenticated user could invite)
// and no rate limiting — removed during invitation hardening audit.

// ─── Global Error Handler ─────────────────────────────────────────────────────
Sentry.setupExpressErrorHandler(app);

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
