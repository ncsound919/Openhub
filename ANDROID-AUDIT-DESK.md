# Android Audit Desk in OpenHub mobile

OpenHub now exposes the Android Audit Desk on its own origin, so the phone UI can
read audit snapshots even when OpenHub is reached through a tunnel or another
device.

## What was added

| File | Role |
|---|---|
| `src/routes/androidAudit.ts` | Auth-gated read proxy: health, profiles, integrations, report (json/md/agent-md/agent-json/sarif). |
| `src/pages/AndroidAuditDeskView.tsx` | Mobile-first panel: snapshots, score, severity counts, findings, P0/P1 tasks, download/copy. |
| `src/pages/AssuranceView.tsx` | New **Android Desk** tab. |
| `src/components/Layout.tsx` | Mobile drawer entry **Android Desk** (desktop rail unchanged). |
| `src/services/auditDesk.ts` | Direct client, for code that runs on the same device. |
| `src/services/modelAssignment.ts` | This app's trained-model assignment (`openhub -> qwen-coding-mobile-v2`). |
| `src/services/appModel.ts` | `runAppLlm()`, used by `/v1/chat/completions`. |

## Run it

1. On the phone/PC, start the desk:

   ```bash
   cd "android auditer"
   python android_audit_desktop.py --no-browser
   ```

2. Start OpenHub as usual (`npm run dev`).
3. Open **Assurance → Android Desk**, or on mobile open the drawer → **Android Desk**
   (direct URL: `/android-desk` or `/assurance?av=android`).

If OpenHub runs somewhere other than the desk host:

```bash
set ANDROID_AUDIT_DESK_URL=http://127.0.0.1:8765
set ANDROID_AUDIT_TIMEOUT_MS=15000
```

## Endpoints

| OpenHub route | Desk route |
|---|---|
| `GET /api/android-audit/health` | `GET /api/health` |
| `GET /api/android-audit/profiles` | `GET /api/profiles` |
| `GET /api/android-audit/integrations` | `GET /api/integrations` |
| `GET /api/android-audit/report?id=&format=` | `GET /api/report?id=&format=` |

All routes use the normal OpenHub session auth. The proxy never uploads, scans or
mutates the desk; uploads stay on the desk UI. A desk that is down returns 503
with a reason, never an empty success.

## MCP control plane

`openhub-mcp.ts` now exposes the audit desk and model mesh to agents:

| Tool | Purpose |
|---|---|
| `openhub_android_audit_profiles` | list desk snapshots |
| `openhub_android_audit_report` | full/md/agent-md/agent-json/sarif report by id |
| `openhub_android_audit_tasks` | P0–P3 agent tasks for a snapshot |
| `openhub_evidence_index` | per-app audit index (findings, score, folder) |
| `openhub_model_status` | mesh `/v1/models` + artifact state |
| `openhub_model_route` | deterministic lane choice for a task |

All read-only; failures return `ok:false` with a reason. Set
`ANDROID_AUDIT_DESK_URL` / `LLM_MESH_URL` if the services are not on loopback.
Smoke test: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | npx tsx openhub-mcp.ts`.

## Smoke test

```bash
npx tsx scripts/smoke-android-audit.ts
```

It boots a local router on `:8899`, calls health/profiles/agent-json/agent-md and
exits non-zero if the desk is unreachable.
