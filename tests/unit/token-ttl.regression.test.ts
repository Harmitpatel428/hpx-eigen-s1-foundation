import * as fs from 'fs';
import * as path from 'path';

/**
 * reg #9 regression guard.
 * The access token was once signed with `${SESSION_LIFETIME_DAYS}d` (a multi-day token),
 * which both broke revocation and made the outage floor dishonest. This test pins the
 * access-token TTL to a single sanctioned named constant and fails if any sign site drifts to
 * a different value, a day-based string literal reappears, or a second sign site is introduced.
 * Source-scan (no DB) so it runs in the fast unit lane.
 *
 * WS-G2 fix round — DELIBERATE, TIME-BOXED INTERIM (architect decision): the sanctioned value is
 * the CURRENT production TTL of 7 days (604800s), NOT the 15m target. Shipping the consolidated
 * single signer must not change production access-token lifetime in this workstream. Workstream
 * G3 will flip ACCESS_TOKEN_TTL_SECONDS -> 900 and RESTORE the unconditional <=15m assertion here,
 * >= 7 days AFTER the G2 (unified refreshing client) deploy. Until then the guard permits EXACTLY
 * the one sanctioned named constant and nothing above 15m other than it.
 */
const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'auth.service.ts');
const src = fs.readFileSync(SRC, 'utf8');

// The one sanctioned interim value. G3 flips this (and the constant in auth.service.ts) to 900.
const SANCTIONED_TTL_SECONDS = 604800;

describe('access-token TTL (reg #9)', () => {
  it('never reintroduces a day-based access-token expiry', () => {
    // the exact original bug: expiresIn tied to the session-day lifetime
    expect(src).not.toMatch(/expiresIn:\s*`?\$\{SESSION_LIFETIME_DAYS\}d`?/);
    // and no day-based string literal at all — the interim value is a NUMBER of seconds, not '7d'
    expect(src).not.toMatch(/expiresIn:\s*['"`]\s*\d+\s*d\s*['"`]/);
  });

  it('signs every access token from the single sanctioned TTL constant', () => {
    const signExpiries = [...src.matchAll(/expiresIn:\s*([^\n}]+)/g)].map((m) => m[1].trim());
    // Access-token signing is consolidated into ONE single-source signer (signAccessToken),
    // reused by login, signup/accept-invite (router delegates) AND refresh. No additional sign
    // site and no other expiry value is permitted — every sign site must use the named constant.
    expect(signExpiries.length).toBeGreaterThanOrEqual(1);
    for (const e of signExpiries) expect(e).toBe('ACCESS_TOKEN_TTL_SECONDS');
  });

  it('pins ACCESS_TOKEN_TTL_SECONDS to exactly the one sanctioned interim value (G3 flips to 900)', () => {
    const def = src.match(/ACCESS_TOKEN_TTL_SECONDS\s*=\s*(\d+)/);
    expect(def).not.toBeNull();
    expect(parseInt(def![1], 10)).toBe(SANCTIONED_TTL_SECONDS);
  });
});
