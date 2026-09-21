# OpenHub

OpenHub is the operator console and control plane for the Axiom coding harness.
It gives one place to browse repos, run Axiom loops, read the audit/assurance
results, watch the fleet, and work with Recourse, CRM, and SEO.

Axiom is the single execution engine. The earlier Python `vibeserve` MCP bridge
and the in-process orchestrator that spoke to it were removed; every run — a
"pipeline", a mission, a verification loop — is an Axiom project loop whose
stages and gates come from commands Axiom actually executed.

## Surfaces

- **Command** (`/`) — status, active project, autonomy snapshot.
- **Workspace** (`/workspace`) — Monaco editor, terminal, drift, agent dock.
- **Projects** (`/projects`) — local folders + GitHub import.
- **Loops** (`/axiom`) — Axiom project loops: start, watch, stop, rewind, diff.
- **Assurance** (`/assurance`) — pipelines, audit, repair, readiness.
- **Fleet** (`/fleet`) — managed services, agents, ecosystem, toolkit registry.
- **CRM** (`/crm`) — contacts/deals (real integration pending).
- **Insights / Reporter / Activity** — telemetry, trends, self-report, incidents.
- **Settings** — identity, keys, models, integrations.
- **Studio** (`/studio`) — intent → Axiom loop pipeline builder.

Recourse (`:3050`) is integrated over its HTTP API behind `/api/recourse/*`.

## Tech stack

- React 19 + Vite, Tailwind CSS, Framer Motion, Lucide, Zustand
- Node/Express full-stack server, better-sqlite3, WebSocket terminal
- Axiom HTTP API as the execution engine; Keywire as the credential authority

## Build & run

```bash
npm install
npm run dev      # tsx server.ts (default http://localhost:3000)
npm run build    # vite build + esbuild server bundle -> dist/
npm start        # serve the built bundle
```

## Verify

```bash
npm run lint     # tsc --noEmit
npx vitest run   # unit suite
npm run e2e      # playwright (needs a built + running app)
```

## Security & honesty

Zero-trust credentials: secrets resolve from Keywire (or env/file fallback) and
never reach the browser. A bridge that is down reports `available: false` with a
reason — no fabricated scores, no simulated checks.
