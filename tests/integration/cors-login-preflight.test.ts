/**
 * CORS contract for cross-origin login (P0 remediation).
 *
 * The frontend sends `X-Correlation-ID` on every request (see
 * src/middleware/correlation.middleware.ts). The backend's CORS
 * `allowedHeaders` list must include it, or the browser's preflight for a
 * cross-origin POST /auth/login blocks the real request before it is sent.
 *
 * This uses the REAL app (src/app.ts), not a minimal router-only test app,
 * because the bug lives in `corsOptions` on the app itself.
 */
import 'dotenv/config';
import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as http from 'http';
import app from '../../src/app';
import { prisma } from '../../src/db';

let server: http.Server;
let baseUrl: string;

const ORIGIN = 'https://hpxeigen.com'; // in allowedOrigins (src/app.ts)

beforeAll(async () => {
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

describe('CORS — cross-origin login', () => {
  it('preflight OPTIONS /auth/login allows x-correlation-id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, x-correlation-id, content-type',
      },
    });

    expect(res.status).toBe(204);
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowHeaders).toContain('x-correlation-id');
  });

  it('a garbage-Bearer cross-origin login POST still carries Access-Control-Allow-Origin on the 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Authorization: 'Bearer garbage.stale.token',
        'X-Correlation-ID': 'test-cid',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
    });

    // Wrong creds are expected to fail auth — the point is CORS headers survive that.
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
