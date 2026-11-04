/**
 * @overlay365/dsh-fleet — read-only Overlay365 fleet observability as dsh tools.
 *
 * A direct port of the read side of OpenHub's own harness (`openhub/src/harness/tools.ts`):
 * thin HTTPS wrappers, no spawning, no secrets in code. Control-plane tools only
 * register when `ECOSYSTEM_CONTROL_TOKEN` is present (dsh conditional tools:
 * `ctx.tools.register(def, { when })` removes the tool from declarations,
 * dispatch and PTC bindings while the condition is false — the model never sees
 * a tool whose backend it cannot reach).
 *
 * Runtime env (inherited from the dsh process environment):
 *   ECOSYSTEM_CONTROL_URL    control plane base (default https://ecosystem-control.tap4500.workers.dev)
 *   ECOSYSTEM_CONTROL_TOKEN  bearer for the control plane (required for fleet.*)
 *   OPENHUB_HARNESS_TELEMETRY_URL  Sieve telemetry endpoint (default mobile-gateway …/v1/sieve/telemetry)
 *   KOKORO_HEALTH_URL        explicit Kokoro health URL override
 *   KOKORO_URL               Kokoro base (default http://127.0.0.1:8770)
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'overlay-fleet';
export const inject = ['tools'];

const CONTROL_URL = () =>
  (
    process.env.ECOSYSTEM_CONTROL_URL ||
    process.env.OPENHUB_CONTROL_URL ||
    'https://ecosystem-control.tap4500.workers.dev'
  )
    .trim()
    .replace(/\/+$/, '');

const hasControlToken = () =>
  (process.env.ECOSYSTEM_CONTROL_TOKEN || process.env.CONTROL_TOKEN || '').trim().length > 0;

const controlHeaders = () => ({
  authorization: `Bearer ${(process.env.ECOSYSTEM_CONTROL_TOKEN || process.env.CONTROL_TOKEN || '').trim()}`,
});

const TELEMETRY_URL = () =>
  (
    process.env.OPENHUB_HARNESS_TELEMETRY_URL ||
    'https://mobile-gateway.tap4500.workers.dev/v1/sieve/telemetry'
  ).trim();

const KOKORO_HEALTH_URL = () => {
  const explicit = (process.env.KOKORO_HEALTH_URL || '').trim();
  if (explicit) return explicit;
  const raw = (process.env.KOKORO_URL || (process.env.KOKORO_TTS_URL || '').replace(/\/tts\/?$/, '') || 'http://127.0.0.1:8770').trim();
  return `${raw.replace(/\/+$/, '')}/health`;
};

async function getJson(url, headers = {}, timeoutMs = 9000) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? body.error : null;
    throw new Error(`HTTP ${response.status}${detail ? `: ${String(detail)}` : ''}`);
  }
  return body;
}

const int = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const objects = (value) => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []);

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Permissive optional envelope (mirrors OpenHub's TOOL_ARGS_SCHEMA): dsh
 * validates model args strictly, so every tool accepts the shared optional
 * fields and ignores what it does not need — a stray arg never fails closed.
 */
// NOTE: optional params must OMIT `required` entirely — dsh rejects
// `required: false` as UNSUPPORTED_SCHEMA at defineTool time.
const envelopeParams = {
  service: { type: 'string', description: 'Service id (only fleet.service uses it).' },
  window: { type: 'string', description: 'Telemetry window "24h" or "7d" (only telemetry.summary uses it).' },
  limit: { type: 'integer', description: 'Maximum rows (reserved for list tools).' },
};

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'fleet.status',
      title: 'Fleet status',
      description:
        'One-screen ecosystem summary: service health counts, enabled/failing jobs, runs in the last 24h, events, and the last run time. Use for "what is down" and "what happened overnight".',
      parameters: { ...envelopeParams },
      output: textOutput,
      async execute() {
        const body = await getJson(`${CONTROL_URL()}/api/overview`, controlHeaders());
        const overview = body?.overview ?? {};
        const health = overview.health ?? {};
        const jobs = overview.jobs ?? {};
        const runs = overview.runs24h ?? {};
        return (
          `${int(health.online)} online, ${int(health.degraded)} degraded, ${int(health.offline)} offline ` +
          `(of ${int(overview.total)} services). Jobs: ${int(jobs.enabled)}/${int(jobs.total)} enabled, ` +
          `${int(jobs.failing)} failing. Runs 24h: ${int(runs.ok)} ok, ${int(runs.error)} error. ` +
          `Events 24h: ${int(overview.events24h)}. Last run: ${overview.lastRunAt ?? 'never'}.`
        );
      },
    }),
    { when: hasControlToken },
  );

  ctx.tools.register(
    defineTool({
      name: 'fleet.service',
      title: 'One service detail',
      description:
        'Health and recent runs for one service id. Requires args.service. Use after fleet.status names the service.',
      parameters: {
        service: { type: 'string', required: true, description: 'Exact service id from fleet.status.' },
      },
      output: textOutput,
      async execute(args) {
        const service = String(args.service || '').trim();
        if (!service) throw new Error('fleet.service requires args.service.');
        const headers = controlHeaders();
        const [servicesBody, runsBody] = await Promise.all([
          getJson(`${CONTROL_URL()}/api/services`, headers),
          getJson(`${CONTROL_URL()}/api/runs?target=${encodeURIComponent(service)}&limit=5`, headers),
        ]);
        const services = objects(servicesBody.services).filter((s) => s.id === service);
        if (services.length === 0) throw new Error(`No service with id "${service}".`);
        const runs = objects(runsBody.runs)
          .slice(0, 5)
          .map((r) => `${String(r.status)}@${String(r.started_at)}`);
        const svc = services[0];
        return (
          `${service}: health=${String(svc.health ?? 'unknown')}, enabled=${String(svc.enabled ?? '?')}, ` +
          `last status=${String(svc.last_status ?? 'never')}. Recent runs: ${runs.length ? runs.join(', ') : 'none'}.`
        );
      },
    }),
    { when: hasControlToken },
  );

  ctx.tools.register(
    defineTool({
      name: 'telemetry.summary',
      title: 'Telemetry summary',
      description:
        'Aggregate ecosystem events from Sieve for a window (24h or 7d): totals, by source, by kind, errors. Never contains prompt text or PHI.',
      parameters: {
        ...envelopeParams,
        window: { type: 'string', description: '"24h" (default) or "7d".' },
      },
      output: textOutput,
      async execute(args) {
        const window = args.window === '7d' ? '7d' : '24h';
        const base = TELEMETRY_URL();
        const url = `${base}${base.includes('?') ? '&' : '?'}window=${window}`;
        const body = await getJson(url);
        const totals = body?.totals ?? {};
        const sources = objects(body.by_source)
          .slice(0, 6)
          .map((s) => `${String(s.source)}=${int(s.n)}`)
          .join(', ');
        const kinds = objects(body.by_kind)
          .slice(0, 6)
          .map((k) => `${String(k.kind)}=${int(k.n)}`)
          .join(', ');
        return (
          `Telemetry ${window}: ${int(totals.events)} events, ${int(totals.errors)} errors. ` +
          `Sources: ${sources || 'none'}. Kinds: ${kinds || 'none'}.`
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'voice.status',
      title: 'Shared voice status',
      description:
        'Probe the shared Kokoro TTS service (loopback :8770): readiness, speaker count, default voice, requests served, last synthesis time and dropped words. Read-only — it reports, it does not speak.',
      parameters: { ...envelopeParams },
      output: textOutput,
      async execute() {
        const url = KOKORO_HEALTH_URL();
        let health;
        try {
          health = await getJson(url);
        } catch (error) {
          throw new Error(`Voice unavailable at ${url}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (health?.ready !== true) {
          throw new Error(
            `Voice service at ${url} is not ready: ${health?.reason || health?.state || 'no reason given'}.`,
          );
        }
        const named = Array.isArray(health.voices) ? health.voices.length : 0;
        const oov = Array.isArray(health.oov) ? health.oov.filter((w) => typeof w === 'string') : [];
        return (
          `Voice ready at ${url}: ${int(health.speakers)} speakers (${named} named English), ` +
          `default ${String(health.defaultVoice ?? 'unknown')}, ${int(health.requests)} requests served. ` +
          (int(health.lastMs) > 0
            ? `Last synthesis ${int(health.lastMs)} ms for ${int(health.audioMs)} ms of audio. `
            : 'No synthesis yet. ') +
          (oov.length ? `Unpronounceable words: ${oov.slice(0, 8).join(', ')}.` : 'No words dropped.')
        );
      },
    }),
  );
}
