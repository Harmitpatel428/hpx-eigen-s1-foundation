# Deploy runbook — backend + ClamAV (Dockerfile.clamav)

> **STATUS (Stage 2):** This Docker/ClamAV path is **NOT the live posture**. Production
> currently runs the **native Node** service with scanning OFF — see
> [deploy-native.md](deploy-native.md). This file is retained as the rollback /
> re-enable-scanning path (needs a >= 2 GB plan). The "fail closed (503)" behaviour
> below applies only when `VIRUS_SCAN_ENABLED=true`; with scanning off, uploads are
> accepted UNSCANNED (explicit logged bypass).


The backend deploys on Render as a **Docker** service using `Dockerfile.clamav`,
which runs the Node app + an in-container `clamd` (loopback-only) under
supervisord. clamd is required: mandate uploads **fail closed (503)** when the
scanner is unreachable.

## Local acceptance gates — run ALL before pushing a build/config change

Docker Desktop must be running. (Git Bash: prefix container commands with
`MSYS_NO_PATHCONV=1` so absolute paths are not mangled.)

### 1. Build gate — image builds, freshclam bakes signatures
```
docker build -f Dockerfile.clamav -t hpx-eigen-backend:conf-fix .
```
Expect `[11/11] RUN ... freshclam ... DONE`, exit 0. A multi-minute pause at the
freshclam step (~108 MB signature download) is normal.

### 2. Bake gate — signature DB present
```
docker run --rm --entrypoint sh hpx-eigen-backend:conf-fix -c 'ls -lh /var/lib/clamav'
docker run --rm --entrypoint freshclam hpx-eigen-backend:conf-fix --version
```
Expect `main.cvd`, `daily.cvd`, `bytecode.cvd`; record the ClamAV version.

### 3. Runtime gate — clamd parses, binds loopback-only, detects EICAR
Start clamd alone (no app/DB), confirm it listens on **127.0.0.1:3310 only**
(`/proc/net/tcp` local address `0100007F:0CEE`, and NOT `00000000:0CEE`), that
`/tmp/clamd.log` shows no parse errors, then scan a clean payload (expect
`stream: OK`) and the 68-byte EICAR string (expect
`stream: Eicar-Test-Signature FOUND`) via the INSTREAM protocol the app uses.
See `scratchpad/clamd_runtime_proof.sh` + `instream_scan.js` for the exact
harness. EICAR files are created ONLY inside throwaway containers.

### 4. DB-safety gate — build touches no database
```
grep -nE "migrate|db push|db seed|DATABASE_URL" Dockerfile.clamav   # must be empty
```
Only `prisma generate` (codegen, no DB connection) runs at build time. Runtime
`prisma migrate deploy` lives in `deploy/supervisord.conf` (app start), not the
image build.

## Config invariants
- `DatabaseDirectory` identical in `deploy/clamd.conf` and `deploy/freshclam.conf`.
- `LogFile` is a **clamd**-only directive; the updater uses **`UpdateLogFile`**.
- clamd stays loopback: `TCPAddr 127.0.0.1`, `TCPSocket 3310`, never `EXPOSE`d.
- `node:20-bookworm-slim` needs `ca-certificates` for freshclam's HTTPS download.

## Render
- Runtime: Docker; Dockerfile path: `Dockerfile.clamav`.
- Env: `VIRUS_SCAN_ENABLED=true`, `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310`
  (plus R2_*, DATABASE_URL, FRONTEND_URL, MANDATE_UPLOAD_BASE_URL).
- Plan **>= 2 GB RAM** (clamd holds the signature DB resident).
- After deploy, clamd needs ~30-60 s to load signatures; uploads fail closed
  (503) in that window by design, then succeed.
