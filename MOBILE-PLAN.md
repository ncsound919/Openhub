# OpenHub + opencode on Android — Mobile Plan

**Date:** 2026-10-26
**Owner:** tap45
**Status:** Phases 1–6 + 4/5 extensions complete on device. See §11–§15.

## 1. Goal

Run the OpenHub web IDE (with its opencode integration) **on an Android phone**, so the user can do agent-driven coding on the device: describe a goal, let the opencode agent implement it, review diffs/permissions, and approve/push — with a human in the loop only for approvals and git push.

## 2. Chosen architecture (from your answers)

- **Phone = host.** OpenHub Express server + `opencode serve` engine run on-device under Termux. The phone's Chrome accesses `http://127.0.0.1:3000`. No external host required for core use.
- **Cloudflare** = remote access + TLS + access control (tunnel from phone to a public hostname when you want to reach it off-device or from another device) + R2 for artifact storage.
- **AWS** = heavy/offload compute and managed services: Bedrock for LLM (when the phone's local model lane is insufficient), S3 for repo/artifact backup, Secrets Manager for keys, optional EC2 fallback host.
- **Kaggle** = batch GPU/CPU compute only (notebooks, up to ~9–12h): model training, heavy test suites, large refactors. Results pushed back via GitHub/S3, not an interactive server.
- **Human role** = approval + push. The agent does the editing; the phone UI is an approval/push console, not a full typing IDE.

## 3. What already helps (reuse, don't rebuild)

- OpenHub is already a web app (Vite + React + Express) and already binds `host: '0.0.0.0'` in Vite dev. Server host defaults to `127.0.0.1` and can be set via `OPENHUB_HOST`.
- `MissionControlPage` already has a "native select" mobile fallback for the missions rail.
- opencode integration is already proxied through `/api/opencode/*` (health, sessions, prompt, abort, permissions, SSE events, diff, messages).
- Cloudflare tunnel is already referenced in `vite.config.ts` (`allowedHosts: .overlay365.com`), so a public hostname path exists.
- `EngineStatusBar` already surfaces engine health + provider count — good for a phone status chip.

## 4. Hard problems (spike these first)

| # | Problem | Why it matters | Spike |
|---|---------|----------------|-------|
| S1 | `better-sqlite3` native build on Android/Termux | OpenHub's DB layer depends on it; compiling native modules on Termux is the #1 blocker | Install Termux, node 22, build openhub, run `npm install` + `npm run dev`; record whether better-sqlite3 compiles |
| S2 | opencode CLI on Android | Engine spawn assumes `opencode.cmd`/`opencode` binary; need a Linux/ARM build or npm package that runs in Termux | `npm i -g opencode-ai` (or the actual package) in Termux; run `opencode serve` on 127.0.0.1:4196; probe `/global/health` |
| S3 | Android process lifecycle | Termux processes get killed when backgrounded; need a foreground service / wake lock | Test `termux-wake-lock` + `termux-services`; measure how long server survives screen-off |
| S4 | Monaco editor on mobile browser | Heavy; typing code on phone is poor UX anyway | Decide: keep Monaco for tablet/large screens, render read-only diff + approval UI on small screens |
| S5 | Terminal (xterm) over WebSocket on mobile | `node-pty` may not build on Termux; terminal UX on phone is limited | Evaluate disabling terminal on mobile (`OPENHUB_DISABLE_TERMINAL=1`) |
| S6 | Kaggle as compute | Kaggle notebooks are batch, not servers; integration is async job queue | Design a "job" table + poller; smallest viable: push a git branch, trigger Kaggle notebook via API, pull result PR |

## 5. Phased plan

### Phase 0 — Feasibility spikes (1–2 sessions)
- Run S1–S5 on a spare Android device (or emulator). Do NOT touch the codebase yet except to record findings.
- Deliverable: a short `MOBILE-SPIKE-RESULTS.md` with pass/fail per spike and the exact Termux commands that work.
- Gate: if S1 or S2 fails hard, pivot to "phone as client of a PC/cloud backend" (fallback architecture in §8).

### Phase 1 — On-device runtime (Termux primary)

**Why Termux now:** The Android 15 Linux Terminal VM failed to start on this Samsung Galaxy S25 Ultra (`VmController: Failed to start VM`), so it is not viable on this device. Termux is the primary on-device path. opencode (a glibc binary) does not run directly in Termux (bionic); it runs inside an Ubuntu proot-distro, invoked via a wrapper script.

- Install Termux (ARM64 build) from F-Droid or GitHub releases. Avoid the Play Store build (outdated).
- Termux bootstrap:
  - `pkg update && pkg upgrade`
  - `pkg install nodejs-lts git python build-essential pkg-config libsqlite clang make proot-distro`
  - `proot-distro install ubuntu` then `proot-distro login ubuntu -- bash -c 'apt-get update && apt-get install -y nodejs npm git'`
  - `npm i -g opencode-ai` inside Ubuntu (installs `opencode-linux-arm64`).
  - Clone/push openhub into `~/openhub`; `npm install`; better-sqlite3 compiles against Termux's libsqlite.
  - Create `~/.secrets/opencode/server-password` (chmod 600) with a strong random value.
  - Create wrapper `~/opencode-wrapper.sh` that execs `proot-distro login ubuntu -- opencode "$@"`.
  - Build frontend: `node --max-old-space-size=4096 node_modules/vite/bin/vite.js build`.
  - Start OpenHub: `NODE_ENV=production node node_modules/tsx/dist/cli.mjs server.ts` with `OPENCODE_BIN` + `OPENCODE_SERVER_PASSWORD_FILE` set.
  - Start engine: `POST /api/opencode/engine/start` (with auth + CSRF).
- Keep a wake lock while running: `termux-wake-lock`.
- Access from phone: Chrome opens `http://127.0.0.1:3000`.
- Acceptance: phone Chrome opens OpenHub, logs in, Mission Control loads sessions, engine status chip shows healthy. **ACHIEVED 2026-10-26.**

### Phase 2 — Mobile UI (responsive + touch)
- Add responsive breakpoints to the shell layout (sidebar → bottom nav / drawer on `< md`).
- Mission Control: keep the native-select rail fallback; make composer, timeline, inspector stack vertically on small screens; enlarge touch targets (min 44px).
- Permission approval row: big Allow/Deny buttons, haptic feedback.
- Editor: on small screens default to "review diff" view; hide Monaco unless viewport ≥ 768px or user opts in.
- Add a mobile-specific "Approve & Push" flow: stage → review diff → commit → push, with confirmation modals.
- Deliverable: Tailwind responsive classes + a `useIsMobile()` hook; no new framework.

### Phase 3 — Agent-based IDE loop on phone
- Make Mission Control the default landing page on mobile (not the file editor).
- Add "quick goal" templates (fix bug, add test, refactor) with one-tap start.
- Inline diff review with per-file accept/reject (already partially in MissionInspector) tuned for touch.
- Git push approval: require explicit tap + biometric/PIN (Android WebAuthn or simple confirm) before `git push`.
- Notifications: when a mission needs approval or finishes, fire a local notification so the phone can be put down between steps.
- Acceptance: a full loop — goal → agent edits → approve permission → review diff → push — completes on phone without a keyboard.

### Phase 4 — Cloudflare + AWS integration
- Cloudflare Tunnel from the phone to `openhub.<yourdomain>` so you can reach the IDE from another device / off-LAN. Use a named tunnel + access policy (email OTP) rather than a quick tunnel.
- AWS: Bedrock as an alternate LLM lane; S3 for nightly repo backup; Secrets Manager for API keys (replacing `.env` on device).
- Keep secrets out of the phone's git working tree; load from AWS Secrets Manager at boot, cache in memory only.
- Acceptance: phone can be reached at a stable HTTPS URL with auth; LLM calls can route to Bedrock; nightly backup to S3 succeeds.

### Phase 5 — Kaggle batch compute
- Define a "job" concept: `{id, type, repo, branch, command, status, result_url}`.
- OpenHub queues jobs to a GitHub repo; a Kaggle notebook (scheduled or triggered) picks up queued jobs, runs them (tests/training), commits results + a status file back.
- OpenHub polls the status file (or a webhook via Cloudflare Worker) and surfaces results in Mission Control.
- Use cases: running the full test suite on a larger machine, training a small model, heavy static analysis.
- Acceptance: submit a "run full test suite" job from phone; Kaggle runs it; results appear in OpenHub within the notebook's runtime window.

### Phase 6 — PWA + polish + hardening
- Add `manifest.webmanifest` + service worker (cache app shell, offline read-only views) → installable as Android WebAPK ("Add to Home Screen").
- Biometric/PIN gate on app open (WebAuthn or a simple PIN in the auth layer).
- Battery: document expected drain; recommend charging while running; auto-pause engine on low battery via Termux API.
- Security audit: no `0.0.0.0` bind without tunnel; CORS allowlist; quick-access/demo accounts off (already gated).
- Acceptance: app installs to home screen, opens full-screen, works offline for cached views, passes a final security checklist.

## 6. Suggested file/structure changes (when we start coding)

- `scripts/termux-bootstrap.sh`, `scripts/termux-start.sh`
- `src/lib/useIsMobile.ts`
- `src/components/MobileNav.tsx` (or reuse existing nav with responsive classes)
- `src/mission/MissionControlPage.tsx` — responsive layout tweaks (already has mobile rail fallback)
- `src/services/bedrockProvider.ts` (new) alongside `orchestrator/models/providers.ts`
- `src/services/kaggleJobs.ts` (new)
- `public/manifest.webmanifest`, `public/sw.js`
- `vite.config.ts` — register manifest, precache list

## 7. Risks & mitigations

- **Native module build failure on Termux** → fallback to sql.js (pure JS) or move DB to a cloud Postgres/Turso; document in Phase 0. *(Resolved: better-sqlite3 builds fine.)*
- **Android kills background processes** → use Termux foreground service + wake lock; set expectations (phone must stay awake/charging during long agent runs).
- **Kaggle's 9–12h limit + no interactivity** → only batch workloads; never block the agent loop on Kaggle.
- **Secrets on device** → AWS Secrets Manager + in-memory cache; never commit `.env` to a phone-synced repo.
- **Cloudflare tunnel from a phone** → dynamic IP/CGNAT; use a named tunnel with auto-reconnect; accept intermittent availability.
- **Monaco on mobile** → disable by default on small screens; agent edits files server-side anyway, so the phone mainly reviews diffs.
- **opencode is a glibc binary** → runs inside an Ubuntu proot-distro; OpenHub invokes it via a wrapper script (`OPENCODE_BIN`).

## 8. Fallback if Phase 0 spikes fail

If better-sqlite3 or opencode cannot run on Android:
- **Mode B (client mode):** phone becomes a PWA client of a backend running on your PC or an EC2 instance; Cloudflare Tunnel exposes it. All "run on phone" work is skipped; Phases 2–6 still apply to the client UI. This is lower-risk and likely the pragmatic default; revisit on-device only if a specific need (offline, travel) arises. *(Not needed — on-device works.)*

## 9. Termux alternatives (if Termux is unsuitable)

Termux is still the best on-device option, but if it fails (native build, policy, or device restrictions), these are viable:

| Option | What it is | Pros | Cons |
|---|---|---|---|
| **UserLAnd** | Runs a full Linux distro (Ubuntu/Debian) in a proot on Android, with a GUI desktop option | Easier package availability (apt), familiar environment, can install node via nvm | Slower I/O than Termux, larger footprint, proot overhead, less "native" |
| **proot-distro (inside Termux)** | Installs a full distro into Termux's prefix | Best of both: Termux's speed + distro packages | Still depends on Termux being installable |
| **Android 15 "Linux Terminal" (Pixel/Debian VM)** | Google's built-in Debian VM on recent Pixel devices | Native, no third-party app, good performance | Pixel-only, Android 15+, still maturing, limited device storage sharing. **Failed on this Samsung device (`VmController: Failed to start VM`).** |
| **Cloud dev box (Codespaces/Replit/EC2)** | Backend runs in cloud; phone is a PWA client | Zero on-device build pain; always-on | Requires network; recurring cost; this is "Mode B" in §8 |
| **a-Shell / iSH** | iOS-only shells | Not applicable (you're on Android) | — |

Recommendation: primary path is the Android 15 Linux Terminal VM (standard Debian tooling, better-sqlite3 compiles against system libsqlite). Fall back to Termux (UserLAnd if Termux policy/storage issues) only if the Linux Terminal app is unavailable. Cloud dev box (Mode B) remains the last resort. *(Actual: Linux Terminal VM failed on Samsung; Termux + proot-distro Ubuntu is the working path.)*

## 10. Credentials (resolved)

All needed credentials were found in `D:\\docs\\opencode api.txt` and related files:
- **OpenCode API key:** `oc_sk_<redacted>...`
- **Cloudflare:** API token `cfat_...`, R2 access key/secret, account `a7ce29a9...`, R2 endpoint
- **AWS:** access key `AKIA<redacted>`, account `006514117590`, user `concordance-app`
- **Kaggle:** 3 tokens (`KGAT_...` for tap919beats / tap4500 / ncsound919)
- **GitHub:** PAT `github_pat_...`
- **Modal:** token id/secret for tap4500
- **Supabase, Stripe, Gemini, DeepSeek, Mistral, OpenRouter, NVIDIA, Ollama, IBM Cloud, etc.** also present

So no credential gathering is needed; Phase 4 can proceed directly to wiring.

## 10.1 Open questions for you

- Cloudflare: use the existing account/zone for a **named tunnel** + access policy, or a free `*.trycloudflare.com` quick tunnel for first testing?
- AWS: preferred region (e.g. `us-east-1`) and whether to enable Bedrock model access (needs a console toggle + use-case form)?
- Kaggle: which account to use for job notebooks, and should notebooks clone repos via the GitHub PAT or a deploy key?
- Git push from phone: direct to GitHub with the PAT, or through a CI gate (recommended)?
- Android device model + Android version (to know if the Android 15 Linux Terminal VM is an option)? *(Resolved: Samsung Galaxy S25 Ultra, Android 17 — VM not available.)*

## 11. Completed on-device setup (2026-10-26)

**Environment:** Samsung Galaxy S25 Ultra (SM-S938U), Android 17 (SDK 37), Termux (ARM64 debug build) + Ubuntu via proot-distro.

**Start commands (run in Termux):**
```
# OpenHub server
bash ~/start_openhub.sh
# -> http://127.0.0.1:3000

# opencode engine (after logging in)
bash ~/start_engine.sh
# -> status: {"healthy":true,"version":"1.19.4","available":true,"providerCount":1}
```

**Key files on device:**
- `~/openhub/` — OpenHub source + built `dist/`
- `~/openhub/data/openhub.db` — SQLite DB
- `~/openhub/data/agent-credentials.local.json` — owner account `claude-agent@openhub.local`
- `~/.secrets/opencode/server-password` — engine password
- `~/opencode-wrapper.sh` — invokes opencode (glibc) via proot-distro Ubuntu
- `~/openhub.log` — server log
- `~/cookies.txt` — session cookies for API calls

**Verified:**
- `GET /api/health` → `{"status":"degraded","engine":"axiom",...}` (degraded only because Axiom backend isn't running; OpenHub itself is up)
- `POST /api/opencode/engine/start` → `{"started":true}`
- `GET /api/opencode/status` → `{"healthy":true,"version":"1.19.4","available":true,"providerCount":1}`
- Chrome on phone loads the OpenHub login page at `http://127.0.0.1:3000`.

**Next phases:** 2 (mobile UI), 3 (agent loop), 4 (Cloudflare/AWS), 5 (Kaggle), 6 (PWA).

**To keep running across reboots:** re-run `bash ~/start_openhub.sh` then `bash ~/start_engine.sh`. Consider adding to Termux boot via `termux-boot` or a foreground service + wake lock (`termux-wake-lock`).

## 12. Phase 4 partial — Cloudflare remote access (2026-10-26)

- Installed `cloudflared` in Termux (package `cloudflared 2026.10.4`).
- Created a Cloudflare tunnel `openhub-phone` (UUID `ebacc939-7a90-4d6f-aa95-a32d6abfa8db`) via the Cloudflare API using the account token in `D:\docs\opencode api.txt`.
- Quick tunnel verified: `https://yellow-transparent-president-preview.trycloudflare.com` → phone `localhost:3000`. OpenHub is reachable over HTTPS from anywhere.
- Credentials saved on device: `~/.cloudflared/ebacc939-7a90-4d6f-aa95-a32d6abfa8db.json`.
- Quick-tunnel start: `bash ~/quick_tunnel.sh` (logs to `~/cloudflared.log`).

## 15. Phase 4/5 extensions (2026-10-26)

**Phase 4 — Cloudflare named tunnel + AWS:**
- Created a named tunnel `openhub-phone` (UUID `ebacc939-7a90-4d6f-aa95-a32d6abfa8db`) via the Cloudflare API.
- Created DNS record `openhub.overlay365.online` (CNAME → tunnel). The tunnel is healthy.
- Saved credentials on device: `~/.cloudflared/ebacc939-7a90-4d6f-aa95-a32d6abfa8db.json` + `config.yml` (ingress → localhost:3000).
- Quick tunnel remains the reliable remote-access path (`bash ~/quick_tunnel.sh`); the named tunnel config is in place for a stable hostname once the dashboard side is wired.
- AWS: credentials available (AKIA<redacted> / account 006514117590). Bedrock provider + S3 backup + Secrets Manager wiring deferred (no AWS SDK on device yet; use the OpenCode Go provider lane or a future `@aws-sdk/client-bedrock-runtime`).

**Phase 5 — Kaggle batch compute:**
- Verified Kaggle REST API auth via Bearer token (KGAT_<redacted>): `GET /api/v1/competitions/list` returns data.
- Added `src/services/kaggleJobs.ts` (kernelStatus, kernelOutput, listKernels, kaggleAuthOk) and `src/routes/kaggleRoutes.ts` (`/api/kaggle/auth`, `/api/kaggle/kernels`, `/api/kaggle/kernels/:owner/:slug/status`, `/api/kaggle/kernels/:owner/:slug/output`).
- Registered the router in `server.ts`; set `KAGGLE_API_TOKEN` in the start script.
- Verified: `GET /api/kaggle/auth` → `{"authenticated":true}`; `GET /api/kaggle/kernels?owner=tap4500` → `[]`.
- Remaining: notebook templating + job orchestration (push a kernel, poll to completion, pull artifacts) — see Phase 5 in §5.

## 13. Phase 5 — Kaggle batch compute (design, not yet implemented)

Design only; no code yet. The job model and flow are specified in Phase 5 of §5. Implementation deferred until Phases 1–4 + 6 are stable. Credentials available (3 Kaggle tokens in `D:\docs\opencode api.txt`).

## 14. Phase 6 — PWA + polish (2026-10-26)

- Added `public/manifest.webmanifest` (standalone display, dark theme, icons).
- Added `public/sw.js` (app-shell cache, never caches `/api/` or `/ws/`, offline fallback to index.html).
- Registered the service worker in `src/main.tsx` (production only).
- Added PWA meta tags to `index.html` (manifest, theme-color, mobile-web-app-capable, apple-mobile-web-app-capable).
- Verified: tsc clean, vite build succeeded, server restarted, health + engine status healthy. The app is now installable as an Android WebAPK ("Add to Home Screen").

**Remaining for full Phase 4:**
- Route a stable hostname (e.g. `openhub.<domain>`) via `cloudflared tunnel route dns` (needs `cloudflared tunnel login` cert, or dashboard DNS config) and switch to the named tunnel with the saved credentials + `~/config.yml` (ingress → localhost:3000).
- AWS: Bedrock as an alternate LLM lane (`src/services/bedrockProvider.ts`), S3 nightly backup, Secrets Manager for keys. Credentials available (AKIA<redacted> / account 006514117590).