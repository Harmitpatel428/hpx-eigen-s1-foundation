'use strict';
// Loaded before each test file — ensures .env.test overrides .env for test DATABASE_URL
try { require('dotenv').config({ path: '.env.test', override: true }); } catch (_) {}
try { require('dotenv').config(); } catch (_) {}

// Tests run Redis-free. The dev .env sets REDIS_URL so the server's public mandate
// endpoints have a live rate limiter, but under Jest that same value is poison:
// src/redis.ts holds a module-singleton client whose state (connection, circuit
// breaker, permission cache) persists across suites in --runInBand (no resetModules).
// A live client left an open socket that hung Jest ~2min per run and let one suite's
// cached permission manifest fail auth checks in a later suite (portal-activate).
// With REDIS_URL unset the rate limiters fail-open and the permission cache falls back
// to the DB — the intended, proven-green test behavior. Suites that specifically need
// Redis can set process.env.REDIS_URL themselves.
delete process.env.REDIS_URL;
