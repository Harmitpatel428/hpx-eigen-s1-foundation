# Honesty Register

This engagement exists because a destructive Prisma command wiped the only copy of production
data. This register is its counterweight: every unproven claim, deferred capability, and pending
fix — each with an owner and a verification step. **A row closes ONLY with a link to pasted
evidence** (a commit, a console screenshot, a drill log). Every PR references the rows it touches.

Status legend: `UNVERIFIED` (needs human/console) · `PENDING` (planned, not done) · `IN-PROGRESS`
· `ADOPTED` (rule in force) · `DONE` (evidenced) · `[NEXT]` (not yet installed).

| # | Marker | Status | Owner | Verification / action |
|---|--------|--------|-------|-----------------------|
| 1 | Render PITR ON, retention ≥ 7d | UNVERIFIED | Platform-Eng | Render dashboard → DB → Recovery; screenshot into RESTORE_RUNBOOK §5 |
| 2 | Backup object-lock available | UNVERIFIED | Platform-Eng | Verify bucket lock policy on chosen provider (reg #6) |
| 3 | Postgres hot standby in plan | UNVERIFIED | Platform-Eng | Render plan check; else document "minutes-scale restart" |
| 4 | BYPASSRLS grantable on Render | UNVERIFIED | Platform-Eng | WP-3: `CREATE ROLE … BYPASSRLS` test; else tenant-iteration sweeps |
| 5 | Stripe billing | [NEXT] not installed | Billing | Integrate; unblocks PSP reconciliation (WP-7 uses internal-only until then) |
| 6 | Object storage provider | [NEXT] not installed | Platform-Eng | Pick S3-compatible (Oregon); off-site backup dest (used by scripts/db/backup-offsite.sh) |
| 7 | Admin MFA | UNVERIFIED / interim | Security | Decide: pull `mfa_factors` forward for admins, or IP-allowlist + dated milestone |
| 8 | First DR game-day | PENDING (2026-09-10) | Platform-Eng lead | Execute; record `restore_drill_rto/rpo` |
| 9 | ACCESS_TTL = 15m (login path) | DONE | Backend | Commit `fix(auth): single ACCESS_TTL=15m …` + tests/unit/token-ttl.regression.test.ts (3/3 pass) |
| 10 | V10 `user:impersonate` removal | PENDING | Backend | WP-1 PR-1: live feature (route+toggle+middleware), re-seeded by prisma/seed-permissions.ts:71 — needs seed removal + anti-resurrection guard + human customer-facing decision |
| 11 | `restore_erasure_replay` job + manifest | PENDING (not built) | Backend | Build job + off-site manifest (Phase 19) |
| 12 | DSAR backup template | PENDING (never-send until #11) | DPO | Gate until #11 ships |
| 13 | DR environment (cold restore-on-demand) | ADOPTED (documented) | Platform-Eng | No warm standby; staging not kept in sync |
| 14 | `JWT_REFRESH_SECRET` vestigial | DONE | Backend | Commit `chore(auth): remove vestigial JWT_REFRESH_SECRET` — zero src refs proven; removed from tracked templates + ci.yml (local .env is gitignored, dev's own) |
| 15 | PG version drift (14/15/16) | IN-PROGRESS | Platform-Eng | docker-compose → 16-alpine DONE (this WP); ci.yml → 16 in WP-0.4; closes when CI green on 16 + local proofs on 16 (DONE) |
| 16 | `messages`/junction `tenant_id` backfill | PENDING | Backend | WP-2 |
| 17 | `crm_invoices/crm_payments.deleted_at` drop | PENDING | Backend | WP-2 (expand/contract) |
| 18 | Staged RLS enablement | PENDING | Platform-Eng | WP-5; staging suite green before prod |
| 19 | Deny-by-default grants flip + generator | IN-PROGRESS | Backend | Stage-1 bootstrap DONE (scripts/db/bootstrap-roles.sql, 5 proofs pasted in RESTORE_RUNBOOK §WP-0); Stage-2 REVOKE + matrix = WP-3 |
| 20 | Initial-partitions-in-migration rule | ADOPTED | Backend | Enforced in WP-2 audit_log partitioning |
| 21 | argon2id migration (from bcrypt) | PENDING | Backend | WP-6 upgrade-on-login; auth.service.ts:2 imports bcryptjs |
| 22 | `hpx_readonly` column scoping | PENDING | Platform-Eng | WP-3 (Stage-1 grants SELECT on all; tighten to non-secret columns) |
| 23 | `role_permissions.tenant_id` (3rd junction) | PENDING | Backend | WP-2 (add + backfill + RLS + composite FK) |
| 24 | Phase-21 test ledger | PENDING (designed) | QA/Backend | Suites + guard mutation fixtures across WPs |

## WP-0 additions to the register (discovered during execution — see HUMAN_TASKS)
| A | Prod owner must be **non-superuser** (REASSIGN OWNED refuses a superuser's system objects) | VERIFIED locally | Platform-Eng | Render's managed owner is non-superuser — confirm the owner role name (HUMAN_TASKS #4) |
| B | Prod owner must have **CREATEROLE** (bootstrap `CREATE ROLE` dies otherwise) | VERIFIED locally | Platform-Eng | Confirm CREATEROLE on the Render owner before prod bootstrap (HUMAN_TASKS #4) |
| C | `Dockerfile:22` runs `prisma migrate deploy` at container start with the **app credential** | VERIFIED | Platform-Eng | Move to CI-only per HUMAN_TASKS #3 cutover chain |
