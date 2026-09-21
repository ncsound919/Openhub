# LocalHub → Axiom: Upgrade & Integration Plan

- **Date:** 2026-09-13
- **Scope:** finish hardening the (formerly `ncsound919/localhub`) codebase now vendored at `openhub/`, then merge it into Axiom Agent.
- **Status:** Phase 0 complete; Phase 1–4 planned below.

---

## Where we are

LocalHub source is now vendored at `openhub/` inside the Axiom repo (staged for
git; `node_modules/` and `data/` ignored). Its real package name is `openhub`;
its GitHub repo name was `localhub`. The plan below treats "OpenHub" as the UI/IDE
+ GitHub + MCP front-end, and Axiom as the deterministic verification + planning
brain, then converges them into one tool.

---

## Phase 0 — Audit + security hardening (DONE this pass)

- Enabled `strict: true`; fixed 5 latent type errors.
- Hardened path traversal (`isSubpath()`).
- Added auth to unauthenticated `GET /api/repos/:owner/:repoName/contents`.
- Removed fabricated secret-scan inputs (`CodeView`).
- **C1** — gated `/api/auth/quick-access` behind `ALLOW_QUICK_ACCESS=1` (default off).
- **C2** — gated demo account seeding behind `SEED_DEMO_ACCOUNTS=1` (default off).
- **H1** — replaced hardcoded fallback JWT secrets with a persistent file fallback
  (`~/.openhub/emergency-keys.json`, regenerated only if missing/corrupt).
- **H2** — restricted credentialed CORS to an `ALLOWED_ORIGINS` allowlist.
- Lockfile repaired (bun rewrote `bun.lock` to a parseable `lockfileVersion: 1`).

Verification: `tsc --noEmit` (strict) = clean; `vitest` = 18/18; `esbuild` bundle = clean.

---

## Phase 1 — Finish LocalHub hardening (before integration)

These must be complete before merging so Axiom inherits no theater or unsafe code.

| # | Task | File(s) | Acceptance |
|---|------|---------|------------|
| 1.1 ✅ | Replace the simulated CI pipeline with real stage execution | `openhub/server.ts` | DONE — real secret scan + `tsc --noEmit` + test runner via async `exec`; stage/gate status derived from executed output, no timers |
| 1.2 | Replace the "Git Push simulation" + fake pre-receive hook and hardcoded `password123` scan | `openhub/src/pages/CodeView.tsx` | Real write + scan path; no fabricated secrets/latency |
| 1.3 | Remove fabricated webhook simulator payload | `openhub/server.ts` `/api/github/webhook/test-ping` | Endpoint removed or clearly labeled test-only and gated |
| 1.4 | Fix `username` vs `firstName` token mismatch | `openhub/server.ts` `buildTokenPayload`, `src/auth/ana-user-store.ts` | `user.username` = DB `username` column; repos resolve consistently |
| 1.5 | Move Gemini AI review server-side | `src/pages/PullsView.tsx` → new `/api/github/:owner/:repo/pulls/:id/review` | No client-side `GEMINI_API_KEY` |
| 1.6 | Dependency hygiene: move build/dev deps out of `dependencies`; drop duplicate `vite` | `package.json` | Clean prod/dev split |
| 1.7 | MCP handshake + reconnect; add an integration test for `/api/mcp/:tool` and WebSocket orchestrator | `server.ts`, `orchestrator/mcp-client.ts`, `tests/` | Real tool round-trip asserted |
| 1.8 🔶 | Add unit tests for the security fixes | `tests/` | Partial — `pathGuard.test.ts` + `secretScan.test.ts` added (9 tests); quick-access/CORS supertest pending server `createApp` refactor |

---

## Phase 2 — Unify verification (the core integration)

Axiom owns "plan → codegen → verify → promote". OpenHub owns "UI/IDE + GitHub + MCP".

- Replace OpenHub's `/api/pipeline/run` with a call to Axiom's
  `POST /api/project/run` (or `POST /api/mission/run`) using an internal service
  token, and stream Axiom gate results back over OpenHub's WebSocket.
- Map Axiom gates to OpenHub pipeline stages:
  - typecheck → "Lint & Typecheck"
  - vitest → "Tests"
  - deep audit → "AI Code Review"/"Security Scan"
  - promotion decision → "Gate"
- Reuse Axiom's `src/server/pipeline.ts` + `projectLoop.ts` instead of
  `orchestrator/pipeline/unifiedPipeline.ts` for the verify/decision path.

Acceptance: a LocalHub "Run Pipeline" action produces a real Axiom mission whose
stage statuses are populated by Axiom's executed gates, with a non-simulated
pass/fail.

---

## Phase 3 — Unify MCP

- Single tool registry. Bridge `openhub/orchestrator/mcp-client.ts` + `vibeserve`
  (Python) with Axiom's `axiom-mcp.ts`.
- `vibeserve` tools (`pipeline_tools.py`, `file_tools.py`) become one namespace
  alongside Axiom's `axiom_*` tools.
- Add a shared schema for tool results so either caller can validate responses.

Acceptance: one MCP server exposes both tool sets; a single integration test
round-trips a tool from both bridges.

---

## Phase 4 — Unify auth

- Allow a LocalHub (awesome-node-auth) session to dispatch Axiom missions via an
  internal, short-lived service token (Keywire SVID or signed HMAC), never
  exposing Axiom gate endpoints unauthenticated.
- Collapse to one identity provider (recommend Axiom's Keywire for fleet/zero-trust
  properties; keep awesome-node-auth only for the local single-user IDE).

Acceptance: a logged-in OpenHub user can run a mission; Axiom gate endpoints
reject unauthenticated calls.

---

## Phase 5 — Consolidate identity

- Merge `openhub/package.json` into Axiom's; rename product strings "OpenHub" →
  the final tool name; remove the separate `openhub/` sub-package once code is
  absorbed into `src/`.
- Single `npm run dev`, single test suite, single changelog.

---

## Definition of done (integration)

1. No simulated verification anywhere (agent-rules compliance).
2. Every verification number comes from an executed command.
3. Both unit + E2E suites pass in one command.
4. `tsc --noEmit` strict clean across the combined codebase.
5. MCP and auth round-trips covered by integration tests.
