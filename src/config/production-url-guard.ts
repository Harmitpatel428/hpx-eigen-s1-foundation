/**
 * Boot-time guard against the classic production misconfiguration where a
 * client-facing base URL still points at the local dev server, so emailed
 * links (mandate upload, verify-email, password reset, invitations) are dead
 * for real recipients. In production we fail fast at startup rather than send
 * broken links.
 *
 * The check uses each variable's EFFECTIVE value — the env var or the same
 * localhost default the app falls back to — so an *unset* variable in
 * production trips the guard exactly like an explicit localhost value.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// name -> the localhost default the consuming code falls back to when unset.
const CLIENT_URL_VARS: Array<{ name: string; fallback: string }> = [
  { name: 'MANDATE_UPLOAD_BASE_URL', fallback: 'http://localhost:5173/mandate/upload' },
  { name: 'FRONTEND_URL', fallback: 'http://localhost:5173' },
];

/**
 * Throws in production if any client-facing base URL resolves to a localhost
 * host or is malformed. No-op outside production. Accepts an env object for
 * testability; defaults to process.env.
 */
export function assertClientUrlsNotLocalhost(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? 'development') !== 'production') return;

  for (const { name, fallback } of CLIENT_URL_VARS) {
    const value = env[name] || fallback;
    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      throw new Error(`[config] ${name} is not a valid URL in production: "${value}". Set it to the public base URL (e.g. https://hpxeigen.com).`);
    }
    if (LOCAL_HOSTS.has(host)) {
      throw new Error(`[config] ${name} points at a local host ("${value}") in production. Set ${name} to the public base URL (e.g. https://hpxeigen.com) so emailed links reach clients.`);
    }
  }
}
