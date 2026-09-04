# Architecture Decisions (ADR Trail)

In-repo source of truth for the frozen, adversarially-reviewed platform architecture (22 phases).
Execution is tracked in [`HONESTY_REGISTER.md`](../../HONESTY_REGISTER.md) and
[`HUMAN_TASKS.md`](../../HUMAN_TASKS.md). This document is a **map** — the repo, the CI checks, and
the register are the territory; where they disagree, they win.

## Priority order (resolve every conflict with this)
correctness → security → tenant isolation → data integrity → billing integrity → recoverability →
observability → scalability → performance.

## Why this exists
Production was once wiped by a destructive Prisma command (`db push` / `migrate reset`) run with a
single all-powerful `DATABASE_URL`, with no backup. Data-loss prevention is a precondition, not a
phase.

---

## Superseded decisions (corrections in the trail — kept visible on purpose)
| Was | Now | Why |
|-----|-----|-----|
| `app.bypass` GUC OR-clause in RLS | `hpx_elevated` / BYPASSRLS role | a settable GUC is forgeable via SQLi as `hpx_app` — upgraded any injection to platform-wide |
| 15-minute auth outage floor | ~60-second floor | the gate is the fail-closed session-validation cache (≤60s), not the access-token TTL |
| hand-listed grant matrix | generated from `pg_tables` | a hand list silently omits new tables — the highest-risk rows |
| rename `tenant_id` → `organization_id` | keep physical `tenant_id` | a 40-table live rename is high-risk churn for zero functional gain; "Organization" is the domain term |
| op-switching extension (update→updateMany) | same-op where-rewrite via `(tenant_id, id)` | re-routing broke nested writes, double round-trips, non-atomic upsert |

---

## ADR trail (decision + alternatives rejected)

**P0 — Credential split.** App connects as `hpx_app` (no DDL); migrations run only as
`hpx_migrator` in CI. `db push`/`migrate reset` become impossible with app creds — enforced by
Postgres, not a script. *Rejected:* script guards alone (a human with the URL still holds a loaded
gun); one role + discipline (the incident). *Reverse:* one `GRANT`.

**P1 — Tenancy.** Organization = tenant root (physical `tenant_id`); Identity/Membership split from
the org; BillingAccount separate (1→many orgs); Accounts/Workspaces `[LATER]` behind metric
triggers. *Rejected:* flat Tenant (can't express multi-org humans / agency billing); DB-per-tenant
(premature, #17).

**P2 — Database.** UUIDv7 (app-generated `newId()`) for new tables, v4 kept for existing; composite
`(tenant_id, id)` FKs; RESTRICT default, no cascade into financial/audit; money `NUMERIC(19,4)` +
currency, no floats; soft-delete via partial unique indexes. *Rejected:* BIGSERIAL (enumeration);
mass v7 rekey of a live financial DB; integer minor-units (per-currency exponent table + migration).

**P3 — Multi-tenancy & isolation (six layers).** NOT NULL `tenant_id` → composite FK → RLS keyed to
a **transaction-local** GUC → DMMF-derived data layer → ALS context → tenant-prefixed
cache/storage/queue keys. `FORCE ROW LEVEL SECURITY`. *Rejected:* app-filtering only (fail-open);
per-tenant schemas (premature). *Depends on P0:* a table owner silently bypasses RLS, so hpx_app
being a non-owner is the precondition that makes policies real.

**P4 — Identity & access.** Global Identity + per-org Membership; argon2id; deny-by-default,
precedence explicit-deny > allow, one evaluation site, version-cached. *Rejected:* fused user
(blocks SSO/multi-org, forces credential duplication — evidenced); most-specific-wins.

**P5 — Lifecycle state machines (13).** Single-writer rule — each status column owned by one
service; others emit domain events consumed via `recomputeOrgStatus` (multi-cause recompute).
`isActive` deleted. *Rejected:* boolean lifecycle flags (#4); org `TRIAL` status (derived); org
`BANNED` status (equivalence via enforcement_action).

**P6 — Enforcement.** One `enforcement_action` model (restrictions AND bans); reversibility =
close, never delete; automated ⇒ `rule_id` AND `evidence_ref` (CHECK). *Rejected:* separate
ban/restriction tables; ad-hoc `suspendedAt` fields (V9).

**P7 — Billing & financial integrity.** Separate `billing_account`; double-entry append-only
ledger, balances = SUM; idempotency at PSP-intent AND webhook layers; entitlement resolution
composing enforcement → permission → entitlement (blocked beats entitled). *Rejected:* mutable
balance (#8); `plan`-string checks (#5); single idempotency layer (#9).

**P8 — Abuse/fraud.** `org_limits` quotas as data; shadow-mode → progressive ladder
(throttle→challenge→restrict→ban) gated by `shadow_block_rate` < 0.5% / 14d; per-scope
fail-open/closed (security CLOSED, rate-limit OPEN + DB backstop). *Rejected:* app-only limits (#18).

**P9 — Audit & events.** Append-only, monthly-partitioned, per-chain hash (tenant + platform) with
a scheduled verifier + off-site anchors; transactional outbox (per-aggregate seq, at-least-once,
DLQ, replay). Events drive reactions; audit records accountability — never one for the other.
*Rejected:* unverified chains; inline projection writes.

**P10 — Jobs & automation.** Persistent `jobs` with FOR UPDATE SKIP LOCKED + reaper + finalize
fencing (`WHERE locked_by=$w AND attempts=$n`); idempotent handlers; DDL automation via the
migrator ops path only. *Rejected:* discipline-based exclusivity; DDL in job handlers.

**P11 — API.** One pipeline: authN → enforcement → permission → entitlement → rate-limit →
handler; API keys prefix-lookup → hash-verify → resolve → `withTenant` before any scoped query;
signed tenant-bound cursors; problem-details errors (no internal leakage); explicit DTOs; cost
budgets. *Rejected:* raw column filter passthrough; offset pagination; body→entity binding.

**P12 — Admin plane & support access.** Separate plane, MFA mandatory, no shared cookies; zero
direct status writes (through domain services); `support_access_grant` (time-boxed, scoped,
consent/justification, session-recorded) replaces bare impersonation; reads of customer data
audited. *Rejected:* hidden unrestricted impersonation (V10).

**P13 — Security.** Honest key tier (app-level AES-256-GCM `(nonce, key_id, ciphertext)` + Render
env; KMS at a compliance trigger); enumerated secrets inventory; SSRF egress allowlist for the
three real integrations + DNS-rebinding gate for customer webhook URLs; per-principal blast-radius
matrix. *Rejected:* claimed KMS that doesn't exist; "etc." in credential lists.

**P14 — Files.** Org-prefixed object keys; quarantine machine (UPLOADING→QUARANTINE→CLEAN|INFECTED
→deletion); access only via short-TTL signed URLs after `can()` AND `status=CLEAN`; content-type
sniffed; orphan reconciliation. *Rejected:* public buckets / permanent URLs; trusting client MIME.

**P15 — Cache/search/analytics.** One `resolve()`/`versioned_cache` (4 consumers); one key-builder
(tenant-prefixed); security caches fail closed, rate-limit fails open with DB backstop; Postgres
FTS-first (shared tsvector + RLS, not per-tenant indexes); analytics on replicas only. *Rejected:*
bespoke caches; per-tenant indexes; day-one OpenSearch/warehouse.

**P16 — Observability.** Generated metric registry (a named-but-unregistered metric = build
failure); one PII redactor shared with audit; correlation_id propagated API→DB→outbox→job; tenant_id
a metric label only on an allowlisted set; every alert → runbook. *Rejected:* free-text metrics; a
second redactor.

**P17 — Reliability.** Per-dependency failure table (detection = a registered metric); honest ~60s
auth floor; opossum breakers with numbers (open ≥50%/20 reqs, 30s, 3 probes); never-replica set
includes security fallback computes; `/livez` depless, `/readyz` DB-only. *Rejected:* degraded-auth
mode; Redis in readiness.

**P18 — Backup/DR & recovery.** RPO/RTO per tier; encrypted cross-region immutable copies;
`hpx_recovery` as an audited RLS actor (never a script with the owner password); forward-fix over
down-migrations; backups exempt from erasure (`restore_erasure_replay` job closes it). *Rejected:*
interactive migrator in prod; down-migrations on live data.

**P19 — Privacy/retention.** DSAR mapped to the deletion lifecycle with legal-hold check first;
retention/jurisdiction as data the prune job actually reads; consent append-only; subprocessor
register from the real stack. *Rejected:* hardcoded jurisdiction; a policy table nobody reads.

**P20 — Scaling.** Every capability switch = a registered-metric or signed-contract trigger;
explicit DO-NOT-BUILD-in-stage-1 scar list; stage 1 = exactly what P0–P19 built. *Rejected:* "when
we feel big" triggers; a fantasy simpler stage 1.

**P21 — Testing.** 17-surface "Customer A can never access Customer B" suite; blast-radius matrix →
executable assertions; every CI guard has a mutation fixture (a checker never proven to fail is
decoration). *Rejected:* prose-only guarantees.

**P22 — Reconciliation & deployment (freeze).** Reconciliation detectors → metric → alert →
runbook; PSP reconciliation `[NEXT]` (Stripe not installed) — today internal-only (crm_invoices vs
crm_payments vs ledger); guarded bulk ops; CI-only migrations; forward-fix rollback. No new
designs at this stage.

---

## Anti-regression list (do NOT reintroduce)
1. Bootstrap without `REASSIGN OWNED` → first `ALTER TABLE` migration fails.
2. Captured module-level prisma client inside extension op-switching → wrong connection, zero rows
   under RLS.
3. GUC set to `''` or read outside a GUC-bearing transaction (e.g. billing_account_id pre-txn).
4. `dbgenerated("uuidv7()")` on PG16 (no native uuidv7 — use app `newId()`).
5. CHECK constraints referencing `created_at` (a slipped `expected_close_date` is legitimate).
6. Unique index on the wrong column (`tenants(id)` vs `tenants(billing_account_id)`).
7. Webhook dedup that acks-and-ignores **unprocessed** conflicts (drops failed events) — re-dispatch
   unless PROCESSED; forbidden transitions ACK success.
8. OR-clause bypass GUC in RLS policies (SQLi-forgeable) — role-targeted policies only.
9. Idempotency lookup ignoring `expires_at` / no conflict-catch (poisoned keys, raw 500s).
10. `/readyz` gated on Redis (converts degradation into fleet drain) — DB only.
11. Deleting idempotency rows on reclaim for Pattern B without stored external keys.
12. `source='MANUAL'` only in WITH CHECK (org admins lift automated bans via UPDATE) — belongs in
    USING.
13. Hand-maintained model/table lists anywhere — derive from DMMF/`pg_tables`.
14. Outbox projection writes inline (the relay is the only `enf:*` writer).
15. `appendAudit` without the advisory lock, or head-read via `ORDER BY created_at`.
16. Fenced-finalize omitted (a zombie worker overwrites a re-claimed job).

---

## The 12-role model (final)
`hpx_migrator` (owns schema; CI `migrate deploy` only) · `hpx_app` (DML under RLS; no DDL; no
secret columns) · `hpx_auth` (pre-auth: identities, own sessions, tokens, invitations) · `hpx_billing`
(webhook_events + pre-context billing SELECTs) · `hpx_bootstrap` (INSERT org graph) · `hpx_relay`
(outbox SELECT + UPDATE(dispatched_at)) · `hpx_jobs` (per-tenant DML via withTenant; column-scoped)
· `hpx_elevated` (audited cross-tenant) · `hpx_admin` (platform_role_assignments, admin_sessions,
catalogs) · `hpx_audit_reader` (SELECT audit_log incl. PLATFORM) · `hpx_recovery` (clone reads +
scoped merge; audited) · `hpx_readonly` (SELECT non-secret columns).
Break-glass: `GRANT hpx_migrator TO <owner>;` then a human `SET ROLE hpx_migrator`.
