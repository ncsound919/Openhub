/**
 * Shared ecosystem event contract: `overlay.ecosystem.event.v1`.
 *
 * One event shape for every app, service and audit run. Events carry outcome
 * metadata only — never prompt text, message content, tokens or secrets. The
 * sanitizer enforces that at construction time so a caller cannot accidentally
 * leak a payload.
 */

export const ECOSYSTEM_EVENT_SCHEMA = "overlay.ecosystem.event.v1" as const;

export type EcosystemEventKind =
  | "app.launch"
  | "llm.route"
  | "llm.call"
  | "audit.run"
  | "audit.finding"
  | "ci.run"
  | "model.load"
  | "model.promote"
  | "ecosystem.hop";

export type EcosystemEventSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface EcosystemFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface EcosystemEvent {
  schema: typeof ECOSYSTEM_EVENT_SCHEMA;
  id: string;
  ts: string;
  app: string;
  kind: EcosystemEventKind;
  task?: string;
  lane?: string;
  privacy?: string;
  ok?: boolean;
  latencyMs?: number;
  fallback?: boolean;
  model?: string;
  score?: number;
  costUsd?: number;
  findingCounts?: EcosystemFindingCounts;
  traceId?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface EcosystemEventInput {
  app: string;
  kind: EcosystemEventKind;
  task?: string;
  lane?: string;
  privacy?: string;
  ok?: boolean;
  latencyMs?: number;
  fallback?: boolean;
  model?: string;
  score?: number;
  costUsd?: number;
  findingCounts?: Partial<EcosystemFindingCounts>;
  traceId?: string;
  meta?: Record<string, unknown>;
  id?: string;
  ts?: string;
}

/** Keys that must never reach an event payload. */
export const FORBIDDEN_EVENT_KEYS = [
  "prompt",
  "prompts",
  "messages",
  "content",
  "text",
  "completion",
  "token",
  "tokens",
  "apiKey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "email",
  "phone",
  "ssn",
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_EVENT_KEYS);

function isForbidden(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN.has(key) || FORBIDDEN.has(k) || k.includes("token") || k.includes("secret") || k.includes("password");
}

function sanitizeMeta(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!input) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isForbidden(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeCounts(input: Partial<EcosystemFindingCounts> | undefined): EcosystemFindingCounts | undefined {
  if (!input) return undefined;
  return {
    critical: Number(input.critical ?? 0),
    high: Number(input.high ?? 0),
    medium: Number(input.medium ?? 0),
    low: Number(input.low ?? 0),
    info: Number(input.info ?? 0),
  };
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createEcosystemEvent(input: EcosystemEventInput): EcosystemEvent {
  if (!input.app || !input.kind) {
    throw new Error("EcosystemEvent requires app and kind");
  }
  const event: EcosystemEvent = {
    schema: ECOSYSTEM_EVENT_SCHEMA,
    id: input.id ?? uuid(),
    ts: input.ts ?? new Date().toISOString(),
    app: input.app,
    kind: input.kind,
  };
  if (input.task !== undefined) event.task = input.task;
  if (input.lane !== undefined) event.lane = input.lane;
  if (input.privacy !== undefined) event.privacy = input.privacy;
  if (input.ok !== undefined) event.ok = input.ok;
  if (input.latencyMs !== undefined) event.latencyMs = input.latencyMs;
  if (input.fallback !== undefined) event.fallback = input.fallback;
  if (input.model !== undefined) event.model = input.model;
  if (input.score !== undefined) event.score = input.score;
  if (input.costUsd !== undefined) event.costUsd = input.costUsd;
  if (input.traceId !== undefined) event.traceId = input.traceId;
  const counts = normalizeCounts(input.findingCounts);
  if (counts) event.findingCounts = counts;
  const meta = sanitizeMeta(input.meta);
  if (meta) event.meta = meta;
  return event;
}

/** Returns true if the object carries any forbidden key anywhere. */
export function hasForbiddenEventField(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isForbidden(key)) return true;
    if (hasForbiddenEventField(val, seen)) return true;
  }
  return false;
}
