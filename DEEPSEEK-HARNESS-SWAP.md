# DeepSeek Harness swap — opencode out, `dsh` + the deep agent in

**Date:** 2026-11-03
**Status:** Phase 2 done (session + prompt + events routes, 30/30 tests green, zero
live-model spend — all faked). opencode remains the default engine until phase 4
(phone proot); Mission Control can target `/api/dsh/*` behind
`OPENHUB_AGENT_ENGINE=dsh`. `abort`/`revert`/`todos`/`diff` answer 501: the
0.2.2-alpha.3 SDK has no such surface.

## Decision

OpenHub's execution engine is replacing `opencode serve` with the **DeepSeek
Harness (`dsh`)** (`deepseek-ai/deepseek-harness` — official, MIT, TypeScript,
npm `@deepseek-ai/dsh`), driven through the **SDK client**
(`@deepseek-ai/dsh-sdk-client`, stdio JSON-RPC). The **deep agent**
(`deepseek-ai/dsh-superagent-prototype` — the DeepSeek-research agent system,
"Towards a More Autonomous Agent System") mounts as a dsh bundle on top once the
harness runtime is trusted. Models stay interchangeable: the provider/model
route is selected per runtime via env, exactly like today's
`OPENHUB_OPENCODE_MODEL` preference list.

Why the SDK profile seam: `dsh --profile sdk` boots a complete harness runtime
(agents, model adapters, tools, persistence, approval policy) that an
out-of-process client drives over newline-delimited JSON-RPC on stdio —
sessions, prompts, event streams, approvals, session resume. This is the same
shape OpenHub already expects from an engine (spawn, health, sessions, prompt,
permissions, events), just on stdio instead of HTTP on :4196.

Reference trees (read, do not modify): `../third_party-references/deepseek-harness/`
(architecture + `packages/sdk/client/README.md` is the client contract),
`deepseek-harness-mobile/` (`dsh-mobile/` — solved the Android proot bootstrap),
`dsh-superagent-prototype/` (the deep agent), `DeepInfer/` + `llama-adreno/`
(phone inference engine guides).

## Verified contract (from the v0.2.1-rc.5 published runtime proto)

- Spawn:
  ```ts
  new DeepSeekHarness({
    profile: 'sdk',          // dsh profile name
    dshHome: '<isolated>',   // this app's own harness home
    provider, model,         // model stays configurable; optional
    reasoningEffort, maxTokens,
    approvalRequests: true,  // operator approvals over the bridge
  })
  ```
- `harness.run(input, { onNotification })` → `RunResult { sessionId, finalResponse, finishReason }`
- `harness.session()` — long-lived session handle; `getWorkingDirectory()`/`setWorkingDirectory()`
- `harness.resumeSession(id)` — persisted restore (replaces opencode session listing reads)
- Approvals: `harness.client.start()` then `harness.client.onRequest(async (method, params) => ({ outcome: 'allowed-once'|'rejected'|'cancelled' }))`
  — runtime fails the approval CLOSED (`unavailable`) when the handler errors or the transport dies
- Notifications: `onNotification` receives every session event + agent status —
  this becomes the Mission Control event stream (replacing the `/event` SSE pump)
- The client spawns `dsh` as a subprocess and reaps it on `close()`; `initializeTimeoutMs`
  defaults to 10 s (matches the opencode health wait of 10 s)
- `@deepseek-ai/dsh` + the client must be the SAME version; npm `latest` dist-tag
  is stale (`0.0.1-rc.1`) — pin both to the matching `next` release

## Mapping opencode surface → dsh

| opencode (today) | dsh (target) | Notes |
|---|---|---|
| `opencodeEngine.ts` spawn + health probe | `dshEngine.ts` (`DeepSeekHarness` owned by OpenHub) | client owns the child; `close()` reaps |
| `GET /global/health` basic auth | client `initialize` handshake | no port/password; identity is the child handle |
| `x-opencode-directory` project scoping | `session.setWorkingDirectory()` | validated absolute path |
| `POST /sessions` + `prompt_async` | `session.run()` (queue + activity interval), `client.prompt()` for literal queue | steering supported natively |
| `GET /permission` + reply route | `approval/request` bridge → pending registry + respond route | fail-closed outcomes preserved |
| shared SSE hub on `/event` | `onNotification` → OpenHub hub → `/api/dsh/events` SSE | phase 2 |
| config overlay (`OPENCODE_CONFIG_CONTENT`) | dsh profile patches + `dshHome` ops | local LLM provider + fleet MCP |
| Electron engines `['opencode','axiom']` | add `'dsh'` | selector env `OPENHUB_AGENT_ENGINE` |

## Env (phase 1)

- `OPENHUB_DSH_BIN` — runtime executable (desktop: unresolved → SDK client resolves
  same-version `@deepseek-ai/dsh`; phone: the proot wrapper path)
- `OPENHUB_DSH_HOME` — isolated harness home (default `~/.openhub/dsh`)
- `OPENHUB_DSH_PROFILE` — default `sdk`
- `OPENHUB_DSH_PROVIDER` / `OPENHUB_DSH_MODEL` / `OPENHUB_DSH_REASONING_EFFORT` / `OPENHUB_DSH_MAX_TOKENS`
- `OPENHUB_DSH_APPROVALS` — default true (approval bridge to the operator paths)
- `OPENHUB_AGENT_ENGINE` — `opencode` (default, unchanged behavior) | `dsh`

## Phases

1. **Engine seam (this pass).** `src/services/dshEngine.ts` +
   `src/routes/dshProxy.ts` (status / engine start+stop / approvals), receipts,
   operator gates, tests. opencode remains the default engine; nothing existing
   changes behavior.
2. **Session + prompt paths.** `/api/dsh/sessions` (create/list via runtime),
   prompt through `session.run()`, steering, abort via runtime, diff/messages
   readers from the session log. Mission Control consumes behind
   `OPENHUB_AGENT_ENGINE=dsh`.
   DONE 2026-11-04 — sessions (create/list/`resumeId` re-entry), prompt via
   `session.run()`, messages + cursor-pollable `/api/dsh/events` off the ring
   (metadata only, never bodies). No steering/abort in SDK 0.2.2-alpha.3, so
   those stay 501. Fakes only; zero provider spend.
3. **Event sweep.** `onNotification` → existing SSE hub shape at
   `/api/dsh/events` (1 MiB backlog drop rule, frame-boundary pings), Mission
   Control hydration on visibilitychange.
4. **Default flip + phone proot.** Proot bootstrap from
   `dsh-mobile/` (container, `DSH_PERMISSION_MODE` pinning — bwrap/Landlock
   unavailable in proot, `--no-open`, token-gate cookie signing from
   `~/.dsh/.credentials.yaml`, plugin self-heal), replacing the opencode
   proot wrapper; THEN make `dsh` the default engine, keep opencode running
   behind `OPENHUB_AGENT_ENGINE=opencode`.
5. **Deep agent.** Mount `dsh-superagent-prototype` as a bundle on the same
   runtime for proactive whole-repo missions (review its docs/000-008 first).
6. **Phone inference engine.** Apply llama-adreno recipe to
   `~/start_local_llm_gpu.sh` (Q4_0 weights, f16 KV, `GGML_SCHED_NO_REALLOC`,
   KleidiAI, Adreno kernels, 4 pinned threads, `--cache-ram` prompt cache);
   DeepInfer is the design *guide* (speculative decoding, prompt caches)
   — it is CUDA/Ascend-only and cannot run on the phone.

## Developer-preview hazard

dsh says: breaking changes will happen. Pin runtime + client to the same exact
npm version, record them here on every bump, and keep the opencode engine intact
until phase 4.
