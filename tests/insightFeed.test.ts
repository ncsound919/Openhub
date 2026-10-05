import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../src/auth/db.js';
import { buildInsightFeed } from '../src/services/insightFeed.js';

const prevRecourseUrl = process.env.RECOURSE_URL;

function ensureAuditTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      overall_status TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `);
}

function reportJson(score: number, grade: string, findingCount: number): string {
  const findings = Array.from({ length: findingCount }, (_, i) => ({
    dimension: 'correctness',
    category: 'npe',
    severity: 'medium',
    location: { file: `src/f${i}.ts`, line: i + 1 },
    title: `finding ${i}`,
    suggestion: 'fix it',
  }));
  return JSON.stringify({
    id: `r-${score}-${findingCount}`,
    timestamp: new Date().toISOString(),
    target: '/tmp/proj',
    overallStatus: score >= 80 ? 'pass' : 'warn',
    overallScore: score,
    grade,
    results: [],
    findings,
    reconciliation: { dimensions: [] },
  });
}

beforeAll(() => {
  // Point Recourse at a refused port so the feed's optional recourse calls fail
  // fast instead of waiting on connect timeouts.
  process.env.RECOURSE_URL = 'http://127.0.0.1:1';
  ensureAuditTable();
  const db = getDb();
  db.prepare('DELETE FROM audit_reports').run();
  db.prepare('INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)')
    .run('a1', '/tmp/proj', '2026-09-20T00:00:00.000Z', 'warn', reportJson(64, 'D', 2));
  db.prepare('INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)')
    .run('a2', '/tmp/proj', '2026-09-21T00:00:00.000Z', 'warn', reportJson(70, 'D+', 3));
});

afterAll(() => {
  if (prevRecourseUrl === undefined) delete process.env.RECOURSE_URL;
  else process.env.RECOURSE_URL = prevRecourseUrl;
});

describe('buildInsightFeed', () => {
  it('returns a structured feed with counts, trends and source availability', async () => {
    const feed = await buildInsightFeed();
    expect(Array.isArray(feed.items)).toBe(true);
    expect(feed.counts).toBeTypeOf('object');
    expect(feed.trends).toBeTypeOf('object');
    expect(feed.sources).toHaveProperty('telemetry');
    expect(feed.sources).toHaveProperty('recourse');
    // Every item is classified into the feed vocabulary.
    for (const it of feed.items) {
      expect(['discovery', 'trend', 'tip', 'review', 'alert']).toContain(it.kind);
      expect(it.title.length).toBeGreaterThan(0);
    }
  });

  it('surfaces the audit delta (grade movement + new/fixed findings)', async () => {
    const feed = await buildInsightFeed();
    const item = feed.items.find((i) => i.id === 'audit:delta');
    expect(item).toBeDefined();
    expect(item?.evidence?.grade).toMatchObject({ from: 'D', to: 'D+', changed: true });
    expect((item?.evidence?.findings as { new: number }).new).toBeGreaterThan(0);
    expect(feed.sources.audit).toBe(true);
  });

  it('sorts alerts ahead of trends and tips', async () => {
    const feed = await buildInsightFeed();
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const sevs = feed.items.map((i) => rank[i.severity]);
    const sorted = [...sevs].sort((a, b) => a - b);
    expect(sevs).toEqual(sorted);
  });
});
