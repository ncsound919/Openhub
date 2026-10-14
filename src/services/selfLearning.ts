import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * OpenHub's own learner.
 * =====================
 * Every supervised run, repair dispatch and insight action is recorded as an
 * *episode*. From those episodes OpenHub derives deterministic lessons
 * (which skills correlate with accepted outcomes), a calibrated pass-rate
 * threshold, and ranked skill advice — so it improves its own dispatch
 * decisions instead of relying on static heuristics. Recourse enriches this
 * (tools, synergy, forge); the learned weights live here.
 *
 * File-based and dependency-free (mirrors telemetry): append-only JSONL that
 * rotates at a size cap, with a compact `state.json` for inspection. A corrupt
 * or missing dir degrades to empty state, never a fabricated lesson.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = Number(process.env.OPENHUB_SELFLEARNING_MAX_BYTES) || 5 * 1024 * 1024;

export type EpisodeOutcome = 'accepted' | 'rejected' | 'pending' | 'error';

export interface Episode {
  id: string;
  at: string;
  /** `supervision` | `repair` | `insight-action` | `tick` | ... */
  kind: string;
  goal?: string;
  targetDir?: string;
  action?: string;
  skills?: string[];
  outcome: EpisodeOutcome;
  signals?: Record<string, unknown>;
  systems?: string[];
}

export interface SkillStat {
  name: string;
  attempts: number;
  accepted: number;
  rejected: number;
  /** Laplace-smoothed success rate, 0..1. */
  weight: number;
}

export interface Lesson {
  id: string;
  severity: 'info' | 'medium' | 'high';
  text: string;
  skill?: string;
  evidence?: Record<string, unknown>;
}

export interface Calibration {
  passRate: number | null;
  sampleSize: number;
  /** Self-tuned bar the insights engine uses to flag a weak pass rate. */
  passRateThreshold: number;
  updatedAt: string;
}

export interface SelfLearningState {
  updatedAt: string;
  episodeCount: number;
  skills: SkillStat[];
  lessons: Lesson[];
  calibration: Calibration;
}

export interface EpisodeInput {
  kind: string;
  outcome: EpisodeOutcome;
  goal?: string;
  targetDir?: string;
  action?: string;
  skills?: string[];
  signals?: Record<string, unknown>;
  systems?: string[];
}

function learningDir(): string {
  return process.env.OPENHUB_SELFLEARNING_DIR
    ? path.resolve(process.env.OPENHUB_SELFLEARNING_DIR)
    : path.resolve(__dirname, '..', '..', 'data', 'self-learning');
}

function episodesFile(): string {
  return path.join(learningDir(), 'episodes.jsonl');
}

function stateFile(): string {
  return path.join(learningDir(), 'state.json');
}

function rotateIfNeeded(): void {
  try {
    const file = episodesFile();
    const stat = fs.statSync(file);
    if (stat.size < MAX_FILE_BYTES) return;
    const rotated = path.join(learningDir(), 'episodes.1.jsonl');
    try {
      fs.rmSync(rotated, { force: true });
    } catch {
      /* best-effort */
    }
    fs.renameSync(file, rotated);
  } catch {
    /* nothing to rotate */
  }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'you', 'are', 'our', 'all', 'any', 'app', 'use', 'add', 'get', 'new', 'run']);

function tokens(text: string): Set<string> {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function readEpisodes(): Episode[] {
  const out: Episode[] = [];
  for (const file of [path.join(learningDir(), 'episodes.1.jsonl'), episodesFile()]) {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Episode;
        if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string' && typeof parsed.outcome === 'string') {
          out.push(parsed);
        }
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return out;
}

/** Throttle the derived-state snapshot so appends stay O(1), not O(episodes). */
let lastStateWrite = 0;
const STATE_WRITE_INTERVAL_MS = 30_000;

/** Append an episode. Never throws. */
export function recordEpisode(input: EpisodeInput): { wrote: boolean; id?: string; error?: string } {
  if (!input || typeof input.kind !== 'string' || !input.kind || typeof input.outcome !== 'string' || !input.outcome) {
    return { wrote: false, error: 'episode requires kind and outcome' };
  }
  const episode: Episode = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind: input.kind,
    outcome: input.outcome,
    ...(input.goal ? { goal: String(input.goal).slice(0, 500) } : {}),
    ...(input.targetDir ? { targetDir: String(input.targetDir) } : {}),
    ...(input.action ? { action: String(input.action) } : {}),
    ...(Array.isArray(input.skills) && input.skills.length ? { skills: input.skills.map(String).slice(0, 50) } : {}),
    ...(input.signals && typeof input.signals === 'object' ? { signals: input.signals } : {}),
    ...(Array.isArray(input.systems) && input.systems.length ? { systems: input.systems.map(String) } : {}),
  };
  try {
    fs.mkdirSync(learningDir(), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(episodesFile(), `${JSON.stringify(episode)}\n`, 'utf8');
    // Refresh the inspectable snapshot at most every 30s (appends must stay O(1)).
    if (Date.now() - lastStateWrite >= STATE_WRITE_INTERVAL_MS) {
      lastStateWrite = Date.now();
      try {
        fs.writeFileSync(stateFile(), `${JSON.stringify(computeState(), null, 2)}\n`, 'utf8');
      } catch {
        /* state snapshot is best-effort */
      }
    }
    return { wrote: true, id: episode.id };
  } catch (err) {
    return { wrote: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function listEpisodes(query: { limit?: number; kind?: string; sinceMs?: number } = {}): Episode[] {
  let episodes = readEpisodes();
  if (query.kind) episodes = episodes.filter((e) => e.kind === query.kind);
  if (query.sinceMs && query.sinceMs > 0) {
    const cutoff = Date.now() - query.sinceMs;
    episodes = episodes.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  episodes.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return episodes.slice(0, typeof query.limit === 'number' && query.limit >= 0 ? query.limit : 500);
}

/** Laplace-smoothed effectiveness per skill. */
export function skillStats(): SkillStat[] {
  const stats = new Map<string, { attempts: number; accepted: number; rejected: number }>();
  for (const episode of readEpisodes()) {
    for (const skill of episode.skills ?? []) {
      if (!skill) continue;
      const entry = stats.get(skill) ?? { attempts: 0, accepted: 0, rejected: 0 };
      entry.attempts += 1;
      if (episode.outcome === 'accepted') entry.accepted += 1;
      else if (episode.outcome === 'rejected') entry.rejected += 1;
      stats.set(skill, entry);
    }
  }
  return [...stats.entries()]
    .map(([name, s]) => ({
      name,
      attempts: s.attempts,
      accepted: s.accepted,
      rejected: s.rejected,
      weight: (s.accepted + 1) / (s.attempts + 2),
    }))
    .sort((a, b) => b.weight - a.weight || b.attempts - a.attempts || a.name.localeCompare(b.name));
}

/** Deterministic lessons derived from skill outcomes. */
export function lessons(limit = 10): Lesson[] {
  const out: Lesson[] = [];
  for (const stat of skillStats()) {
    if (stat.attempts < 2) continue;
    if (stat.weight >= 0.7) {
      out.push({
        id: `skill-strong:${stat.name}`,
        severity: 'info',
        text: `"${stat.name}" is associated with accepted outcomes (${stat.accepted}/${stat.attempts}); keep using it for similar goals.`,
        skill: stat.name,
        evidence: { accepted: stat.accepted, attempts: stat.attempts, weight: stat.weight },
      });
    } else if (stat.weight <= 0.3) {
      out.push({
        id: `skill-weak:${stat.name}`,
        severity: 'medium',
        text: `"${stat.name}" correlates with rejected outcomes (${stat.rejected}/${stat.attempts}); prefer alternatives or add verification.`,
        skill: stat.name,
        evidence: { rejected: stat.rejected, attempts: stat.attempts, weight: stat.weight },
      });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === 'medium' ? -1 : 1)).slice(0, limit);
}

/**
 * Self-tuned pass-rate bar. A healthy history raises the bar; a rough patch
 * lowers it so alerts stay meaningful instead of alarm-fatiguing.
 */
export function calibration(opts: { sinceMs?: number } = {}): Calibration {
  const sinceMs = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : 30 * 24 * 60 * 60 * 1000;
  const episodes = listEpisodes({ sinceMs });
  const accepted = episodes.filter((e) => e.outcome === 'accepted').length;
  const rejected = episodes.filter((e) => e.outcome === 'rejected').length;
  const sampleSize = accepted + rejected;
  const passRate = sampleSize > 0 ? accepted / sampleSize : null;
  let passRateThreshold = 0.5;
  if (sampleSize >= 5 && passRate !== null) {
    if (passRate >= 0.8) passRateThreshold = 0.7;
    else if (passRate <= 0.3) passRateThreshold = 0.4;
  }
  return { passRate, sampleSize, passRateThreshold, updatedAt: new Date().toISOString() };
}

/** Rank learned skills for a goal, with a plain-language reason. */
export function advise(goal: string, limit = 5): { skills: { name: string; kind: string; reason: string }[]; lessons: Lesson[] } {
  const goalTokens = tokens(goal);
  const stats = skillStats();
  const scored = stats.map((stat) => {
    const nameTokens = tokens(stat.name);
    let overlap = 0;
    for (const t of goalTokens) {
      for (const n of nameTokens) {
        if (n === t || n.startsWith(t) || t.startsWith(n)) overlap += 1;
      }
    }
    // Learn from outcomes first, relevance as a tiebreak.
    const score = stat.weight * 2 + Math.min(overlap, 2) * 0.5;
    return { stat, overlap, score };
  });
  const skills = scored
    .sort((a, b) => b.score - a.score || b.stat.attempts - a.stat.attempts || a.stat.name.localeCompare(b.stat.name))
    .slice(0, limit)
    .map(({ stat, overlap }) => ({
      name: stat.name,
      kind: 'learned',
      reason: overlap > 0
        ? `learned: ${stat.accepted}/${stat.attempts} accepted, matches goal`
        : `learned: ${stat.accepted}/${stat.attempts} accepted`,
    }));
  return { skills, lessons: lessons(limit) };
}

export function computeState(): SelfLearningState {
  return {
    updatedAt: new Date().toISOString(),
    episodeCount: readEpisodes().length,
    skills: skillStats().slice(0, 20),
    lessons: lessons(10),
    calibration: calibration(),
  };
}

export { MAX_FILE_BYTES };
