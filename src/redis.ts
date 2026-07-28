/**
 * Redis singleton — ioredis client with graceful fallback.
 *
 * If REDIS_URL is not set (local dev without Redis), all operations
 * become no-ops and the server continues using DB queries for permissions.
 */
import Redis from 'ioredis';

let _client: Redis | null = null;
let _unavailable = false;

enum CircuitState {
  CLOSED,
  OPEN,
  HALF_OPEN
}

let circuitState: CircuitState = CircuitState.CLOSED;
let consecutiveFailureCount = 0;
let lastFailureTime = 0;
let halfOpenTestInProgress = false;

const FAILURE_THRESHOLD = parseInt(process.env.REDIS_CIRCUIT_FAILURE_THRESHOLD || '5', 10);
const RESET_MS = parseInt(process.env.REDIS_CIRCUIT_RESET_MS || '30000', 10);

function checkCircuit(): boolean {
  if (circuitState === CircuitState.CLOSED) return true;

  if (circuitState === CircuitState.OPEN) {
    if (Date.now() - lastFailureTime > RESET_MS) {
      circuitState = CircuitState.HALF_OPEN;
      process.stderr.write('[Redis:CIRCUIT_OPEN -> HALF_OPEN] Probing Redis availability...\n');
      return true;
    }
    return false;
  }

  if (circuitState === CircuitState.HALF_OPEN) {
    if (halfOpenTestInProgress) {
      return false; // Only allow one test request through
    }
    halfOpenTestInProgress = true;
    return true;
  }

  return false;
}

function recordSuccess() {
  consecutiveFailureCount = 0;
  if (circuitState === CircuitState.HALF_OPEN) {
    circuitState = CircuitState.CLOSED;
    halfOpenTestInProgress = false;
    process.stderr.write('[Redis:HALF_OPEN -> CLOSED] Redis recovered.\n');
  }
}

function recordFailure(err: unknown) {
  consecutiveFailureCount++;
  lastFailureTime = Date.now();
  
  if (circuitState === CircuitState.HALF_OPEN) {
    circuitState = CircuitState.OPEN;
    halfOpenTestInProgress = false;
    process.stderr.write(`[Redis:HALF_OPEN -> OPEN] Probe failed: ${(err as Error).message}\n`);
  } else if (circuitState === CircuitState.CLOSED && consecutiveFailureCount >= FAILURE_THRESHOLD) {
    circuitState = CircuitState.OPEN;
    process.stderr.write(`[Redis:CIRCUIT_OPEN] Threshold reached (${FAILURE_THRESHOLD} failures). Circuit tripped.\n`);
  }
}

function getClient(): Redis | null {
  if (_unavailable) return null;
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    process.stderr.write('[Redis] REDIS_URL not set — permission cache disabled, falling back to DB\n');
    _unavailable = true;
    return null;
  }

  try {
    _client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });

    _client.on('error', (err: Error) => {
      process.stderr.write(`[Redis] Connection error: ${err.message}\n`);
    });

    return _client;
  } catch (err) {
    process.stderr.write(`[Redis] Failed to create client: ${(err as Error).message}\n`);
    _unavailable = true;
    return null;
  }
}

/** Get a string value. Returns null on cache miss or unavailable Redis. */
export async function redisGet(key: string): Promise<string | null> {
  if (!checkCircuit()) return null;
  try {
    const client = getClient();
    if (!client) return null;
    const result = await client.get(key);
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure(err);
    return null;
  }
}

/** Set a string value with optional TTL in seconds. */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (!checkCircuit()) return;
  try {
    const client = getClient();
    if (!client) return;
    if (ttlSeconds) {
      await client.set(key, value, 'EX', ttlSeconds);
    } else {
      await client.set(key, value);
    }
    recordSuccess();
  } catch (err) {
    recordFailure(err);
  }
}

/** Delete a key. Returns number of keys deleted or null on failure. */
export async function redisDel(key: string): Promise<number | null> {
  if (!checkCircuit()) return null;
  try {
    const client = getClient();
    if (!client) return null;
    const result = await client.del(key);
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure(err);
    return null;
  }
}

/** Atomically increment an integer key. Returns new value or null if unavailable. */
export async function redisIncr(key: string): Promise<number | null> {
  if (!checkCircuit()) return null;
  try {
    const client = getClient();
    if (!client) return null;
    const result = await client.incr(key);
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure(err);
    return null;
  }
}

/**
 * Key helpers — canonical Redis key schema.
 *
 * perm:manifest:{userId}                              → JSON permission manifest (direct, no version indirection)
 * tenant:{tenantId}:perm_version                      → Integer counter (legacy v1 path)
 * tenant:{tenantId}:user:{userId}:perms:v{version}    → JSON permission manifest (legacy v1 path)
 * session:active:{sessionId}                          → Active session tracker (15m TTL)
 */
export const redisKeys = {
  /** Direct per-user manifest key — invalidated synchronously via DEL on role changes. */
  userManifest: (userId: string): string =>
    `perm:manifest:${userId}`,
  permVersion: (tenantId: string): string =>
    `tenant:${tenantId}:perm_version`,
  userPerms: (tenantId: string, userId: string, version: number): string =>
    `tenant:${tenantId}:user:${userId}:perms:v${version}`,
  sessionActive: (sessionId: string): string =>
    `session:active:${sessionId}`,
};

export async function redisClose(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
