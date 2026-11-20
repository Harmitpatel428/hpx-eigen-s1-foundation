/** Unit: strong-password policy (pure, no DB). Issue 3 — admin set-password validation. */
import { describe, it, expect } from '@jest/globals';
import { validatePasswordStrength } from '../src/domain/password-policy';

const id = { email: 'jane.doe@acme.test', firstName: 'Jane', lastName: 'Doe' };

describe('validatePasswordStrength', () => {
  it('accepts a strong password unrelated to the identity (incl. the 72-char boundary)', () => {
    expect(validatePasswordStrength('Str0ng!Passw0rd', id)).toBeNull();
    expect(validatePasswordStrength('Aa1!' + 'x'.repeat(68), id)).toBeNull(); // exactly 72
  });

  it('rejects too-short and over-72 passwords (bcrypt truncates past 72 bytes)', () => {
    expect(validatePasswordStrength('Ab1!xyz', id)).toMatch(/at least 12/);
    expect(validatePasswordStrength('Aa1!' + 'x'.repeat(69), id)).toMatch(/72/); // 73 chars → rejected
  });

  it('requires every character class', () => {
    expect(validatePasswordStrength('alllowercase1!', id)).toMatch(/uppercase/);
    expect(validatePasswordStrength('ALLUPPERCASE1!', id)).toMatch(/lowercase/);
    expect(validatePasswordStrength('NoDigitsHere!!', id)).toMatch(/number/);
    expect(validatePasswordStrength('NoSymbol1234AB', id)).toMatch(/symbol/);
  });

  it('rejects passwords containing the name or email', () => {
    expect(validatePasswordStrength('Janexyz1234!AB', id)).toMatch(/name or email/i);
    expect(validatePasswordStrength('Xjane.doe9!ABc', id)).toMatch(/name or email/i);
  });

  it('rejects non-string input', () => {
    expect(validatePasswordStrength(undefined, id)).toMatch(/required/);
    expect(validatePasswordStrength(12345678 as unknown, id)).toMatch(/required/);
  });
});
