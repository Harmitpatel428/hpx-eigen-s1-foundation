import { assertClientUrlsNotLocalhost } from '../../src/config/production-url-guard';

// Build a production env with valid public URLs, then override per-case.
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({
    NODE_ENV: 'production',
    MANDATE_UPLOAD_BASE_URL: 'https://hpxeigen.com/mandate/upload',
    FRONTEND_URL: 'https://hpxeigen.com',
    ...over,
  } as NodeJS.ProcessEnv);

describe('assertClientUrlsNotLocalhost', () => {
  it('throws in production when MANDATE_UPLOAD_BASE_URL points at localhost', () => {
    expect(() =>
      assertClientUrlsNotLocalhost(env({ MANDATE_UPLOAD_BASE_URL: 'http://localhost:5173/mandate/upload' })),
    ).toThrow(/MANDATE_UPLOAD_BASE_URL/);
  });

  it('throws in production when FRONTEND_URL points at 127.0.0.1', () => {
    expect(() => assertClientUrlsNotLocalhost(env({ FRONTEND_URL: 'http://127.0.0.1:5173' }))).toThrow(
      /FRONTEND_URL/,
    );
  });

  it('throws in production when the variable is unset (falls back to the localhost default)', () => {
    expect(() => assertClientUrlsNotLocalhost(env({ MANDATE_UPLOAD_BASE_URL: undefined }))).toThrow(
      /MANDATE_UPLOAD_BASE_URL/,
    );
  });

  it('passes in production when both URLs use https://hpxeigen.com', () => {
    expect(() => assertClientUrlsNotLocalhost(env({}))).not.toThrow();
  });

  it('does not throw in development even with localhost URLs', () => {
    expect(() =>
      assertClientUrlsNotLocalhost(
        env({ NODE_ENV: 'development', MANDATE_UPLOAD_BASE_URL: 'http://localhost:5173/mandate/upload' }),
      ),
    ).not.toThrow();
  });

  it('throws in production on a malformed client URL', () => {
    expect(() => assertClientUrlsNotLocalhost(env({ FRONTEND_URL: 'not-a-url' }))).toThrow(/FRONTEND_URL/);
  });
});
