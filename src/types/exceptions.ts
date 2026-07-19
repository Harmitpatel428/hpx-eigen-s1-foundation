export enum RetryTag {
  RETRYABLE = 'RETRYABLE',
  NON_RETRYABLE = 'NON_RETRYABLE',
  USER_ACTION_REQUIRED = 'USER_ACTION_REQUIRED'
}

export class AppException extends Error {
  constructor(
    public code: string,
    message: string,
    public retryTag: RetryTag,
    public httpStatus: number
  ) {
    super(message);
    this.name = 'AppException';
  }
}

export class ValidationError extends AppException {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, RetryTag.NON_RETRYABLE, 400);
  }
}

export class AuthenticationFailedError extends AppException {
  constructor() {
    super('AUTHENTICATION_FAILED', 'Email or password is incorrect.', RetryTag.USER_ACTION_REQUIRED, 401);
  }
}

export class AuthorizationError extends AppException {
  constructor() {
    super('AUTHORIZATION_ERROR', "You don't have permission.", RetryTag.NON_RETRYABLE, 403);
  }
}

export class SessionExpiredError extends AppException {
  constructor() {
    super('SESSION_EXPIRED', 'Your session expired. Please sign in again.', RetryTag.USER_ACTION_REQUIRED, 401);
  }
}

export class SessionRevokedError extends AppException {
  constructor() {
    super('SESSION_REVOKED', 'Session is no longer valid.', RetryTag.USER_ACTION_REQUIRED, 401);
  }
}

export class TenantNotFoundError extends AppException {
  constructor() {
    super('TENANT_NOT_FOUND', 'Organization not found.', RetryTag.NON_RETRYABLE, 404);
  }
}

export class ResourceNotFoundError extends AppException {
  constructor() {
    super('RESOURCE_NOT_FOUND', 'Requested resource was not found.', RetryTag.NON_RETRYABLE, 404);
  }
}

export class DuplicateResourceError extends AppException {
  constructor() {
    super('DUPLICATE_RESOURCE', 'Resource already exists.', RetryTag.NON_RETRYABLE, 409);
  }
}

export class OptimisticLockError extends AppException {
  constructor() {
    super('OPTIMISTIC_LOCK', 'Data changed. Retrying...', RetryTag.RETRYABLE, 409);
  }
}

export class DeadlockDetectedError extends AppException {
  constructor() {
    super('DEADLOCK_DETECTED', 'Temporary database conflict.', RetryTag.RETRYABLE, 503);
  }
}

export class DatabaseTimeoutError extends AppException {
  constructor() {
    super('DATABASE_TIMEOUT', 'Database temporarily busy.', RetryTag.RETRYABLE, 503);
  }
}

export class DatabaseConnectionError extends AppException {
  constructor() {
    super('DATABASE_CONNECTION', 'Service temporarily unavailable.', RetryTag.RETRYABLE, 503);
  }
}

export class RateLimitExceededError extends AppException {
  constructor() {
    super('RATE_LIMIT_EXCEEDED', 'Too many requests. Please wait.', RetryTag.RETRYABLE, 429);
  }
}

export class ExternalServiceTimeoutError extends AppException {
  constructor() {
    super('EXTERNAL_SERVICE_TIMEOUT', 'External service unavailable.', RetryTag.RETRYABLE, 504);
  }
}

export class ExternalServiceUnavailableError extends AppException {
  constructor() {
    super('EXTERNAL_SERVICE_UNAVAILABLE', 'Service temporarily unavailable.', RetryTag.RETRYABLE, 503);
  }
}

export class QueueUnavailableError extends AppException {
  constructor() {
    super('QUEUE_UNAVAILABLE', 'Background processing unavailable.', RetryTag.RETRYABLE, 503);
  }
}

export class TemporaryServiceError extends AppException {
  constructor() {
    super('TEMPORARY_SERVICE_ERROR', 'Temporary problem. Retrying.', RetryTag.RETRYABLE, 503);
  }
}

export class ConflictError extends AppException {
  constructor() {
    super('CONFLICT', 'Refresh and try again.', RetryTag.USER_ACTION_REQUIRED, 409);
  }
}

export class BusinessRuleViolationError extends AppException {
  constructor() {
    super('BUSINESS_RULE_VIOLATION', 'Operation is not allowed.', RetryTag.NON_RETRYABLE, 422);
  }
}

export class DataIntegrityError extends AppException {
  constructor() {
    super('DATA_INTEGRITY', 'Data consistency error.', RetryTag.NON_RETRYABLE, 500);
  }
}

export class AuditWriteFailureError extends AppException {
  constructor() {
    super('AUDIT_WRITE_FAILURE', 'Operation temporarily unavailable.', RetryTag.RETRYABLE, 503);
  }
}
