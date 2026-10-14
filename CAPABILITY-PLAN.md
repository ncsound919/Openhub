# OpenHub + Axiom — Capability Plan

- **Date:** 2026-09-13
- **Scope:** make OpenHub+Axiom a real citizen of the Overlay365 fleet
- **Status: ALL SIX IMPROVEMENTS SHIPPED (2026-09-13)** — each is a real,
  tested implementation with graceful degradation; integration wiring landed in
  `server.ts` (route mounts, memory hooks, Keywire OAuth), `App.tsx` (`/fleet`),
  and Axiom's `src/lib/ecosystem.ts` + `mission.ts`.

---

## Ecosystem awareness (SHIPPED this pass)

OpenHub can now load the fleet's operating context the same way fleet agents do
(SOUL/ECOSYSTEM/STRATEGY/MEMORY/OPS), read the fleet catalog, and inventory the
`.draymond` brain state — read-only, with graceful degradation when unset.

- Service: `openhub/src/services/ecosystem.ts`
- Endpoint: `GET /api/ecosystem/context` (auth-gated)
- Startup log: `[Server] Ecosystem: <root> — layers [soul, ecosystem, strategy, memory, ops], brain files N`
- Env: `OPENHUB_ECOSYSTEM_ROOT`, `OPENHUB_FLEET_CATALOG`, `OPENHUB_DRAYMOND_DIR`
- Tests: `openhub/tests/ecosystem.test.ts` (degraded mode, layer loading, catalog + brain inventory)

**Verified live against the operator's fleet:**
all 5 layers load from `C:/Users/User/Desktop/Ecosystem/rules/overlay365/`;
fleet catalog resolves to the Uplift Lab `OPS-CATALOG.md`; 32 `.draymond` JSON
files inventoried (treasury, goals, lessons, heartbeats, hypotheses, …).

---

## Six capability upgrades

### 1. Ecosystem-aware mission scoping (Axiom planner)
Axiom's plan stage resolves target repos from the ECOSYSTEM map (pillar → path)
and records which revenue engine/pillar a mission serves, so every run is
attributable per STRATEGY priority logic.
- Files: Axiom `src/server/projectLoop.ts` + `mission.ts`; consume
  `src/services/ecosystem.ts` (or a shared copy).
- Acceptance: a mission accepts a pillar name (`Uplift Health`) and resolves to
  a repo path without hardcoded absolute paths.
- Effort: 3–4h.

### 2. Dual-write fleet memory (`.draymond`)
Pipeline completions and audit events append to `learning-lessons.json` and
`recaps.json` per MEMORY.md (append-only; OpenHub never writes treasury/goals).
Makes OpenHub/Axiom work visible to Draymond agents that read brain state.
- Files: `openhub/src/services/ecosystem.ts` (write path), `server.ts`
  `finalizePipelineRun`, `logAuditAction`.
- Acceptance: after a pipeline run, a lesson object appears in
  `.draymond/learning-lessons.json` with `agentId: 'openhub'`.
- Effort: 3–4h.

### 3. Fleet catalog browser + agent dispatch
OpenHub UI renders OPS-CATALOG (57 agents / 127 skills / 36 tools / …) and lets
the operator dispatch a GSD agent on the current repo; streaming output lands in
the existing Actions panel.
- Files: `src/pages/` (new Fleet panel), `server.ts` `/api/ecosystem/agents`.
- Acceptance: pick `gsd-security-auditor` on a repo → real agent output shown in
  the Actions UI.
- Effort: 6–8h.

### 4. Unified LLM routing via the fleet seam
Replace the client-side Gemini key in `PullsView.tsx` with a server route that
calls the fleet's provider seam (DSH/LiteLLM `fleet-free` group per OPS.md,
fallback free → openrouter → ollama → paid Go), credentials resolved via
Keywire. No client keys, sane fallbacks.
- Files: `server.ts` new `/api/ai/review`, `src/pages/PullsView.tsx`.
- Acceptance: PR review works with zero API keys in the browser.
- Effort: 4–6h.

### 5. Mission Control / engine telemetry in the IDE
A "Fleet" panel surfaces `.draymond` KPIs (treasury revenue vs $33k/mo,
system-goals, heartbeats, recaps) and tags each pipeline run with the engine it
serves (E1–E4).
- Files: `src/pages/FleetPanel.tsx`, `server.ts` `/api/ecosystem/kpis`.
- Acceptance: dashboard shows real treasury + goal state from brain files.
- Effort: 6–8h.

### 6. Keywire zero-trust credential resolution
GitHub OAuth, webhooks, MCP, and AI providers resolve secrets through Keywire
per the fleet credential gate (AGENTS.md), keeping the file-based fallback only
for Keywire-down scenarios.
- Files: `src/services/githubService.ts`, `server.ts`, new `src/services/keywire.ts`.
- Acceptance: a GitHub PAT is fetched from Keywire, never from `.env` or code.
- Effort: 4–6h.

---

## Sequencing

All six are shipped. Implementation order this session:
1. Ecosystem service + endpoint + tests (foundation, earlier pass).
2. #6 Keywire (`src/services/keywire.ts`, wired into OAuth routes in `server.ts`).
3. #4 LLM routing (`llmRouter.ts` + `/api/ai/review` + `PullsView.tsx` server-side).
4. #2 Dual-write memory (`ecosystemMemory.ts` + hooks in `finalizePipelineRun`/audit-logs).
5. #5 KPIs + Fleet panel (`fleetKpis.ts` + `/api/ecosystem/kpis` + `FleetPanel.tsx` at `/fleet`).
6. #3 Catalog + dispatch (`fleetCatalog.ts` + `/api/ecosystem/agents` + `/run`; 501 without a gsd CLI).
7. #1 Mission scoping (Axiom `src/lib/ecosystem.ts` + `mission.ts` `applyMissionScoping`).

Follow-ups (documented, not blocking): per-task pillar-dir injection into Axiom
loops, UI polish on `/fleet`, and `OPENHUB_GSD_CLI` before real agent dispatch
can run (endpoint is an honest 501 until then).

---

## Recourse surface deepening (2026-09-14)

OpenHub's Recourse proxy was a 5-route slice. It now covers the meaningful
capability surface, all best-effort with honest `503` degradation:

- **Client** (`src/services/recourseClient.ts`): fixed memory recall to send `q`
  (Recourse's actual param) with `kind`/`topK`, and added `registry`,
  `capabilities`, `upgrade-report`, `provenance`, `agenda/next`,
  `learn/status`, `dream/status`, `selfhosted`, `skills`, `forge/run`, and
  `selfhosted/:name/execute`. `recourseMemoryIndex` now writes external outcomes
  to Recourse's `POST /api/recourse/fleet/memory` (the old `/memory/index` route
  ignored the body) and falls back honestly. Env is resolved per call so
  overrides always apply.
- **Routes** (`src/routes/recourse.ts`): proxied the above under `/api/recourse/*`;
  guarded writes require `RECOURSE_API_SECRET` and fail closed.
- **Snapshot/UI**: `/api/system/snapshot` now reports registry counts + agenda
  head; copilot gained `/recourse-registry`, `/recourse-agenda`, and
  `/recourse-upgrade`.
- **Tests**: `openhub/tests/recourse.test.ts`.
- **Env**: `RECOURSE_URL`, `RECOURSE_API_SECRET`.