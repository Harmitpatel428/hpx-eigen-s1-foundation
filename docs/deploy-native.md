# Deploy runbook — native Node service (Stage 2 blue/green cutover)

Replaces the Docker/ClamAV service (`Dockerfile.clamav`) with a plain Node
runtime on Render. Virus scanning stays **OFF** (`VIRUS_SCAN_ENABLED=false`) —
uploads are accepted UNSCANNED with an explicit warn-level bypass log. This is
the deliberate accepted-risk posture from Stage 1 (commit `41b8397`), carried
forward because clamd's resident signature DB (~1.2–1.5 GB) does not fit the
512 MB plan.

The canonical settings live in [`render.yaml`](../render.yaml). This runbook is
the human execution procedure. **Artifacts only — no automated deploys.**

## Why native, why blue/green

- 512 MB base plan OOM-kills clamd (verified on deploy `3ac0e6a`).
- Native Node has no build-time signature download, no supervisord, no
  loopback clamd — the whole ClamAV surface disappears.
- Blue/green (new service beside the old) means the traffic swap is a single
  reversible domain move, and the old service is a warm rollback for 48h.

`Dockerfile.clamav` and `deploy/*.conf` stay in the repo as the rollback path.
They are archived only in Phase 7, after 48 clean hours AND explicit human
confirmation.

## Runtime command is idempotent + multi-instance safe

Start command: `npx prisma migrate deploy && node dist/src/server.js`

- `prisma migrate deploy` applies only *pending* migrations and is a no-op when
  the schema is current — safe to run on every boot and every instance.
- Prisma takes a Postgres **advisory lock** around migration application, so if
  the plan is later upgraded to >1 instance, concurrent boots serialize: one
  instance migrates, the others wait then no-op. No double-apply, no race.
- The server itself holds no local state (sessions in Postgres, cache in Redis,
  files in R2), so horizontal scaling needs no code change — only a plan bump.

## Human steps — create the native service

1. Render dashboard → New → **Web Service** → connect the
   `hpx-eigen-s1-foundation` repo, branch `main`.
   (Or: New → Blueprint, pointing at `render.yaml`. Either yields the same
   service; the manual path is described here so nothing is implicit.)
2. Set:
   - Runtime: **Node** (not Docker)
   - Build command: `npm ci && npm run build`
   - Start command: `npx prisma migrate deploy && node dist/src/server.js`
   - Health check path: **`/health`**
   - Auto-deploy: **Off**
   - Plan: **Starter** (512 MB)
   - Region: **same as the existing service and the Postgres instance**
3. Copy every env var from the current Docker service **except**
   `CLAMD_HOST`, `CLAMD_PORT`, `VIRUS_SCAN_TIMEOUT_MS`. Keep
   `VIRUS_SCAN_ENABLED=false`. Do not set `PORT` — Render injects it and the
   app reads `process.env.PORT`.
4. Manual Deploy → deploy `044dad5` (or later `main`).

## Human steps — verify the native service (before any traffic swap)

Hit the new service's raw `*.onrender.com` URL directly (not the custom domain):

- [ ] `GET /health` → `200 {"status":"ok",...}`
- [ ] Boot log shows `virus scanning: DISABLED` + the SECURITY warn line, and
      **no** clamd/freshclam/supervisord lines.
- [ ] Memory well under 512 MB (expect ~100–150 MB RSS).
- [ ] `GET /api/v1/...` behind auth returns 401 without a token (app is wired).
- [ ] Mandate `upload-url` on a live token → `200` + presigned URL (R2 env OK).
- [ ] `confirm-upload` on a clean PDF → success, and the log shows
      `[VirusScanner] disabled by configuration; bypassing scan`.
- [ ] Migrations applied cleanly in the deploy log (`prisma migrate deploy`).

## Human steps — the traffic swap

The frontend (Vercel) reaches the backend by env var, and the production build
uses a **custom API domain** (`.env.production` → `VITE_API_URL`, currently
`https://api.hpx-eigen.com`). Two swap mechanisms — **prefer the domain move**:

**Preferred — move the custom domain (atomic, no frontend redeploy):**
- [ ] In Render, remove the custom API domain from the OLD Docker service and
      add it to the NEW native service. DNS/routing repoints; both frontend
      env vars (`VITE_API_URL` and `VITE_API_BASE_URL`) keep working unchanged.
- [ ] Rollback = move the domain back. No redeploy either way.

**Alternative — repoint Vercel env (needs a frontend redeploy):**
- [ ] Update BOTH `VITE_API_URL` and `VITE_API_BASE_URL` in Vercel to the new
      URL, then redeploy the frontend.
- [ ] ⚠️ Both names are load-bearing: `VITE_API_URL` drives auth/signup/verify;
      `VITE_API_BASE_URL` drives the main API client and the mandate upload
      path (`src/services/mandate.service.ts`). Setting only one silently
      breaks the other half. This is why the domain move is preferred.

## Human steps — CORS must admit the live frontend origin

CORS is **hardcoded** in `src/app.ts` (no env var), so the native service
inherits the exact same allowlist. Before declaring cutover done:

- [ ] Confirm the production frontend origin (`https://hpxeigen.com` /
      `https://www.hpxeigen.com`) is in the `allowedOrigins` array.
- [ ] Confirm the Vercel **preview** deployment URLs still match the regex
      `^https://hpx-eigen-frontend[^.]*\.vercel\.app$`. If the Vercel project
      was renamed or moved to a new team/org, preview URLs won't match and
      preview builds will fail CORS — update the regex in `app.ts` if so.
- [ ] From the live frontend, exercise a real cross-origin request (login +
      one mandate upload) against the new service and confirm no CORS error.

## Post-cutover

- [ ] Keep the OLD Docker service running, **stopped-but-not-deleted** or idle,
      for **48 hours** as the rollback path.
- [ ] Monitor `/health`, error rate, and memory on the native service.
- [ ] After 48 clean hours + explicit human sign-off → Phase 7: archive
      `Dockerfile.clamav` + `deploy/*.conf`, strip `CLAMD_*` from code/docs.

## Re-enabling scanning later (out of scope here)

Scanning returns only on a plan with headroom for clamd (>= 2 GB) via the
Docker path, or by pointing `CLAMD_HOST`/`CLAMD_PORT` at an external clamd and
setting `VIRUS_SCAN_ENABLED=true`. Either way the fail-closed path in
`mandate.service.ts` is unchanged and reactivates automatically.
