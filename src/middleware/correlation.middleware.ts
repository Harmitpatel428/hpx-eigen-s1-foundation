import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext } from '../utils/requestContext';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.headers[CORRELATION_ID_HEADER] as string | undefined;
  let correlationId: string;
  
  if (incomingId && UUID_V4_REGEX.test(incomingId)) {
    correlationId = incomingId;
  } else {
    correlationId = randomUUID();
    req.headers[CORRELATION_ID_HEADER] = correlationId;
  }
  
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  
  requestContext.run({ correlationId }, () => {
    next();
  });
}
