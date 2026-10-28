import type { ToolResult, ToolSpec } from './types';

/**
 * Phase 1: four read-only tools. Each one wraps an endpoint that already
 * exists. Nothing here writes, spawns a process, or takes a URL from the model.
 */

const CONTROL_URL = (env: NodeJS.ProcessEnv = process.env) =>
  (env.ECOSYSTEM_CONTROL_URL || env.OPENHUB_CONTROL_URL || 'https://ecosystem-control.tap4500.workers.dev')
    .trim()
    .replace(/\/+$/, '');

const CONTROL_TOKEN = (env: NodeJS.ProcessEnv = process.env) =>
  (env.ECOSYSTEM_CONTROL_TOKEN || env.CONTROL_TOKEN || '').trim();

const TELEMETRY_URL = (env: NodeJS.ProcessEnv = process.env) =>
  (env.OPENHUB_HARNESS_TELEMETRY_URL || 'https://mobile-gateway.tap4500.workers.dev/v1/sieve/telemetry')
    .trim();

/** Shared argument envelope. Constrained decoding is happiest with one shape. */
export const TOOL_ARGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['service', 'window', 'limit', 'job', 'title', 'steps', 'budget_usd'],
  properties: {
    service: {
      type: ['string', 'null'],
      description: 'Service id for fleet.service. Null when not needed.',
    },
    window: {
      type: ['string', 'null'],
      description: 'Telemetry window: "24h" or "7d". Null defaults to 24h.',
    },
    limit: {
      type: ['integer', 'null'],
      description: 'Maximum rows for list tools. Null defaults to 20.',
    },
    job: {
      type: ['string', 'null'],
      description: 'Exact job id for cron.pause/cron.enable/cron.run.',
    },
    title: {
      type: ['string', 'null'],
      description: 'Plan title for plan.create.',
    },
    steps: {
      type: ['string', 'null'],
      description: 'Plan steps, one per line, for plan.create.',
    },
    budget_usd: {
      type: ['number', 'null'],
      description: 'Optional budget in USD for plan.create.',
    },
  },
} as const;

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'fleet.status',
    title: 'Fleet status',
    description:
      'One-screen ecosystem summary: service health counts, enabled/failing jobs, runs in the last 24h, events, and the last run time. Use for "what is down" and "what happened overnight".',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations,
    risk: 'read',
  },
  {
    name: 'fleet.service',
    title: 'One service detail',
    description:
      'Health and recent runs for one service id. Requires args.service. Use after fleet.status names the service.',
    inputSchema: {
      ...TOOL_ARGS_SCHEMA,
      properties: {
        ...TOOL_ARGS_SCHEMA.properties,
        service: { type: 'string', description: 'Exact service id from fleet.status.' },
      },
      required: ['service', 'window', 'limit'],
    },
    annotations,
    risk: 'read',
  },
  {
    name: 'telemetry.summary',
    title: 'Telemetry summary',
    description:
      'Aggregate ecosystem events from Sieve for a window (24h or 7d): totals, by source, by kind, errors. Never contains prompt text or PHI.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations,
    risk: 'read',
  },
  {
    name: 'cron.list',
    title: 'List jobs and crons',
    description:
      'Every scheduled job with its real cron (not the row claim), enabled state, target, last status and failure count. Use before proposing a schedule change.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations,
    risk: 'read',
  },
  {
    name: 'cron.pause',
    title: 'Pause a job',
    description:
      'Disable one existing job by exact id. Reversible with cron.enable. Requires args.job. This is a write and needs operator approval.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: true },
    risk: 'write',
    idempotent: true,
  },
  {
    name: 'cron.enable',
    title: 'Enable a job',
    description:
      'Re-enable one existing job by exact id. Requires args.job. This is a write and needs operator approval.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: true },
    risk: 'write',
    idempotent: true,
  },
  {
    name: 'cron.run',
    title: 'Run a job now',
    description:
      'Dispatch one existing job immediately by exact id. Requires args.job. It takes the same path as the cron, so a run row is recorded. This is a write and needs operator approval.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    risk: 'write',
  },
  {
    name: 'plan.create',
    title: 'Create a plan',
    description:
      'Create a draft plan with a title and one step per line. Optionally set budget_usd. This is a write and needs operator approval. Creating a new cron slot still requires a code deploy; use cron.pause/enable/run for existing jobs.',
    inputSchema: TOOL_ARGS_SCHEMA,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    risk: 'write',
  },
];

/** Read tools run immediately; everything else pauses for the operator. */
export function requiresApproval(name: string): boolean {
  const tool = toolByName(name);
  return Boolean(tool && tool.risk !== 'read');
}

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function now(): string {
  return new Date().toISOString();
}

function errorResult(tool: string, message: string): ToolResult {
  return { ok: false, tool, summary: message, error: message, at: now() };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(9000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
    throw new Error(`HTTP ${response.status}${detail ? `: ${String(detail)}` : ''}`);
  }
  return body;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : null;
    throw new Error(`HTTP ${response.status}${detail ? `: ${String(detail)}` : ''}`);
  }
  return parsed;
}

function controlHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = CONTROL_TOKEN(env);
  if (!token) {
    throw new Error(
      'ECOSYSTEM_CONTROL_TOKEN is not set. Set it in OpenHub Settings or the environment; the control plane refuses anonymous reads.',
    );
  }
  return { authorization: `Bearer ${token}` };
}

function int(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>) : [];
}

export async function executeTool(
  name: string,
  rawArgs: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const at = now();

  if (!toolByName(name)) {
    return errorResult(name, `Unknown tool "${name}". Use one of: ${TOOLS.map((t) => t.name).join(', ')}.`);
  }

  try {
    if (name === 'fleet.status') {
      const body = (await getJson(`${CONTROL_URL(env)}/api/overview`, controlHeaders(env))) as {
        overview?: Record<string, unknown>;
      };
      const overview = body?.overview ?? {};
      const health = (overview.health ?? {}) as Record<string, number>;
      const jobs = (overview.jobs ?? {}) as Record<string, number>;
      const runs = (overview.runs24h ?? {}) as Record<string, number>;
      const summary =
        `${int(health.online)} online, ${int(health.degraded)} degraded, ${int(health.offline)} offline ` +
        `(of ${int(overview.total)} services). Jobs: ${int(jobs.enabled)}/${int(jobs.total)} enabled, ` +
        `${int(jobs.failing)} failing. Runs 24h: ${int(runs.ok)} ok, ${int(runs.error)} error. ` +
        `Events 24h: ${int(overview.events24h)}. Last run: ${overview.lastRunAt ?? 'never'}.`;
      return { ok: true, tool: name, summary, data: body, at };
    }

    if (name === 'fleet.service') {
      const service = typeof args.service === 'string' ? args.service.trim() : '';
      if (!service) return errorResult(name, 'fleet.service requires args.service (an exact service id).');
      const headers = controlHeaders(env);
      const [servicesBody, runsBody] = await Promise.all([
        getJson(`${CONTROL_URL(env)}/api/services`, headers) as Promise<{ services?: unknown }>,
        getJson(
          `${CONTROL_URL(env)}/api/runs?target=${encodeURIComponent(service)}&limit=${int(args.limit, 5)}`,
          headers,
        ) as Promise<{ runs?: unknown }>,
      ]);
      const services = objects(servicesBody.services).filter((s) => s.id === service);
      const runs = objects(runsBody.runs).slice(0, 5).map((r) => ({
        status: r.status,
        started_at: r.started_at,
        summary: r.summary,
      }));
      if (services.length === 0) {
        return errorResult(name, `No service with id "${service}". Call fleet.status and use an id from the list.`);
      }
      const svc = services[0];
      const summary =
        `${service}: health=${String(svc.health ?? 'unknown')}, enabled=${String(svc.enabled ?? '?')}, ` +
        `last status=${String(svc.last_status ?? 'never')}. Recent runs: ${
          runs.length ? runs.map((r) => `${String(r.status)}@${String(r.started_at)}`).join(', ') : 'none'
        }.`;
      return { ok: true, tool: name, summary, data: { service: svc, runs }, at };
    }

    if (name === 'telemetry.summary') {
      const window = args.window === '7d' ? '7d' : '24h';
      const url = `${TELEMETRY_URL(env)}${TELEMETRY_URL(env).includes('?') ? '&' : '?'}window=${window}`;
      const body = (await getJson(url)) as {
        totals?: Record<string, unknown>;
        by_source?: unknown;
        by_kind?: unknown;
      };
      const totals = body?.totals ?? {};
      const sources = objects(body.by_source)
        .slice(0, 6)
        .map((s) => `${String(s.source)}=${int(s.n)}`)
        .join(', ');
      const kinds = objects(body.by_kind)
        .slice(0, 6)
        .map((k) => `${String(k.kind)}=${int(k.n)}`)
        .join(', ');
      const summary =
        `Telemetry ${window}: ${int(totals.events)} events, ${int(totals.errors)} errors. ` +
        `Sources: ${sources || 'none'}. Kinds: ${kinds || 'none'}.`;
      return { ok: true, tool: name, summary, data: body, at };
    }

    if (name === 'cron.pause' || name === 'cron.enable' || name === 'cron.run') {
      const job = typeof args.job === 'string' ? args.job.trim() : '';
      if (!job) return errorResult(name, `${name} requires args.job (an exact job id from cron.list).`);
      const headers = controlHeaders(env);
      if (name === 'cron.run') {
        const body = (await postJson(
          `${CONTROL_URL(env)}/api/jobs/${encodeURIComponent(job)}/run`,
          {},
          headers,
        )) as { ok?: boolean; status?: string; detail?: string; error?: string };
        if (!body?.ok) return errorResult(name, `Run refused: ${body?.error ?? body?.detail ?? 'unknown'}`);
        return {
          ok: true,
          tool: name,
          summary: `Dispatched ${job}: ${body.status ?? 'queued'}${body.detail ? ` (${body.detail})` : ''}.`,
          data: body,
          at,
        };
      }
      const enable = name === 'cron.enable';
      const body = (await postJson(
        `${CONTROL_URL(env)}/api/jobs/${encodeURIComponent(job)}/reconfigure`,
        { enabled: enable },
        headers,
      )) as { ok?: boolean; error?: string };
      if (!body?.ok) return errorResult(name, `Reconfigure refused: ${body?.error ?? 'unknown'}`);
      return {
        ok: true,
        tool: name,
        summary: `${job} is now ${enable ? 'enabled' : 'paused'}.`,
        data: body,
        at,
      };
    }

    if (name === 'plan.create') {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const stepsRaw = typeof args.steps === 'string' ? args.steps : '';
      const steps = stepsRaw
        .split(/\r?\n/)
        .map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!title) return errorResult(name, 'plan.create requires args.title.');
      if (steps.length === 0) return errorResult(name, 'plan.create requires args.steps (one step per line).');
      const body = (await postJson(
        `${CONTROL_URL(env)}/api/plans`,
        {
          title,
          steps,
          budget_usd: typeof args.budget_usd === 'number' ? args.budget_usd : null,
          status: 'draft',
        },
        controlHeaders(env),
      )) as { ok?: boolean; plan?: { id?: number }; error?: string };
      if (!body?.ok || !body.plan?.id) return errorResult(name, `Plan refused: ${body?.error ?? 'unknown'}`);
      return {
        ok: true,
        tool: name,
        summary: `Created plan #${body.plan.id} "${title}" with ${steps.length} step(s), status draft.`,
        data: body,
        at,
      };
    }

    if (name === 'cron.list') {
      const body = (await getJson(`${CONTROL_URL(env)}/api/jobs`, controlHeaders(env))) as { jobs?: unknown };
      const jobs = objects(body.jobs);
      const limit = Math.max(1, Math.min(50, int(args.limit, 20)));
      const rows = jobs.slice(0, limit).map((j) => ({
        id: j.id,
        cron: j.cron,
        enabled: j.enabled,
        target: j.target,
        last_status: j.last_status,
        failing: j.failing,
      }));
      const failing = jobs.filter((j) => j.last_status && !['ok', 'skipped'].includes(String(j.last_status))).length;
      const summary =
        `${jobs.length} jobs, ${jobs.filter((j) => j.enabled).length} enabled, ${failing} failing. ` +
        `First ${rows.length}: ${rows
          .map((r) => `${String(r.id)}[${r.cron ? String(r.cron) : 'no live cron'}]`)
          .join(', ')}.`;
      return { ok: true, tool: name, summary, data: { jobs: rows }, at };
    }

    return errorResult(name, `Tool "${name}" has no executor.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(name, `${name} failed: ${message}`);
  }
}
