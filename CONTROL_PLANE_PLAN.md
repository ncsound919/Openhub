# CONTROL_PLANE_PLAN.md — service lifecycle contract

- **Date:** 2026-10-08
- **Status:** active
- **Scope:** how OpenHub may start/stop the fleet's services. Referenced by
  `src/services/autonomyLoop.ts` ("NEVER spawns or stops fleet services … see
  CONTROL_PLANE_PLAN.md"). This file previously did not exist — the contract it
  named was undocumented. It does now.

## The boundary

1. **Autonomy never spawns or stops speculative services.** The heartbeat
   (`autonomyLoop.ts`) probes, learns, and resumes supervised runs. It does not
   cold-start services on its own initiative. (This is why
   `DRAYMOND_AUTOSTART_SERVICES=0` and friends are pinned in
   `serviceManager.MANAGED_SERVICES`.)

2. **Demand-triggered activation is allowed through one gateway.** A consumer
   that genuinely needs a capability calls `ensureCapability(name)`
   (`src/services/serviceGateway.ts`). The gateway probes; if the backing service
   is down *and* on-demand activation is enabled, it starts it via
   `startServiceSafe` and re-probes. It returns an honest result, never a
   fabricated one.

3. **On-demand activation is opt-in.** `OPENHUB_ONDEMAND_SERVICES=1` enables it.
   Unset means "probe only" — consumers still get an honest unavailable, exactly
   as before. Nothing changes until the operator flips it.

4. **Idle services are reaped.** A service OpenHub started and is tracking is
   eligible for `reapIdleServices()` after `OPENHUB_SERVICE_IDLE_TTL_MS`
   (default 30 min) with no activity.

5. **Protected ports are never stopped.** `isProtectedPort` guards OpenHub
   itself (`:3010`) and the auth authority, Keywire (`:4700`). (Was `:3000`,
   which is Grafana on this host — it protected nothing.)

6. **The executor, Draymond, owns autonomous fleet cold-start/failover.** OpenHub
   does not duplicate it; when a capability needs the orchestrator's rules, route
   to Draymond, do not spawn.

## Invariants

- A probe asserting on the HTTP **status code alone** is not a health check; a
  200 from an SPA catch-all or a 401 from an auth-gated endpoint is not "up".
  Prefer a JSON body field, and use the correct liveness path (e.g. LiteLLM's
  `/health/liveliness`, not its auth-gated `/health`).
- `HTTP 4xx` from a real service proves the process is up; only the scorer path
  treats 4xx as "offline" (it cannot do the work). This distinction is deliberate.
- Every start is bounded: wait up to 60s for the port + health to come up; a
  child that never becomes healthy is killed and de-tracked so it cannot pin a
  concurrency slot.
- Concurrency cap: `OPENHUB_MAX_CONCURRENT_SERVICES` (default 5).

## Catalogs (known drift — see the plan)

| Catalog | Count | Role |
|---|---|---|
| `serviceManager.MANAGED_SERVICES` | 14 | the thing the lifecycle manager can start/stop |
| `capabilityRegistry.FLEET_BRIDGES` | ~20 | probe identities + operation contracts |
| `ecosystemRegistry` entities | 43 | the whole-ecosystem audit catalog |
| `start-all.ps1` | 12 | the operator's always-on launcher |
| `ecosystem.config.json` | 2 | pm2 app definitions |

These disagree. The target is a single descriptor merging launch + health +
deps + activation cost + idle TTL. Until then, `MANAGED_SERVICES` is
authoritative for anything the lifecycle manager touches.

## Floor (always-on)

OpenHub (`:3010`), Keywire (`:4700`), LiteLLM (`:4100`), and the shared DB that
the audit scorers need. Everything else may be cold.