# opencode integration — handoff (2026-10-08)

All changes are uncommitted. 46 tests pass in
`tests/{opencodeProxy,opencodeClient,opencodeEngine,useMission}.test.ts`.
NOT run: full suite, `missionControlPage.test.tsx`, `providerHealth.test.ts`, typecheck of `MissionControlPage.tsx`.

## Verified against the live engine (opencode 1.18.35, port 4196)
- `/global/health` returns **401 without basic auth**, 200 with it.
- `GET /session` shape: `id, slug, projectID, directory, path, summary{additions,deletions,files}, cost,
  tokens{input,output,reasoning,cache{read,write}}, title, agent, model{id,providerID,variant}, version,
  time{created,updated}`, plus `parentID` and `permission` (a ruleset array) on subagent sessions.
  No `status` field. 70 of 100 returned sessions were subagent children. The list came back capped at exactly 100.
- Sessions run in the engine's start directory (83/100 in `C:\Users\User\Downloads\BUSINESS`).

## Fixed
| Area | File | Change |
|---|---|---|
| Health probes unauthenticated (engine looked down, start() spawned duplicate) | `src/services/opencodeEngine.ts`, `providerHealth.ts` | `basicAuthHeader()` sent on probes |
| Concurrent start leaked a second engine | `opencodeEngine.ts` | shared in-flight start promise |
| Engine orphaned on OpenHub exit (squats 4196) | `opencodeEngine.ts` | sync `taskkill /T` on process exit; `exit` handler clears stale child |
| Engine logs discarded | `opencodeEngine.ts` | stdout/stderr -> `data/opencode-engine.log` |
| Bin path with spaces broke `shell:true` spawn | `opencodeEngine.ts` | quoted |
| SSE ping spliced mid-frame corrupted events | `src/routes/opencodeProxy.ts` | pings only on frame boundary |
| One upstream `/event` per browser tab | `opencodeProxy.ts` | shared hub; slow clients (>1 MiB backlog) dropped |
| No permission reply route | `opencodeProxy.ts` | `POST /api/opencode/sessions/:id/permissions/:pid` `{response: once\|always\|reject}`, operator-gated |
| Empty prompt forwarded | `opencodeProxy.ts` | 400 |
| No model/agent choice | `opencodeProxy.ts`, `opencodeClient.ts` | optional validated `model{providerID,modelID}`, `agent` |
| No audit trail | `opencodeProxy.ts` | hash-chained receipt (tool `opencode`) per mutating call incl. gate rejections; no prompt text |
| Mission UI couldn't answer permissions | `src/mission/useMission.ts`, `MissionControlPage.tsx` | parses `permission.updated/asked/replied`; Allow once / Always / Deny row |
| Subagent sessions flooded missions rail | `useMission.ts` | `isTopLevelSession` filters `parentID` |
| Clean stream end left mission stuck `running` forever | `useMission.ts` | reconnect unless terminal event seen; retry budget resets after data |
| Successful revert reported as failure (`data === true`) | `useMission.ts` | accepts Session object as success |
| Opt-in project scoping | `opencodeClient.ts` | `OPENHUB_OPENCODE_DIRECTORY` -> `x-opencode-directory` header (header name UNVERIFIED) |

## Open — needs a live engine
Run `scripts/opencode-capture.ps1` (engine must be running on 4196). It writes `data/opencode-capture/`:
`openapi.json` (from `/doc`), `events.txt`, permission list/reply, messages, revert/unrevert, session status.
Then:
1. Confirm permission event name/shape and reply route. opencode may use `POST /permission/:id/reply {reply}`
   instead of `POST /session/:id/permissions/:pid {response}`; the script tries both. Fix `opencodeClient.respondPermission`
   and `parseEventFrame` to match.
2. Confirm `session.idle` is the terminal event (`useMission.subscribeMission`); newer engines may emit `session.status`.
3. Confirm revert/unrevert response shapes; replace the tolerant check with the real one.
4. Confirm `x-opencode-directory` header name, or switch to `?directory=`.
5. Check `GET /session` paging (capped at 100) and `GET /session/status` for live busy/idle (sessions have no status field;
   every historical mission shows as `planned`).
6. Turn `openapi.json` + `events.txt` into fixture-based contract tests; delete the "UNVERIFIED" comments they cover.

## Open — decisions for the owner
- `OPENHUB_ADMIN_ROLES=owner` is set; registration is disabled. Agent/automation testing needs either a seeded
  owner test account or a way to sign in to the in-app browser.
- Who owns port 4196: OpenHub's engine or the desktop app? Decide before adding restart-on-crash supervision.
- GET `/opencode/events`, `/diff`, `/messages` are open to any signed-in user (gate covers mutations only).

## Live capture #2 (2026-10-08, via OpenHub proxy as `claude-agent@openhub.local`, owner)
Fixture: `tests/fixtures/opencode-events.live.txt` (+ contract tests in `tests/useMission.test.ts`).
- Event frame shape CONFIRMED: `{id, type, properties:{sessionID, ...}}`. Seen: `server.connected`, `server.heartbeat` (~every 2.5 s,
  no sessionID), `session.created` (`properties.info` = full session), `session.error`
  (`properties.error.data.message`, first line = reason, rest = stack).
- NOT yet seen: `permission.*`, `session.idle`, revert responses. The run died before reaching them (below).
- **Blocker found: the engine OpenHub spawns has no model providers** -> `ProviderNoProvidersError: No providers are available`
  on the first prompt. The desktop-app engine had `opencode-go` models. Check on the machine:
  `& "$env:APPDATA\npm\opencode.cmd" providers list` (or `auth list`); fix with `opencode auth login` or by exporting the
  provider key in the environment OpenHub is started from. Until fixed, every mission started from OpenHub fails.
- Sessions created through the OpenHub-spawned engine run in `...\INFRASTRUCTURE\openhub` (projectID = git hash), not in
  `...\BUSINESS` (projectID `global`, the desktop app's engine). Two engines, two session lists.
- Running OpenHub server is still the OLD code (restart it to pick up the fixes). Proof: `engine/start` returned
  "did not become healthy in 10s" while `/status` said healthy right after (the 401 health-probe bug).
- Fixed from this capture: `session.error` text now shows the real reason in the timeline (`useMission.parseEventFrame`).
- Test session `ses_ee506078affeGOfLBX3MAHA1Rm` ("openhub contract capture (safe to delete)") left behind; there is no
  delete route in the proxy.
- Test account: `node scripts/create-agent-owner.mjs --delete` removes `claude-agent@openhub.local`.

## Audit pass 3 (2026-10-08)
- `orchestrator/models/providers.ts`: OpenCode Go adapter used host `https://api.opencode.com` + `/v1/chat/completions`
  (wrong host; sent `OPENCODE_API_KEY` there). Now `https://opencode.ai/zen/go/v1` + `/chat/completions`
  (docs.docker.com/ai/docker-agent/providers/opencode-go), overridable via `OPENCODE_GO_BASE_URL`; no request without a key.
  Model names in `createProviderRegistry` (mimo-v2-pro, deepseek-v4-*) are NOT verified against the real model list.
- Proxy: GET routes except `/status` are now operator-only when `OPENHUB_ADMIN_ROLES` is set; prompt `parts` validated (1-20 objects with `type`).
- `/status` adds `providerCount` (UNVERIFIED route `/config/providers`; null when unknown) and the status chip warns at 0.
- Engine: port validated, password file cached 5 s, `stop` says why it did nothing for an engine OpenHub didn't start.
- 55 tests pass (opencodeProxy 14, opencodeClient 4, opencodeEngine 5, opencodeGoProvider 2, useMission 30).
