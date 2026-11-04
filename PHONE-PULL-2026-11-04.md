# Pull + boot on the phone — 2026-11-04

Pushed: commit `8110e9d` on branch `snapshot/2026-10-28-harness` (dsh engine
swap phase 2, validation service, benches). The laptop tree booted clean on
this exact state before push.

## In Termux on the phone

```bash
cd ~/openhub
git fetch origin
git checkout snapshot/2026-10-28-harness
git pull --ff-only
npm install
node --max-old-space-size=4096 node_modules/vite/bin/vite.js build
termux-wake-lock
OPENHUB_HOST=127.0.0.1 NODE_ENV=production node node_modules/tsx/dist/cli.mjs server.ts
```

Then open phone Chrome to `http://127.0.0.1:3000` and log in.

## What to expect

- OpenHub works exactly as before (opencode path is still the default engine).
- `/api/dsh/*` routes exist but the dsh engine will report `available: false`
  until providers are added — that wiring comes next, no keys needed yet.
- If `git checkout` complains about local changes on the phone, stop and report
  back instead of forcing it.
