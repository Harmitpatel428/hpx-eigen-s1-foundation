/** Unit: Issue 4 — EmailService must be LOUD in production when Resend is unconfigured,
 *  and keep the dev action-link log otherwise. No real network/DB. */
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { emailService } from '../src/services/email.service';

const saved = { node: process.env.NODE_ENV, key: process.env.RESEND_API_KEY };

afterEach(() => {
  if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
  if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
  jest.restoreAllMocks();
});

describe('EmailService production config guard (Issue 4)', () => {
  it('logs a loud [EMAIL_CONFIG_ERROR] in production when the key is missing — never a silent skip', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await emailService.sendPasswordResetEmail('user@acme.test', 'tok-123');

    expect(err).toHaveBeenCalledWith(expect.stringContaining('[EMAIL_CONFIG_ERROR]'));
    // The raw reset URL/token must NOT leak via the dev log path in production.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('tok-123'));
  });

  it('logs the dev action link (not an error) outside production when unconfigured', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RESEND_API_KEY;
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});

    await emailService.sendPasswordResetEmail('user@acme.test', 'tok-123');

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[DEV MODE] Password Reset URL'));
    expect(err).not.toHaveBeenCalled();
  });
});
