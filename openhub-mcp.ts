// openhub-mcp.ts — MCP (Model Context Protocol) stdio server for OpenHub's audit suite.
//
// Purpose: let Axiom call OpenHub's audit suite during coding tasks. Axiom
// spawns this as a stdio MCP server (see AXIOM_MCP_SERVERS in Axiom's .env)
// and its coding loop can then invoke tools like `openhub:openhub_audit_run`.
//
// Like Axiom's own axiom-mcp.ts this is pure Node, one JSON-RPC message per
// line on stdin/stdout, no SDK dependency. It imports the audit suite directly,
// so it needs no OpenHub HTTP session or auth token.
//
// Smoke test:
//   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | npx tsx openhub-mcp.ts
//   echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'        | npx tsx openhub-mcp.ts

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import "dotenv/config";
import { executeAuditSuite, AUDIT_PRESETS, AUDIT_STAGES, type AuditPresetName, type AuditReport, type AuditStageName, type ScorerName } from "./src/services/auditSuite.js";
import { loadAuditConfig } from "./src/core/config.js";
import { runAuditCore, runRulesForRepo, makeCoreCompleter, makeTextCompleter } from "./src/services/auditCore.js";
import { generateAutofixes, parseFixResponse, type FixGenerator } from "./src/core/autofix.js";
import {
  listRegistry,
  refreshRegistry,
  auditRegistry,
  summarizeRegistry,
  type EntityKind,
  type HealthStatus,
  type RegistryQuery,
} from "./src/services/ecosystemRegistry.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "openhub-audit";
const SERVER_VERSION = "1.0.0";
const MAX_FINDINGS_RETURNED = 50;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SEVERITY_TO_REVIEWDOG: Record<string, "ERROR" | "WARNING" | "INFO"> = {
  critical: "ERROR",
  high: "ERROR",
  medium: "WARNING",
  low: "INFO",
  info: "INFO",
};

export const TOOLS: ToolDef[] = [
  {
    name: "openhub_audit_run",
    description:
      "Run OpenHub's audit suite against a local directory (reporank, grader, The Deep, SonarQube, SCA/secrets, IaC, typecheck, lint, tests, and more). Pick a preset for depth (quick/standard/deep/release) or a build stage (pre-commit/pr/merge/nightly/release) to run the right gate and feed the learning loop. Returns the reconciled score, gate verdict, per-scorer outcomes, and top findings. A tool that is not configured is reported as unavailable, never scored as zero.",
    inputSchema: {
      type: "object",
      properties: {
        target_dir: { type: "string", description: "Absolute path to the local checkout to audit." },
        repo_url: { type: "string", description: "Optional GitHub URL (owner/repo) for the LLM repo graders." },
        scorers: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of scorers to run (default: the full suite).",
        },
        full: { type: "boolean", description: "Force a full-tree audit instead of diff-scoped." },
        base: { type: "string", description: "Git base ref for a diff-scoped audit." },
        preset: {
          type: "string",
          enum: ["quick", "standard", "deep", "release"],
          description: "Depth preset. Explicit scorers always win over a preset.",
        },
        stage: {
          type: "string",
          enum: ["pre-commit", "pr", "merge", "nightly", "release"],
          description: "Build lifecycle stage. Implies its preset, evaluates a gate, and always feeds the learning loop.",
        },
        core: {
          type: "boolean",
          description: "Run the shared audit core over the findings (validation/lifecycle/gate) and attach it as report.core. Recommended for actionable runs.",
        },
      },
      required: ["target_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "openhub_audit_scorers",
    description: "List every scorer the OpenHub audit suite can run, with its category and whether it is currently configured (env present).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openhub_reviewdog_rdjson",
    description:
      "Run the audit suite and return findings as reviewdog rdjson (or rdjsonl). Optionally pipes to the reviewdog binary when REVIEWDOG_CMD is set. Use reviewdog for diff-scoped inline PR comments; this tool works with or without a PR.",
    inputSchema: {
      type: "object",
      properties: {
        target_dir: { type: "string", description: "Absolute path to the local checkout to audit." },
        repo_url: { type: "string", description: "Optional GitHub URL for the LLM graders." },
        format: { type: "string", enum: ["rdjson", "rdjsonl"], description: "Output format (default rdjson)." },
        invoke_reviewdog: { type: "boolean", description: "When REVIEWDOG_CMD is set, run it with -reporter=local and return its output." },
      },
      required: ["target_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "openhub_pr_agent_review",
    description:
      "Run PR-Agent (Qodo) as an LLM reviewer when PR_AGENT_CMD is configured. PR-Agent output is narrative only and is never scored. Returns configured:false with a reason when PR-Agent is not set up.",
    inputSchema: {
      type: "object",
      properties: {
        pr_url: { type: "string", description: "Pull request URL to review." },
        extra_args: { type: "array", items: { type: "string" }, description: "Extra CLI arguments for PR-Agent." },
      },
      required: ["pr_url"],
      additionalProperties: false,
    },
  },
  {
    name: "openhub_service_status",
    description: "Report which audit services/tools are configured in the OpenHub environment (reporank, grader, The Deep, SonarQube, PR-Agent, reviewdog). Does not make network calls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openhub_core_config",
    description: "Load the repo audit config (openhub.yaml): plain-English rules, path filters/instructions, tool toggles, and PR/release gate. Returns defaults plus explicit errors/warnings when absent or invalid.",
    inputSchema: { type: "object", properties: { target_dir: { type: "string", description: "Absolute path to the repo." } }, required: ["target_dir"], additionalProperties: false },
  },
  {
    name: "openhub_core_run",
    description: "Run the shared audit core over findings: deterministic validation (reachability/staleness, stale pruning), persistent finding lifecycle (new/persisting/reopened/resolved, auto-resolve), and the configured PR/release gate. Use to turn any tool's findings (The Deep, RepoRank, CodeNexus, local analyzers) into an actionable, de-duplicated backlog.",
    inputSchema: {
      type: "object",
      properties: {
        target_dir: { type: "string" },
        findings: { type: "array", items: { type: "object" }, description: "Findings in the shared shape (source, category, severity, confidence, determinism, location{file,line}, evidence, remediation)." },
        changed_lines: { type: "number", description: "Changed line count for the gate's max_changed_lines cap." },
        labels: { type: "array", items: { type: "string" }, description: "PR labels for the gate's ignore_labels." },
        persist: { type: "boolean", description: "Persist the reconciled lifecycle (default true)." },
      },
      required: ["target_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "openhub_core_rules",
    description: "Evaluate the repo's plain-English rules (openhub.yaml) against the target directory using the configured model. Reports configured:false (never a fake pass) when no LLM endpoint is set.",
    inputSchema: { type: "object", properties: { target_dir: { type: "string" } }, required: ["target_dir"], additionalProperties: false },
  },
  {
    name: "openhub_core_autofix",
    description: "Generate concrete patches for findings: deterministic dependency upgrades where possible, model-generated unified diffs otherwise. Every suggestion carries a confidence level; unsafe/oversized fixes are skipped, never fabricated.",
    inputSchema: {
      type: "object",
      properties: {
        target_dir: { type: "string" },
        findings: { type: "array", items: { type: "object" } },
        provider: { type: "string" },
      },
      required: ["target_dir"],
      additionalProperties: false,
    },
  },
  {
    name: "openhub_ecosystem_state",
    description:
      "Quick-recall snapshot of the Overlay365 ecosystem: every fleet service, tool, pillar project and Ecosystem extension pack with its stack, purpose, audit ranking score, and percentage to fully realized deployability. Use for 'what does the fleet have / what is the state of X' questions. Reads the persisted registry + curated seed without network calls; returns totals, health breakdown, and the audit ranking.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openhub_ecosystem_list",
    description:
      "Query the ecosystem registry. Filter by kind (service/tool/project/pack), pillar, health, minimum deployability, or free-text search over name/purpose/stack/tags. Returns each entry's stack, purpose, audit score + grade (with its source), deployability %, blockers, and evidence.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["service", "tool", "project", "pack"] },
        pillar: { type: "string", description: "Pillar/dir grouping, e.g. platform, audit, llm, memory, product, pillar, app, ecosystem-pack." },
        health: { type: "string", enum: ["online", "degraded", "offline", "unknown"] },
        search: { type: "string" },
        min_deployability: { type: "number", description: "Only entries at or above this deployability percentage." },
        sort: { type: "string", enum: ["deployability", "audit", "name"] },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "openhub_ecosystem_refresh",
    description:
      "Re-probe live fleet health through the capability registry, recompute deployability from the six-factor rubric, persist the refreshed overlay, and return the updated ecosystem state. Set audit:true to also run live RepoRank + Grader (GitHub) and The Deep (local dir) scoring on entities that have an audit target. Slower than openhub_ecosystem_state (real HTTP/TCP probes and audits); use when current liveness/scores matter.",
    inputSchema: {
      type: "object",
      properties: {
        audit: { type: "boolean", description: "Also run live audit scoring (RepoRank/Grader/Deep)." },
        ids: { type: "array", items: { type: "string" }, description: "Limit the live audit to these entity ids." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "openhub_ecosystem_audit",
    description:
      "Live-score ecosystem entities with RepoRank + Grader (GitHub repos) and The Deep (local dirs), aggregate the scores, persist them, and return the updated ranking with per-scorer outcomes. Bounded by `limit` (default 6); pass `ids` to score specific entities. Scorers that are unconfigured or unreachable are reported unavailable with their error — never scored as zero.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Entity ids to audit (default: first N eligible)." },
        limit: { type: "number", description: "Max entities to audit when ids is not given (default 6, max 50)." },
      },
      additionalProperties: false,
    },
  },
];

function configured(name: string): boolean {
  return Boolean(process.env[name]);
}

function serviceStatus(): Record<string, unknown> {
  return {
    reporank: { configured: configured("REPORANK_API_KEY"), url: process.env.REPORANK_URL || "http://127.0.0.1:3200" },
    grader: { configured: configured("GRADER_API_KEY"), url: process.env.GRADER_URL || "http://127.0.0.1:3201" },
    deep: { configured: configured("DEEP_URL"), url: process.env.DEEP_URL || "not configured" },
    sonarqube: { configured: configured("SONAR_URL") && configured("SONAR_TOKEN"), url: process.env.SONAR_URL || "not configured" },
    pr_agent: { configured: configured("PR_AGENT_CMD"), command: process.env.PR_AGENT_CMD || null },
    reviewdog: { configured: configured("REVIEWDOG_CMD"), command: process.env.REVIEWDOG_CMD || null },
  };
}

function summarizeReport(report: AuditReport): Record<string, unknown> {
  const findings = [...report.findings]
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>;
      return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
    })
    .slice(0, MAX_FINDINGS_RETURNED)
    .map((f) => ({
      source: f.source,
      severity: f.severity,
      category: f.category,
      file: f.location?.file ?? null,
      line: f.location?.line ?? null,
      evidence: (f.evidence ?? "").slice(0, 200),
    }));

  return {
    target: report.target,
    overallScore: report.overallScore,
    overallScoreDeterministic: report.overallScoreDeterministic,
    grade: report.grade,
    status: report.overallStatus,
    coveragePercent: report.coveragePercent,
    scope: { mode: report.scope.mode, changedFiles: report.scope.changedFiles?.length ?? 0 },
    stage: report.stage ?? null,
    gate: report.gate ?? null,
    counts: {
      total: report.findings.length,
      returned: findings.length,
      critical: report.findings.filter((f) => f.severity === "critical").length,
      high: report.findings.filter((f) => f.severity === "high").length,
    },
    scorers: report.results.map((r) => ({
      scorer: r.scorer,
      status: r.status,
      score: r.score,
      summary: (r.summary ?? "").slice(0, 200),
      error: r.error ? r.error.slice(0, 200) : undefined,
    })),
    findings,
  };
}

interface RdjsonDiagnostic {
  message: string;
  location: { path: string; range?: { start: { line: number; column: number }; end: { line: number; column: number } } };
  severity: "ERROR" | "WARNING" | "INFO";
  code: { value: string };
  original_output: string;
}

function toRdjson(report: AuditReport): { source: { name: string }; severity: string; diagnostics: RdjsonDiagnostic[] } {
  const diagnostics: RdjsonDiagnostic[] = [];
  for (const f of report.findings) {
    const file = f.location?.file;
    if (!file) continue;
    const line = f.location?.line;
    const range = line !== undefined
      ? { start: { line, column: 1 }, end: { line: f.location?.endLine ?? line, column: 1 } }
      : undefined;
    diagnostics.push({
      message: f.evidence || f.category,
      location: { path: file, ...(range ? { range } : {}) },
      severity: SEVERITY_TO_REVIEWDOG[f.severity] ?? "INFO",
      code: { value: f.category },
      original_output: `${f.source} (${f.determinism}) ${f.category}`,
    });
  }
  const severity = diagnostics.some((d) => d.severity === "ERROR")
    ? "ERROR"
    : diagnostics.some((d) => d.severity === "WARNING")
      ? "WARNING"
      : "INFO";
  return { source: { name: "openhub-audit" }, severity, diagnostics };
}

function runCommand(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 180_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.slice(0, 20_000) });
    });
  });
}

function requireTarget(args: Record<string, unknown>): string {
  const target = args.target_dir;
  if (typeof target !== "string" || !target.trim()) throw new Error("target_dir is required");
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`target_dir does not exist: ${abs}`);
  return abs;
}

const REGISTRY_KINDS = new Set<EntityKind>(["service", "tool", "project", "pack"]);
const REGISTRY_HEALTH = new Set<HealthStatus>(["online", "degraded", "offline", "unknown"]);

function registryQuery(args: Record<string, unknown>): RegistryQuery {
  const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
  const health = typeof args.health === "string" ? args.health.trim().toLowerCase() : "";
  const sort = typeof args.sort === "string" ? args.sort.trim().toLowerCase() : "";
  const min = typeof args.min_deployability === "number" ? args.min_deployability : Number(args.min_deployability);
  const limit = typeof args.limit === "number" ? args.limit : Number(args.limit);
  return {
    ...(kind && REGISTRY_KINDS.has(kind as EntityKind) ? { kind: kind as EntityKind } : {}),
    ...(typeof args.pillar === "string" && args.pillar.trim() ? { pillar: args.pillar.trim() } : {}),
    ...(typeof args.search === "string" && args.search ? { search: args.search } : {}),
    ...(health && REGISTRY_HEALTH.has(health as HealthStatus) ? { health: health as HealthStatus } : {}),
    ...(Number.isFinite(min) ? { minDeployability: min } : {}),
    ...(["deployability", "audit", "name"].includes(sort) ? { sort: sort as RegistryQuery["sort"] } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "openhub_audit_run": {
      const targetDir = requireTarget(args);
      if (args.preset !== undefined && (typeof args.preset !== "string" || !(args.preset in AUDIT_PRESETS))) {
        throw new Error(`unknown preset "${String(args.preset)}" (expected one of ${Object.keys(AUDIT_PRESETS).join(", ")})`);
      }
      if (args.stage !== undefined && (typeof args.stage !== "string" || !(args.stage in AUDIT_STAGES))) {
        throw new Error(`unknown stage "${String(args.stage)}" (expected one of ${Object.keys(AUDIT_STAGES).join(", ")})`);
      }
      const report = await executeAuditSuite({
        targetDir,
        ...(typeof args.repo_url === "string" ? { repoUrl: args.repo_url } : {}),
        ...(Array.isArray(args.scorers) ? { scorers: args.scorers as ScorerName[] } : {}),
        ...(args.full === true ? { full: true } : {}),
        ...(typeof args.base === "string" ? { base: args.base } : {}),
        ...(typeof args.preset === "string" ? { preset: args.preset as AuditPresetName } : {}),
        ...(typeof args.stage === "string" ? { stage: args.stage as AuditStageName } : {}),
        ...(args.core === true ? { core: true } : {}),
      });
      return summarizeReport(report);
    }

    case "openhub_audit_scorers":
      return {
        services: serviceStatus(),
        availableScorers: [
          "reporank", "grader", "deep", "sonarqube", "sca", "claw", "codegraph", "ocr", "codegang",
          "local_qa", "typecheck", "lint", "deps_freshness", "licenses_sbom", "duplication", "perf",
          "a11y", "api_contract", "git_history", "iac",
        ],
        presets: Object.fromEntries(
          Object.entries(AUDIT_PRESETS).map(([name, p]) => [
            name,
            { scorers: p.scorers, full: p.full, description: p.description },
          ]),
        ),
        stages: Object.fromEntries(
          Object.entries(AUDIT_STAGES).map(([name, s]) => [
            name,
            { preset: s.preset, minScore: s.minScore, memory: s.memory, description: s.description },
          ]),
        ),
      };

    case "openhub_reviewdog_rdjson": {
      const targetDir = requireTarget(args);
      const report = await executeAuditSuite({
        targetDir,
        ...(typeof args.repo_url === "string" ? { repoUrl: args.repo_url } : {}),
      });
      const rdjson = toRdjson(report);
      const format = args.format === "rdjsonl" ? "rdjsonl" : "rdjson";
      const body = format === "rdjsonl"
        ? rdjson.diagnostics.map((d) => JSON.stringify(d)).join("\n")
        : JSON.stringify(rdjson, null, 2);

      const reviewdogCmd = process.env.REVIEWDOG_CMD;
      if (args.invoke_reviewdog === true && reviewdogCmd) {
        const res = await runCommand(reviewdogCmd, ["-f=rdjsonl", "-reporter=local"], targetDir);
        return { reviewdogRan: true, ok: res.ok, reviewdogOutput: res.output, diagnosticCount: rdjson.diagnostics.length };
      }
      return {
        format,
        diagnosticCount: rdjson.diagnostics.length,
        reviewdogConfigured: Boolean(reviewdogCmd),
        hint: reviewdogCmd
          ? "Pipe this to reviewdog: reviewdog -f=rdjson -reporter=github-pr-review"
          : "Set REVIEWDOG_CMD to the reviewdog binary to enable invocation",
        rdjson: format === "rdjsonl" ? body.slice(0, 50_000) : JSON.parse(body),
      };
    }

    case "openhub_pr_agent_review": {
      const cmd = process.env.PR_AGENT_CMD;
      if (!cmd) {
        return { configured: false, reason: "PR_AGENT_CMD not set — PR-Agent not configured", narrative: null };
      }
      const prUrl = args.pr_url;
      if (typeof prUrl !== "string" || !prUrl) throw new Error("pr_url is required");
      const extra = Array.isArray(args.extra_args) ? (args.extra_args as string[]) : [];
      const res = await runCommand(cmd, [prUrl, ...extra]);
      return { configured: true, ok: res.ok, narrative: res.output, scored: false, note: "PR-Agent output is narrative only and is never scored." };
    }

    case "openhub_service_status":
      return serviceStatus();

    case "openhub_core_config": {
      const target = requireTarget(args);
      return loadAuditConfig(target);
    }

    case "openhub_core_run": {
      const target = requireTarget(args);
      const findings = Array.isArray(args.findings) ? (args.findings as Record<string, unknown>[]) : [];
      return runAuditCore({
        rootDir: target,
        findings: findings as never,
        ...(typeof args.changed_lines === "number" ? { changedLines: args.changed_lines } : {}),
        ...(Array.isArray(args.labels) ? { labels: args.labels.map(String) } : {}),
        ...(args.persist === false ? { persist: false } : {}),
      });
    }

    case "openhub_core_rules": {
      const target = requireTarget(args);
      const complete = makeCoreCompleter();
      if (!complete) {
        return { configured: false, note: "no LLM configured (set OPENHUB_LLM_BASE_URL / OPENHUB_LLM_MODEL)", findings: [], evaluated: [], skipped: [], errors: [] };
      }
      return { configured: true, ...(await runRulesForRepo(target, complete)) };
    }

    case "openhub_core_autofix": {
      const target = requireTarget(args);
      const findings = Array.isArray(args.findings) ? (args.findings as Record<string, unknown>[]) : [];
      const text = makeTextCompleter();
      if (!text) return { configured: false, note: "no LLM configured", suggestions: [], skipped: [], errors: [] };
      const generate: FixGenerator = async ({ system, prompt }) => parseFixResponse(await text(system, prompt));
      const result = await generateAutofixes(findings as never, {
        readFile: (file) => {
          const abs = path.resolve(target, file);
          if (abs !== target && !abs.startsWith(target + path.sep)) return null;
          try {
            return fs.readFileSync(abs, "utf-8");
          } catch {
            return null;
          }
        },
        generate,
        ...(typeof args.provider === "string" && args.provider ? { provider: args.provider } : {}),
      });
      return { configured: true, ...result };
    }

    case "openhub_ecosystem_state": {
      const snapshot = listRegistry({ limit: 500 });
      return {
        summary: summarizeRegistry(snapshot),
        totals: snapshot.totals,
        ranking: snapshot.ranking,
        entities: snapshot.entries.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind,
          pillar: e.pillar,
          stack: e.stack,
          purpose: e.purpose,
          auditScore: e.auditScore,
          auditGrade: e.auditGrade,
          auditSource: e.auditSource,
          deployability: e.deployability,
          health: e.health,
          blockers: e.blockers,
        })),
      };
    }

    case "openhub_ecosystem_list": {
      const snapshot = listRegistry(registryQuery(args));
      return { summary: summarizeRegistry(snapshot), totals: snapshot.totals, entries: snapshot.entries };
    }

    case "openhub_ecosystem_refresh": {
      const ids = Array.isArray(args.ids) ? (args.ids as string[]).map(String) : undefined;
      const snapshot = await refreshRegistry({
        ...(args.audit === true ? { audit: true } : {}),
        ...(ids && ids.length ? { auditIds: ids } : {}),
      });
      return { summary: summarizeRegistry(snapshot), totals: snapshot.totals, ranking: snapshot.ranking, entries: snapshot.entries };
    }

    case "openhub_ecosystem_audit": {
      const ids = Array.isArray(args.ids) ? (args.ids as string[]).map(String) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : Number(args.limit);
      const result = await auditRegistry({
        ...(ids && ids.length ? { ids } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      return {
        summary: summarizeRegistry(result.snapshot),
        auditedAt: result.auditedAt,
        audited: result.audited,
        skipped: result.skipped,
        ranking: result.snapshot.ranking,
      };
    }

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function respond(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function respondError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function toolResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = req;
  try {
    switch (method) {
      case "initialize":
        return respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "notifications/initialized":
        return respond(id, {});
      case "tools/list":
        return respond(id, { tools: TOOLS });
      case "tools/call": {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!p.name) throw new Error("tools/call requires params.name");
        return respond(id, toolResult(await callTool(p.name, p.arguments ?? {})));
      }
      case "ping":
        return respond(id, {});
      default:
        return respondError(id, -32601, "Method not found", { method });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return respondError(id, -32603, message || "Internal error", { method });
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify(respondError(null, -32700, "Parse error", { message })) + "\n");
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      process.stdout.write(JSON.stringify(respondError(req.id ?? null, -32600, "Invalid Request")) + "\n");
      return;
    }
    const res = await handleRequest(req);
    if (req.id !== undefined && req.id !== null) process.stdout.write(JSON.stringify(res) + "\n");
  });
  rl.on("close", () => process.exit(0));
}

// Run only when executed directly (import-safe for tests).
const isMain = process.argv[1] && /openhub-mcp\.(ts|cjs|js)$/.test(process.argv[1]);
if (isMain) main();
