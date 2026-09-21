import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllServicesStatus } from './serviceManager.js';
import { buildInsights, type InsightsReport } from './insights.js';
import { recordEvent, summarizeEvents, type TelemetrySummary } from './telemetry.js';
import { listRuns, resumeSupervision } from './supervisor.js';

/**
 * Autonomy engine — the "just works" heartbeat.
 * ============================================
 * Once OpenHub boots, this single always-on loop keeps the node self-aware
 * without any operator clicks: it probes managed services, resumes supervised
 * runs left mid-flight by a restart, recomputes trends/insights from telemetry
 * and Recourse's self-learning state, and publishes an immutable snapshot to
 * memory + `data/autonomy/state.json` that the UI streams.
 *
 * Boundaries (deliberate):
 *   - Probe + learn + resume only. It NEVER spawns or stops fleet services
 *     (autonomous spawning is off by contract — see CONTROL_PLANE_PLAN.md);
 *     starting a worker stays an explicit operator action.
 *   - Every source is best-effort with a timeout; a failure is recorded in
 *     `degraded`, never fabricated into a success.
 *   - Disable with OPENHUB_AUTONOMY=0.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AutonomyService {
  slug: string;
  name: string;
  port: number;
  up: boolean;
  category: string;
}

export interface AutonomySnapshot {
  generatedAt: string;
  tick: number;
  running: boolean;
  intervalMs: number;
  health: {
    servicesUp: number;
    servicesTotal: number;
    recourseOnline: boolean;
    highSeverityEvents: number;
    insightCount: number;
    passRate: number | null;
  };
  services: AutonomyService[];
  telemetry: TelemetrySummary | null;
  insights: InsightsReport | null;
  resumedRuns: number;
  degraded: string[];
}

export interface AutonomyDeps {
  gatherServices: () => Promise<AutonomyService[]>;
  gatherInsights: () => Promise<InsightsReport>;
  summarize: () => TelemetrySummary;
  resumeStuck: () => Promise<number>;
  emit: (event: Parameters<typeof recordEvent>[0]) => unknown;
  persist: (snapshot: AutonomySnapshot) => void;
  now: () => Date;
}

function autonomyDir(): string {
  return process.env.OPENHUB_AUTONOMY_DIR
    ? path.resolve(process.env.OPENHUB_AUTONOMY_DIR)
    : path.resolve(__dirname, '..', '..', 'data', 'autonomy');
}

function persistSnapshot(snapshot: AutonomySnapshot): void {
  try {
    const dir = autonomyDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* persistence is best-effort */
  }
}

/** Resume supervised runs left `looping` with a loop id (e.g. after a restart). */
async function resumeStuckRuns(): Promise<number> {
  let resumed = 0;
  try {
    for (const run of listRuns(50)) {
      if (run.status === 'looping' && run.loopId) {
        try {
          resumeSupervision(run.id);
          resumed += 1;
        } catch {
          /* a single run failing must not stop the sweep */
        }
      }
    }
  } catch {
    /* supervision store unavailable */
  }
  return resumed;
}

function defaultDeps(): AutonomyDeps {
  return {
    gatherServices: async () =>
      (await getAllServicesStatus()).map((s) => ({
        slug: s.slug,
        name: s.name,
        port: s.port,
        up: s.up,
        category: s.category,
      })),
    gatherInsights: () => buildInsights(),
    summarize: () => summarizeEvents(),
    resumeStuck: resumeStuckRuns,
    emit: (event) => recordEvent(event),
    persist: persistSnapshot,
    now: () => new Date(),
  };
}

export interface AutonomyLoop {
  runTick: () => Promise<AutonomySnapshot>;
  start: (intervalMs?: number) => void;
  stop: () => void;
  getState: () => AutonomySnapshot | null;
  subscribe: (listener: (snapshot: AutonomySnapshot) => void) => () => void;
  isRunning: () => boolean;
}

export function createAutonomyLoop(overrides: Partial<AutonomyDeps> = {}): AutonomyLoop {
  const deps: AutonomyDeps = { ...defaultDeps(), ...overrides };
  let snapshot: AutonomySnapshot | null = null;
  let tick = 0;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<AutonomySnapshot> | null = null;
  let intervalMs = Number(process.env.OPENHUB_AUTONOMY_INTERVAL_MS) || 30_000;
  const listeners = new Set<(snapshot: AutonomySnapshot) => void>();

  const publish = (next: AutonomySnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* a listener error must not break the loop */
      }
    }
  };

  // Single-flight: a tick that overruns the interval must not overlap itself.
  function runTick(): Promise<AutonomySnapshot> {
    if (inFlight) return inFlight;
    inFlight = doTick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function doTick(): Promise<AutonomySnapshot> {
    tick += 1;
    const degraded: string[] = [];

    let services: AutonomyService[] = [];
    try {
      services = await deps.gatherServices();
    } catch {
      degraded.push('services');
    }

    let resumedRuns = 0;
    try {
      resumedRuns = await deps.resumeStuck();
    } catch {
      degraded.push('supervisor');
    }

    let insights: InsightsReport | null = null;
    try {
      insights = await deps.gatherInsights();
    } catch {
      degraded.push('insights');
    }

    let telemetry: TelemetrySummary | null = null;
    try {
      telemetry = deps.summarize();
    } catch {
      degraded.push('telemetry');
    }

    const recourseOnline = Boolean(insights?.sources.recourse.available);
    if (!recourseOnline) degraded.push('recourse');

    const next: AutonomySnapshot = {
      generatedAt: deps.now().toISOString(),
      tick,
      running,
      intervalMs,
      health: {
        servicesUp: services.filter((s) => s.up).length,
        servicesTotal: services.length,
        recourseOnline,
        highSeverityEvents: (telemetry?.bySeverity.high ?? 0) + (telemetry?.bySeverity.critical ?? 0),
        insightCount: insights?.insights.length ?? 0,
        passRate: telemetry?.passRate ?? null,
      },
      services,
      telemetry,
      insights,
      resumedRuns,
      degraded: [...new Set(degraded)],
    };

    try {
      deps.persist(next);
    } catch {
      /* persistence best-effort */
    }
    try {
      deps.emit({
        system: 'autonomy',
        kind: 'tick',
        severity: degraded.length && degraded.length >= 3 ? 'medium' : 'info',
        outcome: 'accepted',
        data: {
          servicesUp: next.health.servicesUp,
          servicesTotal: next.health.servicesTotal,
          recourseOnline,
          insightCount: next.health.insightCount,
          resumedRuns,
          degraded: next.degraded,
        },
      });
    } catch {
      /* telemetry best-effort */
    }

    publish(next);
    return next;
  }

  function start(overrideIntervalMs?: number): void {
    if (timer) return; // idempotent
    if (overrideIntervalMs && overrideIntervalMs > 0) intervalMs = overrideIntervalMs;
    running = true;
    void runTick().catch(() => {
      /* a failed first tick must not crash boot */
    });
    timer = setInterval(() => {
      void runTick().catch(() => {
        /* keep the heartbeat alive */
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
  }

  return {
    runTick,
    start,
    stop,
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning: () => running,
  };
}

/** Process-wide engine, auto-started from server.ts. */
export const autonomyLoop = createAutonomyLoop();

/** Auto-start unless explicitly disabled. Safe to call more than once. */
export function startAutonomy(): void {
  if (process.env.OPENHUB_AUTONOMY === '0') return;
  autonomyLoop.start();
}
