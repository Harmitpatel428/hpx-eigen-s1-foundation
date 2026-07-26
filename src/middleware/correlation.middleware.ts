import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

/**
 * Correlation Middleware
 * Ensures every incoming request has an X-Correlation-ID header.
 * This ID is later bound to the RequestContext in auth.middleware.ts.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  let correlationId = req.headers['x-correlation-id'] as string;
  
  if (!correlationId) {
    correlationId = crypto.randomUUID();
    req.headers['x-correlation-id'] = correlationId;
  }
  
  // Attach it to the response as well so clients can track the request
  res.setHeader('X-Correlation-ID', correlationId);
  
  next();
}
