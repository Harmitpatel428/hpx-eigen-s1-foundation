/**
 * Phone normalization for Indian numbers.
 *
 * Rule: strip non-digits → if 12 digits starting with 91 → slice to 10 →
 * if result < 6 digits → null (malformed). Original always preserved separately.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }
  return digits.length >= 6 ? digits : null;
}

/**
 * Returns true if the search term looks like a phone number (>=6 digits after stripping).
 */
export function isPhoneLikeTerm(term: string): boolean {
  const digits = term.replace(/\D/g, '');
  return digits.length >= 6;
}
