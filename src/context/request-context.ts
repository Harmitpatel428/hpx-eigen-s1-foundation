import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  identityId: string;
  membershipId: string;
  tenantId: string;
  sessionId: string;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
  requestedAt: Date;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext {
  const store = requestContextStorage.getStore();
  if (!store) {
    throw new Error('CONTEXT_NOT_BOUND');
  }
  return store;
}
