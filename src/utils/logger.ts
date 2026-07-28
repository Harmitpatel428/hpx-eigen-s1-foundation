import pino from 'pino';
import { getCorrelationId } from './requestContext';

// Determine log level from environment, default to 'info'. 
// In production, this should be 'info' or 'warn'.
const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  // The mixin runs synchronously on every log call.
  // It fetches the correlationId from AsyncLocalStorage automatically.
  mixin() {
    const correlationId = getCorrelationId();
    return correlationId ? { correlationId } : {};
  },
  // Redaction: Automatically remove sensitive data from log payloads
  // Prevents accidental leakage of PII or secrets to log aggregators.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.accessToken',
      '*.refreshToken',
      '*.ssn'
    ],
    censor: '[REDACTED]'
  },
  // In development, use pino-pretty for readability. 
  // In production, output raw JSON for log aggregators.
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  } : undefined,
});
