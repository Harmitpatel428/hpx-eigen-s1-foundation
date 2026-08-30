/**
 * Public case identifier: HPX-XXXX-XXXX.
 *
 * The alphabet deliberately omits I, O, 0, 1 so a client reading the ID off a
 * screen or over the phone cannot produce an ambiguous transcription.
 */
import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars — no I, O, 0, 1
const CASE_NUMBER_REGEX = /^HPX-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export function isValidCaseNumber(value: string): boolean {
  return CASE_NUMBER_REGEX.test(value.toUpperCase());
}

/** Normalise loose user input (lowercase, missing dashes, spaces) to canonical form. */
export function normaliseCaseNumber(raw: string): string {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = stripped.startsWith('HPX') ? stripped.slice(3) : stripped;
  const seg1 = body.slice(0, 4);
  const seg2 = body.slice(4, 8);
  if (!seg1) return 'HPX';
  if (!seg2) return `HPX-${seg1}`;
  return `HPX-${seg1}-${seg2}`;
}

/**
 * Generate a case number using a CSPRNG with rejection sampling.
 *
 * `crypto.randomInt(0, 32)` is uniform over the alphabet — using `% 32` on a
 * byte would bias the first 8 characters, which matters here because the ID is
 * one of two authentication factors for the client portal.
 */
export function generateCaseNumber(): string {
  const seg = (n: number) =>
    Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
  return `HPX-${seg(4)}-${seg(4)}`;
}

/** Digits-only last 4 of a phone number, for portal verification. */
export function phoneLast4(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4);
}

/** Normalise a phone to digits for comparison — ignores formatting differences. */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}
