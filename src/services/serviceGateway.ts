import {
  MANAGED_SERVICES,
  probeHttp,
  startServiceSafe,
  touchServiceActivity,
} from './serviceManager.js';

/**
 * serviceGateway.ts — the one choke point for "bring a capability up on demand".
 *
 * The lifecycle primitives (probe, `startServiceSafe`, idle reap) live in
 * `serviceManager.ts`, but until now only the operator UI called them. Every
 * consumer — audit scorers, ecosystem registry, research/repair routes — probed
 * a hard-coded URL and gave up when the service was cold. This module lets a
 * consumer ask for a *capability* and get an honest yes/no, starting the backing
 * service first when on-demand activation is enabled.
 *
 * Honesty contract (unchanged from the rest of the fleet):
 *   - a probe that says down is reported as down, never fabricated up;
 *   - a failed start returns `available:false` with the real reason;
 *   - activation is OFF by default (`OPENHUB_ONDEMAND_SERVICES=1` to enable), so
 *     wiring a consumer through here changes nothing until the operator opts in.
 */

/** Capability id → `MANAGED_SERVICES` slug. Aliases map common names (the
 *  scorer name, the fleet id) onto the one managed service that backs them. */
export const CAPABILITY_SERVICES: Record<string, string> = {
  reporank: 'reporank',
  grader: 'grader',
  claw: 'claw-protect',
  'claw-protect': 'claw-protect',
  sca: 'claw-protect',
  deep: 'the-deep',
  'the-deep': 'the-deep',
  codenexus: 'codenexus',
  omniresearch: 'omniresearch',
  omni: 'omniresearch',
  'deterministic-brain': 'deterministic-brain',
  litellm: 'litellm',
  axiom: 'axiom',
  'dev-brain': 'dev-brain',
  redis: 'redis',
};

export interface EnsureResult {
  capability: string;
  slug: string | null;
  available: boolean;
  /** True when the probe found it already up. */
  alreadyUp: boolean;
  /** True when a start was attempted (on-demand enabled and it was down). */
  attempted: boolean;
  /** True when the start succeeded. */
  started: boolean;
  reason?: string;
}

/** On-demand activation is opt-in: unset/0/false means "probe only". */
export function onDemandEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OPENHUB_ONDEMAND_SERVICES ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export interface EnsureDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: probe a slug (defaults to the catalog health probe). */
  probe?: (slug: string) => Promise<boolean>;
  /** Test seam: start a slug (defaults to `startServiceSafe`). */
  start?: (slug: string) => Promise<{ ok: boolean; message: string }>;
  /** Test seam: record activity for the idle reaper. */
  touch?: (slug: string) => void;
}

/** Resolve a capability (or a raw slug) to a managed slug, or null. */
export function resolveCapability(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (CAPABILITY_SERVICES[key]) return CAPABILITY_SERVICES[key];
  if (MANAGED_SERVICES[key]) return key;
  return null;
}

/**
 * Ensure the service backing `name` is up. Probes first; if down and on-demand
 * is enabled, starts it via the lifecycle manager and re-probes. Never throws.
 */
export async function ensureCapability(name: string, deps: EnsureDeps = {}): Promise<EnsureResult> {
  const env = deps.env ?? process.env;
  const slug = resolveCapability(name);
  if (!slug) {
    return { capability: name, slug: null, available: false, alreadyUp: false, attempted: false, started: false, reason: `unknown capability "${name}"` };
  }
  const config = MANAGED_SERVICES[slug];
  const probe = deps.probe ?? ((s: string) => probeHttp(config.port, config.healthPath));
  const touch = deps.touch ?? touchServiceActivity;

  if (await probe(slug)) {
    touch(slug);
    return { capability: name, slug, available: true, alreadyUp: true, attempted: false, started: false };
  }

  if (!onDemandEnabled(env)) {
    return {
      capability: name,
      slug,
      available: false,
      alreadyUp: false,
      attempted: false,
      started: false,
      reason: `service "${slug}" is down and on-demand activation is disabled (set OPENHUB_ONDEMAND_SERVICES=1)`,
    };
  }

  const start = deps.start ?? startServiceSafe;
  const res = await start(slug);
  const up = res.ok && (await probe(slug));
  if (up) touch(slug);
  return {
    capability: name,
    slug,
    available: up,
    alreadyUp: false,
    attempted: true,
    started: res.ok,
    ...(up ? {} : { reason: res.message }),
  };
}