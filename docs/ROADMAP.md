# Platform Foundation Roadmap (Phase 4 — plan only, not implemented)

Sequenced so the data is safe first, then correctness/integrity, then scale. Each item:
**why it exists** / **when to build it**. This is a plan, not a commitment to build all of it.

Grounding: prod is live with real clients but small (single-digit tenants). ORM Prisma 5.22 /
Postgres 16 on Render. Tenancy (tenant middleware + tenant-scoped repos), RBAC, hash-chained
`AuditLog`, and support impersonation **already exist**. Phase 1 durability guards are in
(see `RESTORE_RUNBOOK.md`). So the roadmap below is mostly *hardening what exists* + *filling
named gaps*, not greenfield.

---

## Tier 0 — Finish durability (do before anything else)
- **Verify Render PITR + off-site backups.** Recover from provider-side loss, not just local dumps. → **Now** (console task in runbook §5).
- **Managed-backup restore drill.** Prove the provider path, not only `pg_dump`. → **Now.**
- **Isolate the Neon `SHADOW_DATABASE_URL`.** `migrate dev` resets it; must never hold real data. → **Now.**

## Tier 1 — Correctness & isolation hardening (weeks)
- **Postgres Row-Level Security (RLS).** Defense-in-depth so a missing `tenantId` filter can't leak cross-tenant data. → **When** adding any raw-SQL/reporting path, or onboarding a second serious customer.
- **Automated cross-tenant isolation test.** Proves "Customer A can't read B" and stays proven in CI. → **Now-ish** (cheap, high value; pairs with RLS).
- **Expand/contract migration convention (Phase 2).** Zero-downtime, reversible schema changes; document + lint. → **Now-ish** (the guard exists; the convention doc doesn't).
- **Data-integrity reconciliation jobs.** Detect orphans / broken invariants (e.g. Opportunity without Lead) before they corrupt reports. → **When** first integrity bug appears in prod.

## Tier 2 — Financial & lifecycle integrity (weeks–months)
- **Financial ledger integrity.** Money as integer minor units / exact decimal, append-only ledger, no floats. `Opportunity.value` is already `Decimal(18,2)` — extend the discipline to any real billing. → **Before** charging money through the platform.
- **Billing / subscriptions / entitlements hardening.** Correct plan state, proration, dunning. → **When** billing goes live.
- **Entitlement engine (not `plan === 'pro'` checks).** Centralized feature gating that scales past ad-hoc conditionals. → **When** >~3 plans or per-feature limits exist.
- **Customer lifecycle state machine.** Explicit trial→active→past_due→churned transitions; no ambiguous states. → **With** billing.
- **Ban / suspension / enforcement state machine.** Deterministic suspend/restore; `UserStatus` enum already has SUSPENDED/TERMINATED — formalize the transitions. → **When** abuse or non-payment enforcement is needed.

## Tier 3 — Platform operations (months)
- **Background jobs / queue.** Reliable async (emails, reconciliation, exports) with retries. Redis already present. → **When** any task needs to outlive a request.
- **Event-driven architecture.** Decouple side-effects via domain events; audit already hints at this. → **When** side-effects multiply (defer until real pain).
- **Admin / control plane.** Safe internal ops (tenant management, feature flags) without raw DB access — the raw-access habit is what caused the original wipe. → **When** manual DB edits become routine.
- **Support impersonation hardening.** Exists; add scoped, time-boxed, fully-audited access. → **Incremental.**
- **Observability.** Sentry + pino exist; add structured request tracing, SLO alerts, migration/deploy alerts. → **Ongoing.**
- **Operational safety.** Runbooks, on-call, staged rollouts, deploy gates. → **Ongoing.**

## Tier 4 — Compliance, scale, cost (as demanded by customers/load)
- **Privacy / compliance.** Data-subject export/delete, consent, PII inventory. → **When** an enterprise/regulated customer requires it.
- **Retention policies.** Automatic purge/archive of soft-deleted rows + logs. `deletedAt` is everywhere; nothing purges yet. → **When** storage or compliance requires.
- **Files / object storage.** Move attachments off the DB to S3-class storage with signed URLs. → **When** file features ship.
- **Search / analytics separation.** Read replica or OLAP store so reporting doesn't hit the OLTP DB. → **When** analytics queries slow prod.
- **Caching.** Redis-backed read caches with explicit invalidation. → **When** measured read hotspots exist (not before).
- **HA / DR expansion.** Multi-AZ, replica failover, tested DR beyond backups. → **When** uptime SLA demands it.
- **Tenant isolation escalation.** shared-schema → schema-per-tenant → db-per-tenant for large/regulated customers. → **When** a customer's size or compliance forces it.
- **Scaling stages.** Vertical → read replicas → partitioning/sharding. → **Purely load-driven; don't pre-build.**

## Cross-cutting standards (adopt early, cheap)
- **Naming / database standards.** Consistent table/column/index conventions; documented. → **Now** (write the one-pager).
- **Testing strategy.** Unit + integration (real PG in CI, already present) + the isolation test + a restore-drill check. → **Grow with each tier.**

---

**Guiding rule:** don't pre-build scale/abuse/entitlement engines while the tenant count is tiny.
Build durability and correctness now; build the rest the first time real pain or a real customer
requirement appears.
