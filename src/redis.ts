/**
 * Redis singleton — ioredis client with graceful fallback.
 *
 * If REDIS_URL is not set (local dev without Redis), all operations
 * become no-ops and the server continues using DB queries for permissions.
 */
import Redis from 'ioredis';

let _client: Redis | null = null;
let _unavailable = false;

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
  try {
    const client = getClient();
    if (!client) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

/** Set a string value with optional TTL in seconds. */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;
    if (ttlSeconds) {
      await client.set(key, value, 'EX', ttlSeconds);
    } else {
      await client.set(key, value);
    }
  } catch {
    // Non-fatal — cache write failure degrades to DB
  }
}

/** Atomically increment an integer key. Returns new value or null if unavailable. */
export async function redisIncr(key: string): Promise<number | null> {
  try {
    const client = getClient();
    if (!client) return null;
    return await client.incr(key);
  } catch {
    return null;
  }
}

/**
 * Key helpers — canonical Redis key schema.
 *
 * tenant:{tenantId}:perm_version                      → Integer counter
 * tenant:{tenantId}:user:{userId}:perms:v{version}    → JSON permission manifest
 */
export const redisKeys = {
  permVersion: (tenantId: string): string =>
    `tenant:${tenantId}:perm_version`,
  userPerms: (tenantId: string, userId: string, version: number): string =>
    `tenant:${tenantId}:user:${userId}:perms:v${version}`,
};
