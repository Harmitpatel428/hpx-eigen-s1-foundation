# Database Durability & Restore Runbook

Root cause this guards against: the platform was once wiped by a destructive command
(`db push` / `migrate reset`) with no backup and no way to recover. The controls below
make accidental destruction hard and recovery always possible.

Engine: **PostgreSQL 16** (Render, prod) / 14 (local docker) / 15 (CI).
ORM: **Prisma 5.22**, versioned migrations, applied in prod via `prisma migrate deploy`.

---

## 1. Layers of protection

| Layer | What it is | Status |
|---|---|---|
| Env separation | Local `.env` → `localhost/hpx_eigen_dev`; prod `DATABASE_URL` lives only in Render/CI secrets. | ✅ in place |
| `prisma:reset` guard | `scripts/safe-reset.sh` refuses reset when `NODE_ENV=production` or the URL matches a prod host (render/neon/aws/…); requires typed `yes`. | ✅ in place |
| Destructive-migration guard | `scripts/check-destructive-migrations.cjs` fails CI if a **new** migration has an unreviewed `DROP TABLE/COLUMN`, `TRUNCATE`, or `DELETE`/`UPDATE` without `WHERE`. Runs as the `migration-guard` job in `.github/workflows/ci.yml`. | ✅ in place |
| Managed backups + PITR | Render managed Postgres daily backups + point-in-time recovery. | ⚠️ **verify in console — see §5** |
| Logical dumps | `scripts/backup-db.sh` → compressed `pg_dump -Fc` archive, off-box copy before risky ops. | ✅ in place |
| Restore drill | Documented + executed (see §4). | ✅ done |

### Hard rules
- **Never** run `prisma db push` or `prisma migrate reset` against staging/production. Schema
  changes go through `prisma migrate dev` (local) → reviewed migration file → `migrate deploy` (CI/Render).
- **Never** point local dev tooling at the prod `DATABASE_URL`.
- A destructive migration is allowed only with an explicit marker line in its `migration.sql`:
  `-- SAFETY-REVIEWED: <who / why>`. Never edit an already-applied migration (breaks Prisma checksums).

---

## 2. Take a backup

```bash
# backs up $DATABASE_URL (or pass a URL as arg)
npm run db:backup
# or:  bash scripts/backup-db.sh "postgresql://user:pass@host:5432/db"
```

Produces `backups/<db>-<UTCtimestamp>.dump` (git-ignored) and verifies it is readable by
`pg_restore -l`. **Move a copy off this machine** (encrypted, off-region) — a dump next to the
DB is not a backup.

Always take a fresh dump immediately before any risky migration or data operation.

---

## 3. Restore

Restore targets a **scratch** database first, never straight over a live one, unless you are
deliberately recovering from a confirmed loss.

```bash
# Whole database into a fresh/empty target:
pg_restore --no-owner --no-privileges --dbname="postgresql://user:pass@host:5432/TARGET" backups/<file>.dump

# Overwrite an existing target (drops & recreates objects first):
pg_restore --clean --if-exists --no-owner --dbname="<target_url>" backups/<file>.dump

# Single table only (e.g. recover one accidentally-cleared table):
pg_restore --data-only -t "Lead" --dbname="<target_url>" backups/<file>.dump
```

> Portability gotcha (Windows/Git-Bash + native PG binaries): libpq getopt stops parsing
> options at the first bare positional, so put **all options before** the connection URL.

To recover **one tenant**, restore the whole dump into a scratch DB, then copy that tenant's
rows (all tables carry `tenantId`) into the live DB inside a transaction.

---

## 4. Restore drill — executed

**Date:** 2026-09-03 (UTC). **Operator:** durability hardening pass.

- Source: local `hpx_eigen_dev` (47 public tables).
- Backed up with `scripts/backup-db.sh` → 200 KB `-Fc` archive, verified by `pg_restore -l`.
- Restored into throwaway `hpx_eigen_restore_drill`, then dropped it.
- **Row-count verification (source vs restored):**

  | Table | Source | Restored | |
  |---|---|---|---|
  | Tenant | 6 | 6 | ✅ |
  | User | 6 | 6 | ✅ |
  | Lead | 13 | 13 | ✅ |
  | Opportunity | 1 | 1 | ✅ |
  | Activity | 0 | 0 | ✅ |
  | AuditLog | 196 | 196 | ✅ |
  | public tables | 47 | 47 | ✅ |

**Result: PASS** — the backup is restorable and complete.

Re-run this drill whenever the backup toolchain or Postgres major version changes, and at least
quarterly. Record the new result here.

---

## 5. ⚠️ Human / console actions still required

These need Render dashboard access and could not be done from code:

1. **Confirm managed backups + PITR are actually enabled** on the Render Postgres instance,
   note the retention window, and confirm the region for off-site copies.
   Render dashboard → the database → *Backups* / *Recovery*.
2. **Test-restore a managed backup** into a scratch Render DB once, to prove the managed path
   (not just the local `pg_dump` path) works. Record the result in §4.
3. **Schedule an off-box copy** of `scripts/backup-db.sh` output (e.g. nightly upload to
   encrypted object storage in another region) if managed PITR is not sufficient alone.
4. **Isolate/confirm `SHADOW_DATABASE_URL`.** It currently points at a Neon cloud DB; Prisma
   drops & recreates the shadow schema on every `migrate dev`. Confirmed throwaway for now —
   keep it a dedicated empty DB, never a database holding real data.

---

## §WP-0 — Credential-split acceptance evidence (2026-09-04)

Proofs run against a **disposable PG16 cluster** created with `initdb` on port 55432 (own data
dir, no volume, destroyed after) — never the dev server on 5432, never staging/prod. Owner modeled
as a **non-superuser role with CREATEROLE** (`hpx_owner`) to match Render's managed owner; tables
owned by it, then `bootstrap-roles.sql` transferred ownership to `hpx_migrator`.

```
PROOF 1  prisma db push        as hpx_app  → Error: ERROR: permission denied for schema public
PROOF 2  prisma migrate reset  as hpx_app  → P3016 … ERROR: must be owner of table _prisma_migrations
PROOF 3  TRUNCATE "User"       as hpx_app  → ERROR:  permission denied for table User
PROOF 4  ALTER TABLE ADD COLUMN as hpx_migrator → ALTER TABLE            (success)
PROOF 5  break-glass: hpx_owner SET ROLE hpx_migrator; ALTER TABLE → SET / ALTER TABLE (success)
```
Two preconditions **proven required** (both true of Render's managed owner — see HUMAN_TASKS #4):
- Owner must be **non-superuser**: `REASSIGN OWNED BY <superuser>` fails "objects … required by the
  database system".
- Owner must have **CREATEROLE**: bootstrap's `CREATE ROLE` fails "permission denied to create
  role" otherwise.

Caveat: proof 5 is **mechanics-only** — under a superuser owner it proves the break-glass path,
not the "owner loses routine DDL" restriction (which holds only for a non-superuser owner; verify
at prod cutover).

### Destructive-migration guard (`scripts/check-destructive-migrations.cjs`)
Bare `DELETE`/`UPDATE` without `WHERE` are already caught per-statement (findings() lines 77–78).
Fixture run:
```
default (new/untracked) mode: DELETE FROM "User";                    → ❌ DELETE without WHERE
                              DELETE FROM "User" WHERE id = '…';      → (not flagged, passes)
--all mode: also flags legitimate HISTORICAL unmarked DROP COLUMN migrations — so the guard's
            contract is diff-mode on NEW migrations (how CI runs it, --base origin/main), not an
            --all clean sweep.
```

### Encrypted off-site backup roundtrip (`scripts/db/backup-offsite.sh`)
File-based two-step (Windows-safe), gpg encrypt → decrypt → verify:
```
pg_dump -Fc -f db.dump          → 170,918 bytes
gpg --encrypt → db.dump.gpg      → 28,236 bytes
gpg --decrypt → db.restored.dump
pg_restore -l db.restored.dump   → 447 TOC entries (tables owned by hpx_migrator)
```
