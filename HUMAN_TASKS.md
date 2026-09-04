# Human Tasks — things the agent cannot do (and must not fake)

These require console access, secrets, production execution, or a business decision. Each maps to
an Honesty Register row. **Nothing here has been done by automation; the agent stops at the
proving ground (a disposable local PG16 cluster) and hands off here.**

---

## 1. Render console verification (register #1–3) — BLOCKING for safety claims
Dashboard → your Postgres instance:
- **Recovery / PITR:** confirm Point-in-Time Recovery is ON; note the retention window (target ≥ 7
  days) and snapshot retention (target ≥ 30 days). Screenshot → `docs/RESTORE_RUNBOOK.md` §5.
- **High availability:** does the plan include a hot standby / automatic failover? If not, the
  reliability doc's failover row reads "provider restart, minutes-scale, no standby" — set it
  honestly (register #3).
- **Encryption at rest:** confirm enabled (managed default).

## 2. Add CI secret `MIGRATION_DATABASE_URL` (register #19)
GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
- Name: `MIGRATION_DATABASE_URL`
- Value: the prod/staging connection string using the **`hpx_migrator`** role (not the app role).
The CI `migrate deploy` step (`.github/workflows/ci.yml`) is wired to this secret in WP-0.4 and is
**expected-red until this secret exists** — that is by design, not a defect.

## 3. Dockerfile cutover — BLOCKING, STRICT ORDER (register #19, finding C)
`Dockerfile:22` currently runs migrations at container start **with the app credential**:
```
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
```
Note: `ci.yml`'s `migrate deploy` migrates the **ephemeral CI test DB**, not prod — so prod
migrations currently have **only** the Dockerfile as their home. Before removing them from the
Dockerfile you must give them a new home: a **CI deploy job** (or a Render pre-deploy job) that
runs `npx prisma migrate deploy` with `DATABASE_URL=${MIGRATION_DATABASE_URL}` (the `hpx_migrator`
role). Order:
1. Task #2 done (`MIGRATION_DATABASE_URL` secret exists), AND
2. a deploy/pre-deploy step runs `migrate deploy` as `hpx_migrator` on **PG16** with one green run
   observed against staging.
Only then change the CMD to `CMD ["sh", "-c", "npm run start"]` so production stops carrying DDL.
Until then, the Dockerfile keeps its current behavior — nothing is stranded.

**Deploy flow (confirmed): deploys are MANUAL via the Render dashboard (user-clicked). A `git
push` is a repo event only — it does NOT deploy.** So the Dockerfile cutover gates on your next
manual deploy AFTER the bootstrap. Sequence for your next deploy session:
1. Add CI secret `MIGRATION_DATABASE_URL` (task #2).
2. Run `bootstrap-roles.sql` against PROD as the Render owner — verify owner is **non-superuser +
   CREATEROLE** first (both proven-required, see §WP-0 evidence / task #4).
3. One green CI migration run as `hpx_migrator` (or a Render pre-deploy step) against staging.
4. **THEN** remove `prisma migrate deploy &&` from the Dockerfile CMD.
5. Your next manual deploy carries no DDL on the app credential.
Until step 4, every Render deploy still runs migrations with the app credential — safe for the
verified removal migration, but **the DDL-with-app-credential exposure persists until cutover
completes.**

## 4. Prod bootstrap preconditions (register #19, findings A + B) — verify BEFORE task #5
Proven locally during WP-0 that the bootstrap **fails** without these:
- **Owner role name:** provide the current owner role of the prod/staging DB (the role that owns
  the tables today) — needed for `-v owner=<name>` in `bootstrap-roles.sql`.
- **Owner must be NON-superuser:** `REASSIGN OWNED BY <superuser>` fails ("required by the database
  system"). Render's managed owner is non-superuser — this is fine, just confirm it's the owner.
- **Owner must have CREATEROLE:** `bootstrap-roles.sql` dies at `CREATE ROLE` with
  "permission denied to create role" otherwise. Verify: `\du <owner>` shows `Create role`; if not,
  obtain it (Render managed owners normally have it).

## 5. Run `scripts/db/bootstrap-roles.sql` against staging, then prod (register #19)
**Requires task #4 complete.** Take a fresh `backup-offsite.sh` dump first. Then:
```
psql "<owner_url>" -v owner=<owner_role> \
  -v migrator_pw="'<secret>'" -v app_pw="'<secret>'" -v ro_pw="'<secret>'" \
  -f scripts/db/bootstrap-roles.sql
```
Store the three role passwords in the secrets manager. After it runs, switch the app's
`DATABASE_URL` to the `hpx_app` role (staging first; observe; then prod). Prod-only property to
verify at cutover: after REASSIGN, the non-superuser owner **loses routine DDL** (it could not be
demonstrated locally because the local owner was a superuser).

## 6. Restore drill + first DR game-day — 2026-09-10 (register #8)
Execute the restore drill in `docs/RESTORE_RUNBOOK.md` against a scratch DB; record measured
RTO/RPO in the drill-log template.

## 7. Procurement (register #5, #6)
Redis (rate-limit/cache, WP-4+), S3-compatible object storage (files + off-site backups),
Stripe (billing, WP-7). Until installed, those paths stay `[NEXT]`; reconciliation is internal-only.

## 8. Admin-MFA decision (register #7)
Pull `mfa_factors` forward for admin identities, or gate the admin plane by IP-allowlist with a
dated milestone. Business/security decision.

## 9. All `git push` operations
Commits are made locally by the agent per work package; **pushing requires explicit approval.**
The one standing exception is a push made specifically to observe a CI run as WP-0 evidence.

## 10. Off-site backup key management (register #6)
Generate the gpg keypair for `backup-offsite.sh`; store the **private key separately from Render
app secrets** and back it up in its own location. A lost private key makes every encrypted backup
unrecoverable. Provide `BACKUP_RECIPIENT` (public key id) to the backup job.
