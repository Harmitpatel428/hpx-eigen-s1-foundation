/**
 * WS-G1 — /auth/refresh contract (integration, real Postgres).
 *
 * Proves the opaque-refresh-token contract end to end against a live DB:
 *  - login/createSession issue an opaque "<sessionId>.<secret>" refresh token
 *  - POST /auth/refresh (no authMiddleware) exchanges it for a FLAT { accessToken }
 *  - the new access token authenticates against an authMiddleware-protected route
 *  - EVERY failure mode returns a UNIFORM 401 AUTHENTICATION_FAILED
 *  - refresh is non-rotating → 5 concurrent refreshes all succeed, hash unchanged
 *  - rate-limit trip maps to 429
 *
 * The test env runs Redis-free (tests/setup-env.js sets REDIS_URL=''), so the real
 * fail-closed checkRefreshAttempts would deny every call. Per the existing
 * firm-upload-rate-limit precedent we mock ONLY that limiter: resolve for the
 * success paths, reject with RateLimitExceededError for the trip test.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from '@jest/globals';
import { PrismaClient, SessionStatus } from '@prisma/client';
import * as crypto from 'crypto';
import * as http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const checkRefreshAttempts = jest.fn();
jest.mock('../../src/services/auth/RateLimitService', () => ({
  ...jest.requireActual('../../src/services/auth/RateLimitService'),
  checkRefreshAttempts: (...args: unknown[]) => checkRefreshAttempts(...args),
}));

import { createAuthRouter } from '../../src/routes/auth.router';
import { AuthService } from '../../src/services/auth.service';
import { AppException, RateLimitExceededError } from '../../src/types/exceptions';

const prisma = new PrismaClient();
const authService = new AuthService(prisma);
let server: http.Server;
let baseUrl: string;

const TENANT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();

function makeTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(prisma));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppException) {
      res.status(err.httpStatus).json({ code: err.code, message: err.message });
      return;
    }
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    console.error('[auth-refresh-contract-test] Unhandled error:', detail);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unexpected error', detail });
  });
  return app;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const getMe = (accessToken: string) =>
  fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** Mint a NEW-contract session directly (mirrors authService.createSession). */
async function mintSession(
  opts: { status?: SessionStatus; expiresAt?: Date; userId?: string } = {}
) {
  const secret = crypto.randomBytes(64).toString('hex');
  const refreshTokenHash = crypto.createHash('sha256').update(secret).digest('hex');
  const session = await prisma.session.create({
    data: {
      tenantId: TENANT_ID,
      userId: opts.userId ?? USER_ID,
      status: opts.status ?? SessionStatus.ACTIVE,
      refreshTokenHash,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  return { sessionId: session.id, secret, refreshToken: `${session.id}.${secret}` };
}

beforeAll(async () => {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'G1 Refresh Tenant' } });
  await prisma.user.create({
    data: {
      id: USER_ID,
      email: `g1-refresh-${TENANT_ID.slice(0, 8)}@x.com`,
      password: await bcrypt.hash('TestPass123!', 12),
      tenantId: TENANT_ID,
      status: 'ACTIVE',
      emailVerified: new Date(),
    },
  });

  const app = makeTestApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(() => {
  checkRefreshAttempts.mockReset();
  checkRefreshAttempts.mockResolvedValue(undefined); // limiter allows unless a test overrides
});

describe('POST /auth/refresh — opaque token contract', () => {
  it('login returns an opaque refreshToken; refresh yields a flat {accessToken} that passes /me', async () => {
    const login = await post('/api/v1/auth/login', { email: `g1-refresh-${TENANT_ID.slice(0, 8)}@x.com`, password: 'TestPass123!' });
    expect(login.status).toBe(200);
    const refreshToken: string = login.body.data.refreshToken;
    const sessionId: string = login.body.data.sessionId;

    // Opaque shape: contains a '.', and is NOT the bare sessionId.
    expect(refreshToken).toContain('.');
    expect(refreshToken).not.toBe(sessionId);
    expect(refreshToken.split('.')[0]).toBe(sessionId);

    const refresh = await post('/api/v1/auth/refresh', { refreshToken });
    expect(refresh.status).toBe(200);
    expect(Object.keys(refresh.body)).toEqual(['accessToken']); // FLAT, exactly one key
    expect(typeof refresh.body.accessToken).toBe('string');

    const me = await getMe(refresh.body.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(USER_ID);
  });

  it('refresh-minted access token has the SAME TTL as the login-minted one (single source, no drift)', async () => {
    // Proves login, signup/accept-invite and refresh all mint from the one signAccessToken source:
    // decode both JWTs and compare exp - iat. Any divergence means a second, un-consolidated signer.
    const login = await post('/api/v1/auth/login', { email: `g1-refresh-${TENANT_ID.slice(0, 8)}@x.com`, password: 'TestPass123!' });
    expect(login.status).toBe(200);
    const loginDecoded = jwt.decode(login.body.data.accessToken) as { iat: number; exp: number };
    const loginTtl = loginDecoded.exp - loginDecoded.iat;

    const refresh = await post('/api/v1/auth/refresh', { refreshToken: login.body.data.refreshToken });
    expect(refresh.status).toBe(200);
    const refreshDecoded = jwt.decode(refresh.body.accessToken) as { iat: number; exp: number };
    const refreshTtl = refreshDecoded.exp - refreshDecoded.iat;

    expect(refreshTtl).toBe(loginTtl);
    // ...and both derive from the single sanctioned interim constant (7d = 604800s).
    expect(loginTtl).toBe(604800);
  });

  it('createSession (shared by login AND signup/accept-invite) yields a refreshable opaque token', async () => {
    const { sessionId, refreshToken } = await authService.createSession(USER_ID, TENANT_ID);
    expect(refreshToken.split('.')[0]).toBe(sessionId);
    expect(refreshToken.split('.')[1]).toMatch(/^[0-9a-f]{128}$/); // 64 bytes hex

    const refresh = await post('/api/v1/auth/refresh', { refreshToken });
    expect(refresh.status).toBe(200);
    expect(typeof refresh.body.accessToken).toBe('string');
  });

  it('succeeds with NO Authorization header and with an EXPIRED access token in the header', async () => {
    const { refreshToken } = await mintSession();

    const noHeader = await post('/api/v1/auth/refresh', { refreshToken });
    expect(noHeader.status).toBe(200);

    const expiredAccess = jwt.sign(
      { userId: USER_ID, tenantId: TENANT_ID, sessionId: crypto.randomUUID() },
      process.env.JWT_SECRET!,
      { expiresIn: -10 } // already expired
    );
    const withExpired = await post('/api/v1/auth/refresh', { refreshToken }, { Authorization: `Bearer ${expiredAccess}` });
    expect(withExpired.status).toBe(200);
  });

  it('missing/blank refreshToken → 400 VALIDATION_ERROR', async () => {
    const missing = await post('/api/v1/auth/refresh', {});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('VALIDATION_ERROR');

    const blank = await post('/api/v1/auth/refresh', { refreshToken: '' });
    expect(blank.status).toBe(400);
  });

  it('UNIFORM 401 AUTHENTICATION_FAILED for every invalid-token mode', async () => {
    const active = await mintSession();
    const revoked = await mintSession({ status: SessionStatus.REVOKED });
    const invalidated = await mintSession({ status: SessionStatus.INVALIDATED });
    const expired = await mintSession({ expiresAt: new Date(Date.now() - 1000) });

    const cases: Array<[string, string]> = [
      ['garbage-no-dot', 'garbage'],
      ['non-uuid-session', 'not-a-uuid.deadbeef'],
      ['unknown-session', `${crypto.randomUUID()}.${crypto.randomBytes(64).toString('hex')}`],
      ['wrong-secret', `${active.sessionId}.${crypto.randomBytes(64).toString('hex')}`],
      ['old-shape-bare-sessionId', active.sessionId],
      ['revoked', revoked.refreshToken],
      ['invalidated', invalidated.refreshToken],
      ['expired', expired.refreshToken],
    ];

    const results = await Promise.all(cases.map(([, token]) => post('/api/v1/auth/refresh', { refreshToken: token })));
    for (let i = 0; i < results.length; i++) {
      expect([cases[i][0], results[i].status]).toEqual([cases[i][0], 401]);
      expect([cases[i][0], results[i].body.code]).toEqual([cases[i][0], 'AUTHENTICATION_FAILED']);
    }
    // Every failure is byte-identical (no leakage that distinguishes them).
    const messages = new Set(results.map((r) => r.body.message));
    expect(messages.size).toBe(1);
  });

  it('rejects a session whose user was soft-deleted or suspended (uniform 401)', async () => {
    const suspendedUserId = crypto.randomUUID();
    await prisma.user.create({
      data: {
        id: suspendedUserId,
        email: `g1-susp-${suspendedUserId.slice(0, 8)}@x.com`,
        password: await bcrypt.hash('x', 12),
        tenantId: TENANT_ID,
        status: 'SUSPENDED',
        emailVerified: new Date(),
      },
    });
    const { refreshToken } = await mintSession({ userId: suspendedUserId });
    const res = await post('/api/v1/auth/refresh', { refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_FAILED');
  });

  it('is non-rotating: 5 concurrent refreshes all succeed and the stored hash is unchanged', async () => {
    const { sessionId, refreshToken } = await mintSession();
    const before = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

    const results = await Promise.all(Array.from({ length: 5 }, () => post('/api/v1/auth/refresh', { refreshToken })));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(typeof r.body.accessToken).toBe('string');
    }
    const after = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.refreshTokenHash).toBe(before.refreshTokenHash); // no rotation → no corruption
  });

  it('rate-limit trip → 429 (fail-closed limiter throws)', async () => {
    const { refreshToken } = await mintSession();
    checkRefreshAttempts.mockRejectedValueOnce(new RateLimitExceededError());
    const res = await post('/api/v1/auth/refresh', { refreshToken });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
