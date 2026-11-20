/**
 * Strong-password policy for admin-set and self-set passwords.
 *
 * Deliberately stricter than the legacy inline `length < 8` checks on the
 * signup/self-reset paths: an admin setting a colleague's password is a
 * higher-trust action, so we require real complexity and reject passwords
 * derived from the target's own identity (email/name) — the first thing an
 * attacker (or a lazy admin) would try.
 *
 * Returns the first failure message, or `null` when the password is acceptable.
 * Pure + dependency-free so it is unit-testable without a DB (see
 * tests/password-policy.test.ts).
 */

const MIN_LENGTH = 12;
// bcrypt silently truncates at 72 BYTES — anything longer collides on the first 72. Cap at 72 so
// the stored hash always covers the whole password the user typed.
// ponytail: cap is on character count (matches the user-facing message); a 72-char multibyte
// password can still exceed 72 bytes — switch to Buffer.byteLength only if multibyte passwords matter.
const MAX_LENGTH = 72;

export interface PasswordIdentity {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Identity tokens a password must not contain (lowercased, length ≥ 3 to avoid trivial substrings). */
function identityTokens(id: PasswordIdentity): string[] {
  const tokens: string[] = [];
  const localPart = id.email?.split('@')[0];
  for (const raw of [id.email, localPart, id.firstName, id.lastName]) {
    const t = (raw ?? '').trim().toLowerCase();
    if (t.length >= 3) tokens.push(t);
  }
  return tokens;
}

export function validatePasswordStrength(password: unknown, identity: PasswordIdentity = {}): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Password must not exceed ${MAX_LENGTH} characters.`;

  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol.';

  const lower = password.toLowerCase();
  for (const token of identityTokens(identity)) {
    if (lower.includes(token)) return 'Password must not contain your name or email.';
  }
  return null;
}
