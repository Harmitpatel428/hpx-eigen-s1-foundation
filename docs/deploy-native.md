# Deploy runbook — native Node service (Stage 2 blue/green cutover)

Replaces the Docker/ClamAV service (`Dockerfile.clamav`) with a plain Node
runtime on Render. Virus scanning stays **OFF** (`VIRUS_SCAN_ENABLED=false`) —
uploads are accepted UNSCANNED with an explicit warn-level bypass log. This is
the deliberate accepted-risk posture from Stage 1 (commit `41b8397`), carried
forward because clamd's resident signature DB (~1.2–1.5 GB) does not fit the
512 MB plan.

The canonical settings live in [`render.yaml`](../render.yaml). This runbook is
the human execution procedure. **Artifacts only — no automated deploys.**

Throughout, `<NEW_SERVICE_ONRENDER_HOST>` is the raw host Render assigns to the
new native service — its own `*.onrender.com` address. Never guess it — read it from the Render dashboard after the service is created, and
substitute the real value everywhere before executing the cutover.

## Why native, why blue/green

- 512 MB base plan OOM-kills clamd (verified on deploy `3ac0e6a`).
- Native Node has no build-time signature download, no supervisord, no
  loopback clamd — the whole ClamAV surface disappears.
- Blue/green (new service beside the old) means the cutover is a single
  one-line `vercel.json` rewrite edit (see below), rolled back instantly by
  promoting the previous Vercel deployment, and the old service stays a warm
  rollback for 48h.

`Dockerfile.clamav` and `deploy/*.conf` stay in the repo as the rollback path.
They are archived only in Phase 7, after 48 clean hours AND explicit human
confirmation.

## How the frontend reaches the backend (the cutover hinge)

The frontend (Vercel) does **not** use a custom API domain. Production requests
to `hpxeigen.com/api/*` are proxied **server-side by a Vercel rewrite** in the
frontend repo's `vercel.json`:

```
/api/:path*  ->  https://hpx-eigen-backend.onrender.com/api/:path*
```

Proven live: `GET hpxeigen.com/api/v1/leads` -> backend `401
{"code":"MISSING_TOKEN"}` with `Server: Vercel` + `X-Render-Origin-Server:
Render`; `GET hpxeigen.com/health` -> the SPA `index.html` (only `/api/*` is
proxied). Frontend clients use `VITE_API_BASE_URL || ''`, i.e. relative `/api`
paths in production; the repo's `.env.production` is gitignored and never
reaches Vercel. **The cutover is therefore a one-line change to that rewrite
`destination`** — not a DNS move, not a custom domain, no TTL to manage.

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

1. Render dashboard -> New -> **Web Service** -> connect the
   `hpx-eigen-s1-foundation` repo, branch `main`.
   (Or: New -> Blueprint, pointing at `render.yaml`. Either yields the same
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
   `CLAMD_HOST`, `CLAMD_PORT`, `VIRUS_SCAN_TIMEOUT_MS`, and **`PORT`**
   (`PORT` is platform-injected on the native runtime — Render sets it and the
   app reads `process.env.PORT`; setting it yourself can bind the wrong port).
   Keep `VIRUS_SCAN_ENABLED=false`.
4. Manual Deploy -> deploy the latest `main` (currently `8121e52`).
5. Read the new service's raw host from the dashboard — this is
   `<NEW_SERVICE_ONRENDER_HOST>`; you need it for the rewrite edit.

## Human steps — verify the native service (before the cutover)

Hit `<NEW_SERVICE_ONRENDER_HOST>` directly (the frontend still points at the OLD
service at this stage):

- [ ] `GET /health` -> `200 {"status":"ok","commit":"8121e52…"}`.
- [ ] Boot log shows `virus scanning: DISABLED` + the SECURITY warn line, and
      **no** clamd/freshclam/supervisord lines.
- [ ] Memory well under 512 MB (expect ~100–150 MB RSS).
- [ ] `GET /api/v1/...` without a token -> `401` (app is wired).
- [ ] Mandate `upload-url` on a live token -> `200` + presigned URL (R2 env OK).
- [ ] `confirm-upload` on a clean PDF -> success, and the log shows
      `[VirusScanner] disabled by configuration; bypassing scan`.
- [ ] Migrations applied cleanly in the deploy log (`prisma migrate deploy`).

## Human steps — pre-swap baseline (OLD service, immediately before the swap)

Re-confirm the OLD Docker service is healthy so the cutover starts from a
known-good baseline:

- [ ] No clamd/freshclam spawns in recent logs.
- [ ] RSS < ~350 MB.
- [ ] `[VirusScanner] disabled by configuration; bypassing scan` warn present on
      a recent upload.

## Human steps — the cutover (edit the Vercel rewrite)

1. [ ] In the **frontend** repo (`hpx-eigen-frontend`), edit `vercel.json`:
       change the `/api/:path*` rewrite `destination` from
       `https://hpx-eigen-backend.onrender.com/api/:path*`
       to `https://<NEW_SERVICE_ONRENDER_HOST>/api/:path*`.
2. [ ] Commit & push `main` on the frontend repo -> **Vercel auto-deploys**
       (frontend auto-deploys on Vercel; backend does not).

## Human steps — post-swap gates (ALL must pass)

- [ ] (i) `curl -i https://hpxeigen.com/api/v1/leads` -> `401
      {"code":"MISSING_TOKEN"}` with an `X-Render-Origin-Server` header
      (proves the proxy now reaches the new origin).
- [ ] (ii) `<NEW_SERVICE_ONRENDER_HOST>` `GET /health` `commit` == the deployed
      `main` head.
- [ ] (iii) OLD service request graph -> ~0 req/min (traffic has moved).
- [ ] (iv) Browser: login + one clean PDF upload -> `200` + bypass warn log +
      mandate `UPLOADED`.
- [ ] (v) New service RSS steady < ~350 MB after ~10 min.

## Rollback

- **PRIMARY (instant, no build):** Vercel Dashboard -> Deployments -> the
  previous production deployment (the pre-cutover one) -> **Promote to
  Production**. It re-serves the build whose `vercel.json` still points at the
  OLD service — instant, no rebuild.
- **SECONDARY:** revert the one-line `vercel.json` change and push; Vercel
  rebuilds and redeploys pointing back at the OLD service.
- Either way, no backend redeploy.

## CORS (no change in this cutover)

Because the API is proxied server-side by Vercel, the browser sees same-origin
requests to `hpxeigen.com` — the backend's hardcoded CORS allowlist does **not**
gate the proxied `/api/*` path. CORS still governs the direct browser->R2
presigned PUT (R2 bucket CORS, already configured) and any Vercel **preview**
deployments that call the backend cross-origin.

- **Do not edit `src/app.ts` during this cutover** — keep blast radius minimal.
  The native service inherits the same hardcoded allowlist.
- Known dead entry for a FUTURE cleanup (not now): `www.hpxeigen.com` is in the
  allowlist but does not resolve in DNS. Harmless.
- If the Vercel project is ever renamed/moved, preview URLs may stop matching
  `^https://hpx-eigen-frontend[^.]*\.vercel\.app$` — revisit then.

## Post-cutover

- [ ] Keep the OLD Docker service running (idle/warm, not deleted) for
      **48 hours** as the rollback path.
- [ ] Monitor `/health`, error rate, and memory on the native service.
- [ ] After 48 clean hours + explicit human sign-off -> Phase 7: archive
      `Dockerfile.clamav` + `deploy/*.conf`, strip `CLAMD_*` from code/docs.

## Re-enabling scanning later (out of scope here)

Scanning returns only on a plan with headroom for clamd (>= 2 GB) via the
Docker path, or by pointing `CLAMD_HOST`/`CLAMD_PORT` at an external clamd and
setting `VIRUS_SCAN_ENABLED=true`. Either way the fail-closed path in
`mandate.service.ts` is unchanged and reactivates automatically.
