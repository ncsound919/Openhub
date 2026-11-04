# Ecosystem → dsh plugin map

How each Overlay365 tool reaches a dsh agent. Three lanes — in cost order.
Rule of thumb: **MCP mount > thin tool bundle > full port**. Never reimplement
a working backend inside a plugin; the plugin is a typed HTTP/stdio skin.

## Lane 1 — MCP mount (no new code)

dsh ships `mcp-client` / `mcp-manager` packages: a stdio MCP server becomes
model tools with zero wrapper code. These three already speak MCP:

| Ecosystem tool | Interface | dsh attachment |
|---|---|---|
| Business-Logic-MCP | stdio MCP, 37 tools | mount as MCP provider in the profile |
| OG-Glass | stdio + Streamable HTTP `/mcp` | mount stdio; HTTP via profile MCP config |
| Middle-Man-MCP | MCP gateway relay | mount; health-gated relay rides along |

Work: profile patch rows only (`OPENHUB_MCP_*` envs already exist for the
engine side). Validate with one `dsh --profile sdk` boot per server.

## Lane 2 — thin tool bundles (this directory)

HTTP services with narrow APIs become `defineTool` plugins, ported from the
executors OpenHub already runs in `src/harness/tools.ts`. Pattern per tool:
`parameters` = shared optional envelope, `output.schema = { type: 'string' }`
summary string, `execute` = one `fetch` with `AbortSignal.timeout`, conditional
`{ when }` registration while its credential is absent.

| Bundle | Tools | Backend | Status |
|---|---|---|---|
| `@overlay365/dsh-fleet` | `fleet.status`, `fleet.service`, `telemetry.summary`, `voice.status` | control plane, Sieve, Kokoro | **shipped (read-only)** |
| `@overlay365/dsh-ops` (next) | `cron.list/pause/enable/run/create/delete`, `plan.create` | control plane | needs dsh policy hook → operator approval path |
| `@overlay365/dsh-agent-support` (next) | `agent.playbooks/playbook_runs/playbook_run/reconcile` | Agent Support :8766 | needs `AGENT_SUPPORT_TOKEN` + policy hook |
| `@overlay365/dsh-audit` (later) | `audit.score`, `audit.deep`, `audit.security` | RepoRank :3200, Grader :3201, Claw-Protect :3300, The Deep :3100 | reuse `ensureCapability` semantics: report down, never fabricate |

Write tools (`cron.*`, `plan.*`, `playbook_run`) MUST go through the dsh policy
hook surface (cookbook `adding-a-tool` → policy hooks) wired back to OpenHub's
operator approval bridge (`/api/dsh/approvals/*`), preserving the fail-closed
rule from `src/harness/tools.ts` (`requiresApproval`). Reads shipped first on
purpose: they cannot change anything.

## Lane 3 — full port (only if lanes 1–2 fail)

`math-x` (compute API :5000) and `BigBack` (generator CLI) are candidates for
deeper integration — math-x as a tool bundle with structured (non-string)
output schemas, BigBack as a `run_in_background` long-task tool. Both need real
local checkouts first (math-x path verified, BigBack has none on this machine).

## Community catalog — surveyed Nov 2026 (4,481 entries, `dsh-plugin-catalog` format-1 index)

Local copy: `.tmp/dshcat/catalog.json`. Install pattern: `dsh plugin --profile <name> add <pkg>`.
Engines column is compatibility with our `0.2.2-alpha.3` pins — ✓ = satisfies declared range.

### Install directly (no new code, fills ecosystem gaps)

| Plugin | Version | Engines | Why |
|---|---|---|---|
| `dsh-push-notify` | 1.0.2 | ✓ | Bark + **ntfy** push for turn end, approvals, questions, quota halts — we already run ntfy; this puts operator approvals on the phone |
| `@opendsh/dsh-plugin-scheduled-tasks` | 0.2.4 | undeclared — verify | Per-project scheduled prompts as fresh headless sessions (cron/interval/once + durable history); candidate to subsume `cron.*` on the dsh side |
| `dsh-email` | 0.21.3 | ✓ `>=0.2.1-rc.3` | IMAP/SMTP tools (list/read/search/send/watch/reply); pairs with the Gmail account already connected |
| `dsh-sql` | 0.5.10 | ✓ `>=0.2.1-rc.3` | Agent DB access (SQLite/MySQL/Postgres) with lexer-grade read-only guard + row caps — same author as dsh-email |
| `dsh-global-todo` | 0.22.0 | ✓ `<0.3.0` | Cross-session todo list both human and agent write to (`global_todo_*` tools) |
| `dsh-monitor` | 0.1.1 | undeclared — verify | Background watchers wake the agent on inbox/command-output delta — the fleet-watcher pattern as a plugin |
| `dsh-mnemon` | 0.5.39 | ✓ `<0.3.0` | Cross-agent local-first persistent memory (Mnemon); alt: `memory-eternal` (SQLite + audit guard, ✓) or `dsh-memory-tiers` |
| `@kialajin/dsh-usage-panel` | 0.1.6 | undeclared — verify | Local usage stats from session logs, provider-aware pricing — cost visibility for the swap |
| `dsh-session-eval` / `dsh-agent-bench` | (catalog) | verify | Retrospective session grading + fixed benchmark cases with deterministic assertions in sandboxes — the **scorers/RepoRank concept already packaged** |
| `@rs-dsh/dsh-automations` | (catalog) | verify | Automation tasks as versioned files (schedule, prompt, model, permission) — cron-as-code |
| `dsh-vps-ops` | (catalog) | verify | Read-first VPS ops (systemd, docker, log tails) — local-box sibling of `fleet.service` |
| `@goodandready/dsh-messenger-gateway` | 0.4.29 | undeclared — verify | Bidirectional Telegram bridge + TTS voice notes — compare with Middle-Man-MCP before building our own |
| `@memef1f1y/dsh-plugin-tts` | 0.6.7 | undeclared — verify | Edge-TTS read-aloud (free) / RVC voices — fallback beside Kokoro, not a replacement |

### Trust & verification (matches our culture — scan before we ship)

| Plugin | Version | Why |
|---|---|---|
| `deepseek-harness-sentinel` | (catalog) | Static scanner for DSH plugins (exec, creds, exfil, obfuscation, install scripts) — **run against `@overlay365/dsh-fleet` before publishing** |
| `@goodandready/dsh-shadow-auditor` | 0.2.35 | Background auditor: secret-leak scan + command-safety checks — Claw-Protect's concerns inside dsh |
| `dsh-wrapup-guard` | 0.1.0 | Check-fix-recheck loop: auto-runs tests/lint/audit, blocks wrap-up with unfixed problems — verification culture as a plugin |
| `dsh-leak-guard` | 0.1.1 | Pre-publish credential walk (API keys, tokens, connection strings) |
| `qiushi-dsh-evidence-audit` | 0.1.0 | Hash-chained JSONL receipts for tool results **without storing prompts/args** — our receipts philosophy, ready-made |
| `dsh-approval-consult` | 1.1.3 | Ask the executing/reviewing AI about a pending approval before allowing — approval-bridge UX |

### Plugin-ops (for our own bundles)

| Plugin | Version | Why |
|---|---|---|
| `dshmarket` (+ its `index.json` source) | (catalog) | In-app market + Discover-tab index for the 4,200+ catalog — install first, it is how the rest get found |
| `dsh-find-plugin` | 0.4.0 | Agent-side registry search with install commands — lets the dsh agent find its own plugins |
| `dsh-slipway` | 0.1.3 | Ship a local plugin to GitHub + market registry PR in one call — our publish path for `@overlay365/*` |

### Deliberately deferred

- **Composio** (1,500+ apps, managed OAuth): overlaps the five accounts already wired via Freebuff integrations; revisit if dsh needs direct SaaS access.
- **UI bundles** (`dsh-web-ui`, `dsh-better-sidebar`, `dsh-TUI`, `dsh-at-file`, `dsh-genui`, vision toolkits): web-profile polish — evaluate after the engine swap proves out, per the locked phase plan.
- **WeChat/QQ/Feishu/LINE bridges** (`dsh-msg-hub`, `dsh-line-bot`, `dsh-feishu-remote`): no such channel in our ecosystem today.

## Deep-dive notes (Nov 4 — READMEs read, scanner run)

- **`dsh-push-notify` — CLEARED for install.** Source-verified from the 1.0.2 tarball:
  `export function apply(ctx, config)` exists (line 67) with `inject = ['webServer', 'connection']` —
  it is a host plugin subscribing to `approval/request`, `user-questions/request`,
  `agent/turn-stopping`, `agent/error`, exactly the phone-alert surface we want. Zero
  dependencies, no install scripts. ntfy side supports self-hosted servers + access
  tokens; per-channel test buttons in Settings. Two caveats, both acceptable: sentinel
  flags SEN-MAN-006 (missing `name`/`apply`) — **false positive**, the export is there;
  and the ntfy token lives in a plaintext config file under home (same posture as our `.env`).
- **`@opendsh/dsh-plugin-scheduled-tasks` — adopt-if-dsh-hosts, not a cron replacement today.**
  Rich (at/every/cron, DST-aware, per-task model override, 20-run history, headless
  sessions) but **fires only while the web process is alive** — same posture as our own
  cron and `dsh-schedule`. No always-on gain until dsh itself is the always-on host.
  Their troubleshooting doc independently confirms the duplicate-`dsh-tools`-copy
  peer-dep lesson we hit. Undeclared engines — verify at install.
- **`dsh-agent-bench` — the "prove dsh out" tool.** Deterministic assertions in sandboxes
  (`file-equals-expect` byte locks, `command` exit codes), LLM review explicitly excluded
  from the regression verdict, isolated `DSH_HOME`, machine-comparable cards
  (`bench_compare` shows 100% → 75% style regressions). Windows-tested. Costs real model
  calls (~2–4 min for 8 cases). Plan: encode our own workflow rules (tests green after
  edits, no stray files) as a bench suite and run it against opencode vs dsh profiles.
- **`deepseek-harness-sentinel` 0.4.4 — works, with a known trigger-happy profile.** Ran it:
  our `@overlay365/dsh-fleet` scores **100/100 DANGEROUS** — all 6 findings are the
  intended design (env token → Bearer header → `fetch`), which is precisely the documented
  "finding means review this evidence" case. Record this as the bundle's audit baseline;
  any *new* finding class on re-scan is the signal, not the score. CLI bypasses the broken
  `.bin` shims via `node node_modules/deepseek-harness-sentinel/bin/sentinel.mjs`;
  install-time audits need no install (`dsh-sentinel npm:<pkg>`, quarantine + sha512).
- **`@goodandready/dsh-messenger-gateway` — not Middle-Man competition.** Multi-transport
  (Telegram/Discord/Slack), pairing codes, per-user sessions, forum topics, `messenger_ask`
  tool, inbound webhook dispatcher for CI/CD alerts. Verdict: if Telegram becomes an
  operator channel, this is the faster path (dsh-native sessions); Middle-Man-MCP stays
  as the generic MCP relay for non-dsh tools (Business-Logic-MCP, OG-Glass). Both, not either/or.

## True gems — README-verified Nov 4 (12 reads; 2 retirements caught)

Catalog blurbs lie by omission. Every entry below was verified against its README;
retired or misdescribed entries are called out so nobody installs them.

### Tier S — adopt

- **`dsh-agent-team-presets`** (bloodarea, v0.1.8, engines ✓): reusable Team presets over
  *native* Agent Teams — per-member model + reasoning effort, per-role tool allow-lists,
  private per-agent skill isolation (assigned skills register strictly in that agent's
  scope), 9 built-in presets incl. a Security Audit team, guarded deletion, MCP boundary
  reporting. Requires Agent Teams enabled on the host. This is the fleet-team console.
- **`dsh-session-bridge`** (heartmove, engines floor-only, **verified against 0.2.2-alpha.3 —
  our exact pin**): create/send/wait/read/resume/find real sessions from a prompt, plus
  monitor (stall detection) and archive. `sinceSeq` anchors, `stale: true` instead of
  losing replies. The fleet-orchestration primitive — OpenHub's control plane driving
  sessions looks like this.
- **`dsh-tri-model`** (eng ✓): plan → execute → review → auto-rework pipeline, four tools
  (`tri_run/review/config/doctor`), secrets in the DSH credential store (never plaintext),
  per-endpoint protocol adapters, `/tri` command. The multi-model story made concrete;
  copy its credential pattern for our bundles.
- **`dsh-oh-my-claude`** (eng ✓): external CLI as a first-class provider — drives
  `claude -p` stream-json, zero runtime deps, maps Claude permission modes onto dsh's
  access shield (approval relay), cost row, SSH workspaces. **Strategic template for
  wrapping opencode as a dsh provider** instead of only calling it over HTTP.
- **`dsh-subagent-models`** (eng ✓): per-conversation + global subagent model/effort routing
  via `agent/request` waterfall, live catalog-driven menus, hot-reloaded JSON file.
  The swappable-models UX, no preset surgery.

### Tier A — strong fit

- **`dsh-env-manager`** (52 vitest tests, eng ✓): environment registry + service catalog +
  deployment bindings + operation→Skill router with approval policy; passwords to the
  credential service, YAML keeps references. Routing returns the bound Skill, never
  executes — our fail-closed philosophy, already built. Study before extending fleet tools.
- **`@stardustlc/dsh-review`** (eng ✓ `>=0.2.1-rc.3`): ten tools, runId + `review_gate`,
  re-check after changes, VALIDATION.md, "AI gate does not replace CI or human approval."
  Benchmark our `ai-review` router against it.
- **`dsh-pause-resume`** (regrevia, eng ✓): wrap-up window before cancel, plan to disk,
  idempotent restore (derived request ids), goal revision as veto, "a journal is reporting,
  not a promise." Copy these durability semantics into OpenHub sessions.
- **`@contexera/dsh-agent-team`** (eng ✓ `<0.2.2` covers our pin): "on the loop, not in it"
  — claim/verify separation (builder never verifies), agent pull-inbox, append-only ledger,
  per-member memory. Compare with presets before choosing the team substrate.
- **`dsh-codex-port`** (STARDUSTLC666, eng ✓) — CORRECTION: not a 577-skill bundle but a
  *porting tool* (list portable skills, preview conflicts, selective import). Still the
  Codex→DSH skill pipeline; same prolific author as dsh-email/sql/review/flakefinder.

### Do not install

- **`dsh-team-rooms`, `dsh-background-agents`** (PerryLink): both RETIRED 2026-10-05,
  superseded by native continuable subagents + Agent Teams. Catalog entries don't say so.
- **`@nanmicoder/dsh-agent-teams`**: ~13k weekly downloads but declared peers stop below
  0.2.1 — the host compat guard skips it on our pin unless exempted per-version.
- **`dsh-laya`**: not approval UX — a PyTorch typed-decision sidecar (pip + 650 MB + GPU).
  Reference only: steal its honesty patterns (truncation/confidence reporting) and its
  sidecar lifecycle (`never`/`attach`/`spawn`) for how OpenHub should treat Kokoro and
  Agent Support sidecars.

## Installed + tested 2026-11-04

- **Profiles** (home `~/.openhub/dsh`): `dev` (compose checks), `webdev`
  (from `web` template — live UI on `127.0.0.1:3080`), `bench` (from `headless`
  template; used by `benchmarks/dsh-agent-bench`).
- **Installed, pinned**: `dsh-push-notify@1.0.2`, `dsh-session-bridge@0.8.0`,
  `dsh-agent-team-presets@0.1.8`, `@deepseek-ai/dsh-experimental-agent-team-profile@0.2.2-alpha.3`
  (the unpinned add pulled stale `0.1.5-alpha.2`, which the host compat-gates —
  always pin). ntfy enabled on topic `openhub-dev-1fe1c5ed` (channel verified
  HTTP 200; subscribe it in the ntfy app).
- **Rejected**: `dshmarket@1.73.10` — reads credential files + env secrets and
  pipes file content to shell. Use the native market bundle instead.
- **Verified live** (webdev boot + in-page API probes): zero mount warnings for
  all four rows; `teamPresets/catalog` + `teamSkills/library` return real data
  (9 built-in teams, builtin skills with bindings); `agent-team-presets` and
  `dsh-session-bridge` settings namespaces registered. Remaining boot warnings
  are pre-existing host damage, unrelated to our plugins: corrupt
  `dsh-otel` lib (telemetry off), `office-to-pdf` restructure ESM bug.
- **Host repairs made along the way** (openhub tree): added missing peer
  `@deepseek-ai/cordis-plugin-group`, 16 missing abstract host deps
  (`dsh-attachment`, `dsh-jobs`, …), repaired 4 corrupt nested `semver` copies
  + `koffi.node`; fixed `dshEngine.ts` to use the official `ReasoningEffortId`
  constructor (tsc clean, 19/19 tests green).
- **Blockers for live model runs**: the harness key exists but the DeepSeek
  account has **insufficient balance** (`QUOTA`); fund it to run turns.
  Bench: `benchmarks/dsh-agent-bench` (4 rule-cases, dsh + opencode adapters,
  heuristic judge) runs end-to-end up to the model call; opencode side needs
  `OPENCODE_BIN`.

Quality signals that worked: `engines.dsh` declared + recent publish date + README
`Requirements` section naming exact host versions + VALIDATION/CHANGELOG docs. The
PerryLink `dsh-plugin-doctor` verified badge is a further trust signal when present.

## Distribution

Bundles publish like any dsh bundle (`docs/user/develop/basic/publish.md`):
npm package with `dsh.bundle.patch`, `engines.dsh` range, installed via
`dsh plugin add` into a profile. For the fleet, ship a private plugin index
(`docs/user/guide/plugin-market.md` + `apps/plugin-market-generator`): one
`index.json` on a static host listing `@overlay365/*` versions so every
machine installs the same pinned set instead of hand-copying directories.
