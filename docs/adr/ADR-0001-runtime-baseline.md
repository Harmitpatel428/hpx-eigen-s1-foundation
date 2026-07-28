# ADR-0001: Backend Runtime Infrastructure Baseline

**Title:** Backend Runtime Infrastructure Baseline
**Status:** Accepted
**Date:** 2026-07-28

## Decision

The HPX Eigen backend runtime adopts the following architectural components as its stable infrastructure baseline:

- **Explicit HTTP Server Lifecycle:** Instantiating the Node `http.Server` explicitly instead of relying on implicit Express `app.listen()` behavior.
- **Structured Logging:** Replacing `console.log` with Pino-based structured JSON logging for all environments, providing predictable log shapes and redaction support.
- **Request Correlation:** Leveraging `AsyncLocalStorage` to inject and propagate a unique `x-correlation-id` throughout the lifecycle of every incoming request.
- **Graceful Shutdown:** Explicitly trapping `SIGINT` and `SIGTERM` process signals to gracefully tear down the HTTP server, disconnect from Prisma (database), and disconnect from Redis before exiting.
- **Centralized Runtime Fault Handling:** Setting up unhandled barriers (`uncaughtException`, `unhandledRejection`) and a unified Express error middleware that correlates failures back to specific trace IDs without leaking system internals.

## Consequences

- **Stability:** The application startup and shutdown are now deterministic, preventing hanging ports (`EADDRINUSE`) or orphaned database connections during orchestrator rolling updates.
- **Observability:** Logs can be securely ingested by aggregators and traced end-to-end.
- **Development Constraint:** Future feature development must build on this runtime layer without reintroducing implicit startup/shutdown behaviors or unstructured logging. Application layers (Auth, RBAC, CRM, Workflows) should assume this baseline is present and rely on it.
