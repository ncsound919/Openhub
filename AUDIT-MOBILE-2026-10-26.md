# Mobile / opencode / cloud audit — 2026-10-26

Scope: the Android-phone path described in `MOBILE-PLAN.md` — OpenHub under
Termux, Mission Control over the opencode HTTP API, and the AWS / Cloudflare /
Kaggle cloud lanes — audited from the checkout at
`C:\Users\tap45\Downloads\eco\ecosystem\openhub` (branch `main`, working tree
already had uncommitted mobile work).

## Verdict

The core phone loop (login → Mission Control → opencode session → live events →
permission approval) has a working code path, but several things that the plan
marks "complete" were not working in this checkout:

- the installed PWA could not install (manifest icons returned HTML), and its
  service worker pinned the phone to the first cached bundle forever;
- project scoping sent a percent-encoded directory to opencode;
- pending approvals were lost whenever the phone browser reloaded/slept;
- Android notifications were constructed with an API Chrome Android rejects;
- stopping the engine on Android orphaned `opencode serve` on port 4196;
- the built server bundle (`dist/server.js`) never started and served `dist/dist`;
- **AWS is not wired at all**, **Cloudflare exists only as a manual tunnel on the
  device**, and **Kaggle is a read-only, UI-less backend with no job push/poll**.

## Fixed in this pass

| Area | Fix | Files |
|---|---|---|
| PWA install | Added 192/512/maskable icons + Apple touch icon; manifest now declares `id`, `scope`, maskable icon and shortcuts. Chrome had been fetching `/icon-192.png` and receiving the SPA HTML with status 200. | `public/manifest.webmanifest`, `public/icon-*.png`, `public/apple-touch-icon.png`, `index.html` |
| Stale phone app | Service worker is now network-first for navigations, cache-first only for fingerprinted `/assets/*`, and never caches `/api`, `/ws`, `/ntfy`, `/v1`. Cache bumped to v3. Notifications are handled through the SW and open Missions on tap. | `public/sw.js` |
| Mobile first paint | `useIsMobile()` reads matchMedia synchronously, so a phone no longer downloads/paints the desktop dashboard before redirecting. | `src/lib/useIsMobile.ts` |
| opencode scoping | `x-opencode-directory` is sent verbatim. opencode v1.19.4 reads the header raw; the old `encodeURIComponent()` produced a literal `%2Fhome%2F...` directory. | `src/services/opencodeClient.ts` |
| Approvals after sleep/reload | New `GET /api/opencode/permissions` proxy over the engine's `GET /permission`; Mission Control hydrates pending approvals and re-reads on `visibilitychange`/`online`. Permission labels now show `bash: <command>` / `edit: <path>` from the v1.19 request shape. | `src/routes/opencodeProxy.ts`, `src/services/opencodeClient.ts`, `src/mission/useMission.ts`, `src/mission/MissionControlPage.tsx` |
| Completion detection | `session.status { status.type: "idle" }` is accepted as terminal in addition to the deprecated `session.idle`/`session.completed`. | `src/mission/useMission.ts` |
| Phone notifications | Permission request moved into the Run click (Chrome Android ignores mount-time requests); notifications use `ServiceWorkerRegistration.showNotification` instead of `new Notification()` (unsupported on Android Chrome). | `src/mission/MissionControlPage.tsx`, `public/sw.js` |
| Engine lifecycle | POSIX starts the engine in its own process group and kills the whole group on stop/exit (proot wrapper no longer orphans `opencode serve`); password path defaults to `os.homedir()` instead of `USERPROFILE`; Linux default binary is `opencode` from PATH. | `src/services/opencodeEngine.ts` |
| Permission compatibility | Session-scoped reply route falls back to the experimental `POST /permission/:id/reply {reply}` only on 404/405. | `src/services/opencodeClient.ts` |
| Desktop/repo release path | Built server now works: esbuild externals packages, and static root detects `dist` when running `dist/server.js`. `npm start` serves the built bundle as the README claims. | `server.ts`, `package.json` |
| Touch targets | Run/Stop, mission select and Diff/files are ≥44 px on small screens. | `GoalComposer.tsx`, `MissionControlPage.tsx` |
| Remote dev host | Vite allows `.overlay365.online` as a tunnel Host in dev. | `vite.config.ts` |
| Kaggle honesty | `/api/kaggle/auth` returns `configured`; output no longer parses a ZIP as JSON and silently returns `{}` — it reports an archive with size or JSON when that is what Kaggle sent. | `src/routes/kaggleRoutes.ts`, `src/services/kaggleJobs.ts` |
| Secret hygiene | Live-looking tokens/key ids in `MOBILE-PLAN.md` were redacted in place. | `MOBILE-PLAN.md` |
| Docs/tests | `.env.example` documents host/cookie/opencode/Kaggle vars; PWA asset regression test added. | `.env.example`, `tests/pwaAssets.test.ts` |

## Still not working / not built

### 1. AWS — absent (blocking the stated goal)
There is no `@aws-sdk/*` dependency, no Bedrock provider, no S3 backup, no
Secrets Manager loader, and no AWS env vars. `grep` over `src/`, `server.ts`,
`.env.example` and `package.json` finds none. The only AWS reference is the
redacted key id in `MOBILE-PLAN.md`. This needs a decision (region, Bedrock model
access, bucket, whether keys come from the device or Secrets Manager) before
implementation.

### 2. Cloudflare — infrastructure only, no app integration
`cloudflared` and the tunnel live on the phone; nothing in the repo starts,
supervises or reports the tunnel. There is no R2 client, no Cloudflare API
surface, and no Access policy. A quick tunnel changes hostname on restart, which
breaks an installed PWA and any bookmarked URL; the named tunnel needs
`cloudflared tunnel run` plus a DNS route. A public tunnel without Cloudflare
Access exposes the login page (and then the repo/shell surface) to the internet.

### 3. Kaggle — read-only and UI-less
`src/services/kaggleJobs.ts` + `src/routes/kaggleRoutes.ts` expose auth, list,
status and output. There is **no frontend caller**, no kernel push
(`multipart`), no poller/job model and no artifact download. `KAGGLE_API_TOKEN`
is unset in this checkout, so `/api/kaggle/auth` reports
`{ authenticated:false, configured:false }` and kernel routes 502. The plan's
Phase 5 acceptance ("submit a test-suite job from the phone, results appear in
OpenHub") is not met.

### 4. Mobile Phase 3 push loop is incomplete
Mission Control can start, stop, steer, review a diff and rewind, but there is no
"Approve & push" panel, no per-file accept/reject, and no biometric/PIN gate.
Commit/push exists only in the heavy `/editor` page
(`/api/project/active/git/commit|push`), which still mounts Monaco.

### 5. Editor is not gated on phones
`/editor` still loads the 4 MB Monaco chunk on a phone. The plan says hide Monaco
below 768 px unless the user opts in; that behavior is not implemented.

### 6. "Offline read-only" is not real
The service worker caches the shell, but `AuthProvider` calls `/api/auth/me` on
load. Offline, that fails and the app renders the login page, not cached views.
The plan's Phase 6 acceptance is overstated.

### 7. Session history is lossy
opencode sessions carry no status field, the list is capped at 100, and
subagent children are filtered. Every historical mission therefore renders as
`planned`; there is no paging. A reload does not auto-select the last mission.

### 8. Reproducibility of the device setup
There are no `scripts/termux-*.sh` in the repo, no wake-lock/tunnel supervision,
and `ecosystem.config.json` still points at `C:/Users/User/Downloads/...` (stale
PM2 paths). The working setup depends on uncommitted files under `~/`.

## On-device verification checklist

After deploying this build to the phone:

1. Rebuild and restart:
   `npm run build` then the same `tsx server.ts` command from `MOBILE-PLAN.md`.
2. **Clear the old service worker once** (Chrome → site settings → clear data, or
   reinstall the PWA). The old cache-first worker will otherwise keep serving the
   previous bundle until the new worker activates.
3. Confirm `GET /icon-192.png` is `image/png` and the manifest shows 192/512 +
   maskable.
4. Set `OPENHUB_OPENCODE_DIRECTORY` to the repo the agent should edit, and
   `OPENCODE_BIN` to the proot wrapper; restart, start the engine, and verify a
   new session's `directory` is the real path (not `%2F...`).
5. Start a mission, let it request `bash` approval, background the phone, then
   reopen: the approval row must still be there (permissions hydration).
6. Tap Run once and allow notifications; verify the notification arrives when a
   permission is pending and tapping it opens Missions.
7. Stop the engine, then start it again: the second start must succeed (no
   orphan on 4196).
8. From the public tunnel, verify login and the Mission Control SSE stream.

## Verification performed here

- `npm run lint` (tsc) — clean.
- `npx vitest run` — 168 files, 1682 passed, 1 skipped.
- `npm run build` — success; `dist/server.js` 1.1 MB (external packages).
- Built bundle booted on `:3014`: `/` 200 HTML, icons 200 `image/png`, manifest
  `application/manifest+json`, `sw.js` 200; register 201, login 200, `/me` 200.
- `GET /api/opencode/status` → `available:false` (no local engine), sessions and
  permissions → 502 with the honest reason; `/api/kaggle/auth` →
  `{authenticated:false, configured:false}`.
- Not verified: a real Android device run, a live opencode 1.19.4 engine, AWS,
  Cloudflare and Kaggle credentials/network calls.
