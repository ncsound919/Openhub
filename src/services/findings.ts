/**
 * Normalized Finding model (P0 foundations).
 *
 * Every analyzer — from a static scanner to an LLM review — emits the same
 * shape so findings can be deduplicated across tools, corroborated, weighted by
 * confidence, and rendered by one explorer. The fingerprint is deliberately
 * independent of the producing tool: the same secret or CVE seen by claw, sca,
 * ocr and deep collapses into one finding with four corroborating sources.
 */
import { createHash } from 'node:crypto';
import type { Dimension } from './dimensions.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Where a finding's judgement comes from (mirrors the dimension determinism). */
export type Determinism = 'static' | 'heuristic' | 'llm';

export interface FindingLocation {
  file: string;
  line?: number;
  endLine?: number;
}

export interface Finding {
  /** Per-tool fingerprint: hash(source|category|file|line|evidence). */
  id: string;
  /** Analyzer that produced the finding (deep, ocr, sca, claw, local_qa, …). */
  source: string;
  dimension: Dimension;
  /** Machine category: cwe-79 | npe | cve | secret | coverage-gap | … */
  category: string;
  severity: Severity;
  /** 0..1 — how sure the analyzer is. Corroboration raises this. */
  confidence: number;
  determinism: Determinism;
  location?: FindingLocation;
  /** Explicit location truth: false when the analyzer could not pin a file/line.
   *  Makes "unmeasured/unpinned" distinguishable from a silent omission. */
  locatable?: boolean;
  /** Snippet / scanner output supporting the finding. */
  evidence?: string;
  remediation?: string;
  cwe?: string;
  cve?: string;
  /** Other sources that independently reported the same fingerprinted finding. */
  corroboratedBy?: string[];
}

export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function severityFromString(value: unknown): Severity {
  const s = String(value ?? '').trim().toLowerCase();
  if ((SEVERITIES as string[]).includes(s)) return s as Severity;
  if (s === 'error' || s === 'blocker') return 'high';
  if (s === 'warning' || s === 'warn' || s === 'moderate') return 'medium';
  if (s === 'note' || s === 'hint') return 'info';
  return 'info';
}

export function severityWeight(severity: Severity): number {
  return SEVERITY_WEIGHTS[severity] ?? 0;
}

/** Severity ordering for sorting (critical first). */
export function severityRank(severity: Severity): number {
  const i = SEVERITIES.indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** Stable per-tool id so a finding can be referenced/cached across runs. */
export function findingId(f: Pick<Finding, 'source' | 'category' | 'location' | 'evidence'>): string {
  const file = f.location?.file ?? '';
  const line = f.location?.line ?? '';
  return sha1([f.source, f.category, file, line, normalizeText(f.evidence ?? '')].join('|'));
}

/**
 * Cross-tool dedup key. Two findings collapse when they describe the same
 * issue at the same place regardless of which analyzer found them:
 *  - CVEs dedup by CVE id,
 *  - otherwise by dimension|category|file|line (or evidence when no line).
 */
export function dedupKey(f: Finding): string {
  if (f.cve) return `cve:${f.cve.toLowerCase()}`;
  const file = f.location?.file ?? '';
  const line = f.location?.line ?? '';
  if (file && line !== '') {
    return `${f.dimension}|${f.category}|${file}|${line}`.toLowerCase();
  }
  if (file) {
    // Same file + category but no line: only collapse when the evidence matches,
    // otherwise two distinct issues in one file would be merged.
    return `${f.dimension}|${f.category}|${file}|${sha1(normalizeText(f.evidence ?? ''))}`.toLowerCase();
  }
  return `${f.dimension}|${f.category}|${sha1(normalizeText(f.evidence ?? ''))}`.toLowerCase();
}

export interface DedupStats {
  input: number;
  unique: number;
  duplicates: number;
  /** Grouped findings backed by 2+ independent sources. */
  corroborated: number;
  /** input/unique — how much duplication the normalization removed. */
  dedupRatio: number;
  bySource: Record<string, number>;
}

export interface DedupResult {
  findings: Finding[];
  stats: DedupStats;
}

function preferPrimary(a: Finding, b: Finding): Finding {
  const sevDiff = severityRank(a.severity) - severityRank(b.severity);
  if (sevDiff !== 0) return sevDiff < 0 ? a : b;
  const confDiff = b.confidence - a.confidence;
  if (Math.abs(confDiff) > 1e-9) return confDiff > 0 ? b : a;
  // Prefer deterministic evidence, then lexical source for stability.
  const order = { static: 0, heuristic: 1, llm: 2 } as const;
  const detDiff = order[a.determinism] - order[b.determinism];
  if (detDiff !== 0) return detDiff < 0 ? a : b;
  return a.source <= b.source ? a : b;
}

/**
 * Collapse findings that share a `dedupKey`, merging corroborating sources and
 * raising confidence. Output order is stable (first-seen key order).
 */
export function dedupeFindings(findings: readonly Finding[]): DedupResult {
  const groups = new Map<string, Finding[]>();
  const order: string[] = [];
  for (const f of findings) {
    const key = dedupKey(f);
    const group = groups.get(key);
    if (group) group.push(f);
    else {
      groups.set(key, [f]);
      order.push(key);
    }
  }

  const out: Finding[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    let primary = group[0];
    for (const f of group.slice(1)) primary = preferPrimary(primary, f);
    const sources = Array.from(new Set(group.map((g) => g.source))).sort();
    const corroboratedBy = sources.filter((s) => s !== primary.source);
    const merged: Finding = { ...primary };
    if (corroboratedBy.length) {
      merged.corroboratedBy = corroboratedBy;
      // Each independent corroboration adds 0.1 confidence, capped at 1.
      merged.confidence = Math.min(1, Math.max(0, primary.confidence) + 0.1 * corroboratedBy.length);
    }
    out.push(merged);
  }

  const bySource: Record<string, number> = {};
  for (const f of findings) bySource[f.source] = (bySource[f.source] ?? 0) + 1;

  const unique = out.length;
  const input = findings.length;
  return {
    findings: out,
    stats: {
      input,
      unique,
      duplicates: input - unique,
      corroborated: out.filter((f) => (f.corroboratedBy?.length ?? 0) > 0).length,
      dedupRatio: input === 0 ? 0 : Math.round(((input - unique) / input) * 1000) / 1000,
      bySource,
    },
  };
}

export interface FindingScoreOptions {
  /** Hard cap on the total deduction (so one noisy tool cannot zero the grade). */
  cap?: number;
  /** Score when there are no findings at all. */
  clean?: number;
  /** Optional floor for the score. */
  floor?: number;
}

/**
 * Deterministic penalty score from a finding set: `clean - Σ weight×confidence`,
 * bounded by `cap` and `floor`. Confidence-weighted so low-confidence noise
 * deducts less than a confirmed critical.
 */
export function scoreFromFindings(
  findings: readonly Finding[],
  options: FindingScoreOptions = {},
): number {
  const { cap = 75, clean = 100, floor = 0 } = options;
  const penalty = findings.reduce(
    (sum, f) => sum + severityWeight(f.severity) * clamp01(f.confidence),
    0,
  );
  return Math.max(floor, Math.round(clean - Math.min(cap, penalty)));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface FindingInput {
  source: string;
  dimension: Dimension;
  category: string;
  severity: string;
  confidence?: number;
  determinism?: Determinism;
  location?: FindingLocation;
  evidence?: string;
  remediation?: string;
  cwe?: string;
  cve?: string;
}

/** Build a normalized, fingerprinted finding from an analyzer's raw output. */
export function createFinding(input: FindingInput): Finding {
  const location = input.location;
  const base = {
    source: input.source,
    dimension: input.dimension,
    category: input.category,
    severity: severityFromString(input.severity),
    confidence: clamp01(input.confidence ?? 0.7),
    determinism: input.determinism ?? 'static',
    locatable: !!location,
    ...(location ? { location } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.remediation ? { remediation: input.remediation } : {}),
    ...(input.cwe ? { cwe: input.cwe } : {}),
    ...(input.cve ? { cve: input.cve } : {}),
  };
  return { ...base, id: findingId(base) };
}

/** Group findings by an arbitrary key without losing order. */
export function groupFindings<K extends string>(
  findings: readonly Finding[],
  key: (f: Finding) => K,
): Record<K, Finding[]> {
  const out = {} as Record<K, Finding[]>;
  for (const f of findings) {
    const k = key(f);
    (out[k] ??= []).push(f);
  }
  return out;
}
