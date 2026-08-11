'use strict';
// Loaded before each test file — ensures .env.test overrides .env for test DATABASE_URL
try { require('dotenv').config({ path: '.env.test', override: true }); } catch (_) {}
try { require('dotenv').config(); } catch (_) {}
