import fs from 'fs';
import path from 'path';
import express from 'express';
import { resolveDraymondDir } from '../services/ecosystemMemory';

/**
 * Fleet KPIs for OpenHub Mission Control / engine telemetry (capability #5).
 *
 * Reads the operator's `.draymond` fleet brain state (per MEMORY.md):
 *   - treasury.json     → revenue pulse ({ revenueCents, lastPulseAt, ... })
 *   - system-goals.json → strategy goals ({ goals: [...] })
 *   - heartbeats.json   → fleet agent heartbeats (array or object-wrapped)
 *   - recaps.json       → session recaps (array or object-wrapped)
 *
 * Degradation rules (binding): missing/corrupt files yield per-field null/[],
 * an unresolvable `.draymond` directory yields `{ configured: false, source:
 * 'degraded' }`. This module never throws and never invents numbers.
 *
 * Directory resolution matches the fleet memory protocol (see
 * resolveDraymondDir): OPENHUB_DRAYMOND_DIR → OPENHUB_ECOSYSTEM_ROOT/
 * Draymond-Orchestrator/.draymond → well-known Uplift root.
 */

export interface TreasurySnapshot {
  revenueCents: number | null;
  revenueUSD: number | null;
  lastPulseAt: string | null;
}

export interface GoalSnapshot {
  id: string;
  domain: string | null;
  title: string | null;
  weight: number | null;
  status: string | null;
}

export interface KpiSnapshot {
  configured: boolean;
  dir: string | null;
  treasury: TreasurySnapshot | null;
  goals: GoalSnapshot[];
  heartbeats: unknown[];
  recaps: unknown[];
  source: 'live' | 'degraded';
  error?: string;
}

const BRAIN_FILES = {
  treasury: 'treasury.json',
  goals: 'system-goals.json',
  heartbeats: 'heartbeats.json',
  recaps: 'recaps.json',
} as const;

function normalizeTreasury(parsed: unknown): TreasurySnapshot | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const revenueCents =
    typeof obj.revenueCents === 'number' && Number.isFinite(obj.revenueCents) ? obj.revenueCents : null;
  const lastPulseAt = typeof obj.lastPulseAt === 'string' ? obj.lastPulseAt : null;
  return {
    revenueCents,
    revenueUSD: revenueCents !== null ? revenueCents / 100 : null,
    lastPulseAt,
  };
}

function normalizeGoals(parsed: unknown): GoalSnapshot[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).goals;
  if (!Array.isArray(raw)) return [];
  const goals: GoalSnapshot[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const goal = entry as Record<string, unknown>;
    goals.push({
      id: typeof goal.id === 'string' ? goal.id : '',
      domain: typeof goal.domain === 'string' ? goal.domain : null,
      title: typeof goal.title === 'string' ? goal.title : null,
      weight: typeof goal.weight === 'number' && Number.isFinite(goal.weight) ? goal.weight : null,
      status: typeof goal.status === 'string' ? goal.status : null,
    });
  }
  return goals;
}

/**
 * Best-effort list normalization: plain arrays pass through; object-wrapped
 * keyed arrays ({ heartbeats: [...] }) unwrap; keyed maps ({ id: {...} })
 * fall back to their object values.
 */
function normalizeList(parsed: unknown, preferredKey: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const wrapped = obj[preferredKey];
    if (Array.isArray(wrapped)) return wrapped;
    const values = Object.values(obj).filter((v) => v !== null && typeof v === 'object');
    if (values.length > 0) return values;
  }
  return [];
}

function readBrainFile<T>(
  dir: string,
  fileName: string,
  errors: string[],
  normalize: (parsed: unknown) => T,
): T {
  try {
    const raw = fs.readFileSync(path.join(dir, fileName), 'utf-8');
    return normalize(JSON.parse(raw) as unknown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${fileName}: ${message}`);
    return normalize(null);
  }
}

/**
 * Load the full fleet KPI snapshot from the `.draymond` brain. Pure and
 * testable: pass an env override (e.g. OPENHUB_DRAYMOND_DIR) to point at a
 * specific fleet brain directory.
 */
export function loadKpis(env: NodeJS.ProcessEnv = process.env): KpiSnapshot {
  const dir = resolveDraymondDir(env);
  if (!dir) {
    return {
      configured: false,
      dir: null,
      treasury: null,
      goals: [],
      heartbeats: [],
      recaps: [],
      source: 'degraded',
      error: 'no .draymond directory found (set OPENHUB_DRAYMOND_DIR or OPENHUB_ECOSYSTEM_ROOT)',
    };
  }

  const errors: string[] = [];
  const treasury = readBrainFile(dir, BRAIN_FILES.treasury, errors, normalizeTreasury);
  const goals = readBrainFile(dir, BRAIN_FILES.goals, errors, normalizeGoals);
  const heartbeats = readBrainFile(dir, BRAIN_FILES.heartbeats, errors, (parsed) =>
    normalizeList(parsed, 'heartbeats'),
  );
  const recaps = readBrainFile(dir, BRAIN_FILES.recaps, errors, (parsed) =>
    normalizeList(parsed, 'recaps'),
  );

  return {
    configured: true,
    dir,
    treasury,
    goals,
    heartbeats,
    recaps,
    source: 'live',
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

/**
 * Auth-gated fleet KPI router. Mount at `/api` (integrator: server.ts), which
 * yields `GET /api/ecosystem/kpis`. Every route runs through
 * `deps.authMiddleware` first (`router.use`).
 */
export function createFleetKpisRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/ecosystem/kpis', (_req, res) => {
    try {
      res.json(loadKpis());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message || 'Failed to load fleet KPIs' });
    }
  });

  return router;
}