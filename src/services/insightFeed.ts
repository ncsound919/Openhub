import { getDb } from '../auth/db.js';
import { buildInsights, type Insight, type InsightSeverity, type InsightsTrends } from './insights.js';
import { buildAuditDelta, type DeltaReportInput } from './auditDelta.js';
import { listIncidents } from './incidentBus.js';
import { listPipelines } from './pipeline.js';
import { recourseProvenance } from './recourseClient.js';

/**
 * Insight feed — the operator-facing layer over everything the system has
 * learned about itself.
 *
 * Where `buildInsights` is a trends projection over telemetry + Recourse, this
 * composes that with the *outcome* stores — audit deltas, self-learning
 * episodes, incidents, and pipeline history — into a single stream of
 * discoveries, trends, tips, reviews and alerts. Each item cites its evidence;
 * nothing is invented and every offline source is reported.
 */

export type FeedKind = 'discovery' | 'trend' | 'tip' | 'review' | 'alert';

export interface FeedItem {
  id: string;
  kind: FeedKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  systems: string[];
  evidence?: Record<string, unknown>;
  at?: string;
}

export interface InsightFeed {
  generatedAt: string;
  items: FeedItem[];
  counts: Record<FeedKind, number>;
  trends: InsightsTrends;
  sources: {
    telemetry: boolean;
    recourse: boolean;
    audit: boolean;
    incidents: boolean;
    pipeline: boolean;
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const KIND_RANK: Record<FeedKind, number> = { alert: 0, review: 1, discovery: 2, trend: 3, tip: 4 };

/** Classify a base insight into the feed's vocabulary. */
function kindForInsight(insight: Insight): FeedKind {
  if (insight.severity === 'critical' || insight.severity === 'high') return 'alert';
  if (insight.id === 'synergy-candidates') return 'discovery';
  if (insight.id.startsWith('learn:') || insight.id === 'calibration') return 'tip';
  return 'trend';
}

function fromInsight(insight: Insight): FeedItem {
  return {
    id: `insight:${insight.id}`,
    kind: kindForInsight(insight),
    severity: insight.severity,
    title: insight.title,
    detail: insight.detail,
    systems: insight.systems,
    ...(insight.evidence ? { evidence: insight.evidence } : {}),
  };
}

/** Latest two stored audit reports → a delta insight (grade movement, new/fixed). */
function auditDeltaItem(): FeedItem | null {
  type StoredReport = DeltaReportInput & { overallStatus?: string };
  try {
    const rows = getDb()
      .prepare('SELECT report_json, created_at FROM audit_reports ORDER BY created_at DESC LIMIT 2')
      .all() as Array<{ report_json: string; created_at: string }>;
    if (rows.length === 0) return null;
    const parse = (s: string): StoredReport | null => {
      try { return JSON.parse(s) as StoredReport; } catch { return null; }
    };
    const current = parse(rows[0].report_json);
    if (!current) return null;
    const previous = rows[1] ? parse(rows[1].report_json) : null;
    const delta = buildAuditDelta(previous, current);
    const gradeChanged = delta.grade.changed;
    const status = current.overallStatus;
    return {
      id: 'audit:delta',
      kind: gradeChanged ? 'discovery' : 'trend',
      severity: status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'info',
      title: delta.headline,
      detail: [
        `${delta.findings.newCount} new, ${delta.findings.fixedCount} fixed, ${delta.findings.persistedCount} persisted findings.`,
        delta.reasons.length ? `Moved because: ${delta.reasons.slice(0, 3).join('; ')}.` : '',
      ].filter(Boolean).join(' '),
      systems: ['audit'],
      at: rows[0].created_at,
      evidence: {
        score: delta.score,
        grade: delta.grade,
        findings: {
          new: delta.findings.newCount,
          fixed: delta.findings.fixedCount,
          persisted: delta.findings.persistedCount,
          newByDimension: delta.findings.newByDimension,
        },
      },
    };
  } catch {
    return null;
  }
}

/** Recourse provenance → what it just learned (new verified patterns/genes). */
async function provenanceDiscovery(): Promise<FeedItem | null> {
  try {
    const r = await recourseProvenance(20);
    if (!r.available) return null;
    const data = r.data as unknown;
    const list: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === 'object'
        ? (['entries', 'genes', 'patterns', 'items', 'provenance'] as const)
            .map((k) => (data as Record<string, unknown>)[k])
            .find((v) => Array.isArray(v)) as unknown[] ?? []
        : [];
    if (list.length === 0) return null;
    const labels = list
      .slice(0, 3)
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return String(o.text ?? o.name ?? o.label ?? o.gene ?? o.summary ?? '').trim();
      })
      .filter(Boolean);
    if (labels.length === 0) return null;
    return {
      id: 'recourse:provenance',
      kind: 'discovery',
      severity: 'info',
      title: `Recourse recorded ${list.length} provenance entr${list.length === 1 ? 'y' : 'ies'}`,
      detail: `Newly learned patterns available as prior art: ${labels.join(' · ')}.`,
      systems: ['recourse', 'self-learning'],
      evidence: { count: list.length, labels },
    };
  } catch {
    return null;
  }
}

/** Open incidents → things that need a human look, worst first. */
function incidentItems(): FeedItem[] {
  try {
    return listIncidents(30)
      .filter((i) => i.severity === 'critical' || i.severity === 'high' || !i.dispatched)
      .slice(0, 5)
      .map((i) => ({
        id: `incident:${i.id}`,
        kind: i.severity === 'critical' || i.severity === 'high' ? 'alert' : 'review',
        severity: (i.severity === 'critical' ? 'critical' : i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : 'low') as InsightSeverity,
        title: `${i.source}: ${i.kind}`,
        detail: i.detail,
        systems: [i.source],
        at: i.createdAt,
        evidence: { dispatched: i.dispatched, dispatchResult: i.dispatchResult, dedupKey: i.dedupKey },
      }));
  } catch {
    return [];
  }
}

/** Pipeline history → a success-rate trend and a review item for the last failure. */
function pipelineItems(): FeedItem[] {
  try {
    const jobs = listPipelines(10);
    if (jobs.length === 0) return [];
    const finished = jobs.filter((j) => j.status !== 'running');
    const failed = finished.filter((j) => j.status === 'failed');
    const items: FeedItem[] = [];
    if (finished.length >= 2) {
      const rate = Math.round(((finished.length - failed.length) / finished.length) * 100);
      items.push({
        id: 'pipeline:trend',
        kind: 'trend',
        severity: failed.length === 0 ? 'info' : rate < 50 ? 'high' : 'medium',
        title: `Pipeline success ${rate}% over the last ${finished.length} runs`,
        detail: `${failed.length} failed of ${finished.length} completed autonomous runs.`,
        systems: ['pipeline'],
        evidence: { finished: finished.length, failed: failed.length, rate },
      });
    }
    const lastFail = failed[0];
    if (lastFail) {
      items.push({
        id: 'pipeline:last-failure',
        kind: 'review',
        severity: 'medium',
        title: `Last pipeline failure: ${lastFail.mode}`,
        detail: lastFail.error || 'A stage failed; the repair team was dispatched and an incident logged.',
        systems: ['pipeline'],
        at: lastFail.updatedAt,
        evidence: { jobId: lastFail.id, stages: lastFail.stages.map((s) => `${s.id}:${s.status}`) },
      });
    }
    return items;
  } catch {
    return [];
  }
}

export async function buildInsightFeed(opts: { windowMs?: number } = {}): Promise<InsightFeed> {
  const base = await buildInsights(opts);

  const items: FeedItem[] = [
    ...base.insights.map(fromInsight),
    ...incidentItems(),
    ...pipelineItems(),
  ];
  const auditItem = auditDeltaItem();
  if (auditItem) items.push(auditItem);
  const discovery = await provenanceDiscovery();
  if (discovery) items.push(discovery);

  // Dedup by id, then order by severity, then kind.
  const byId = new Map<string, FeedItem>();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
  const ordered = [...byId.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.title.localeCompare(b.title),
  );

  const counts: Record<FeedKind, number> = { discovery: 0, trend: 0, tip: 0, review: 0, alert: 0 };
  for (const it of ordered) counts[it.kind] += 1;

  return {
    generatedAt: new Date().toISOString(),
    items: ordered,
    counts,
    trends: base.trends,
    sources: {
      telemetry: base.sources.telemetry.available,
      recourse: base.sources.recourse.available,
      audit: auditItem !== null,
      incidents: ordered.some((i) => i.id.startsWith('incident:')),
      pipeline: ordered.some((i) => i.id.startsWith('pipeline:')),
    },
  };
}
