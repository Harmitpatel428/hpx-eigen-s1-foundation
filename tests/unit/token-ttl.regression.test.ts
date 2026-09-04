import * as fs from 'fs';
import * as path from 'path';

/**
 * reg #9 regression guard.
 * The access token was once signed with `${SESSION_LIFETIME_DAYS}d` (a multi-day token),
 * which both broke revocation and made the outage floor dishonest. This test fails if any
 * access-token signing site drifts above 15 minutes or reintroduces a day-based expiry.
 * Source-scan (no DB) so it runs in the fast unit lane.
 */
const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'auth.service.ts');
const src = fs.readFileSync(SRC, 'utf8');

/** minimal jwt-style duration → seconds */
function ttlSeconds(v: string): number {
  const m = v.trim().match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new Error(`unparseable ACCESS_TTL: ${v}`);
  const n = parseInt(m[1], 10);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
}

describe('access-token TTL (reg #9)', () => {
  it('never reintroduces a day-based access-token expiry', () => {
    // the exact bug: expiresIn tied to the session-day lifetime
    expect(src).not.toMatch(/expiresIn:\s*`?\$\{SESSION_LIFETIME_DAYS\}d`?/);
  });

  it('signs every access token from the single ACCESS_TTL constant', () => {
    const signExpiries = [...src.matchAll(/expiresIn:\s*([^\n}]+)/g)].map((m) => m[1].trim());
    expect(signExpiries.length).toBeGreaterThanOrEqual(2); // login + refresh
    for (const e of signExpiries) expect(e).toBe('ACCESS_TTL');
  });

  it('defaults ACCESS_TTL to <= 15 minutes', () => {
    const def = src.match(/ACCESS_TTL\s*=\s*\(?process\.env\.ACCESS_TTL\s*\?\?\s*'([^']+)'/);
    expect(def).not.toBeNull();
    expect(ttlSeconds(def![1])).toBeLessThanOrEqual(15 * 60);
  });
});
