import fs from 'fs';
import path from 'path';
import { getDb } from '../auth/db.js';
import { getAgentReadouts, buildWorkOrder } from './agentReadouts.js';

/**
 * Dream state — a background monitor that continuously analyzes every repo in
 * the node until each one's status, purpose, and development are tracked and
 * graded. Results persist to `dream_state` and are surfaced by the dashboard
 * and copilot. Every read is best-effort; a repo that can't be read degrades
 * to an explicit status, never a fabricated grade.
 */

export interface DreamEntry {
  repoId: string;
  name: string;
  status: 'unanalyzed' | 'healthy' | 'attention' | 'critical';
  purpose: string;
  development: string;
  grade: string | null;
  score: number | null;
  findings: number;
  summary: string;
  lastAnalyzedAt: string | null;
}

interface RepoRow {
  id: string;
  name: string;
  description: string;
  full_path: string;
  language: string;
}

const GRADE_THRESHOLDS = { A: 90, B: 75, C: 60, D: 40 };

function gradeFromScore(score: number | null): string {
  if (score === null) return '—';
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  if (score >= GRADE_THRESHOLDS.D) return 'D';
  return 'F';
}

function statusFromGrade(grade: string): DreamEntry['status'] {
  if (grade === 'A' || grade === 'B') return 'healthy';
  if (grade === 'C') return 'attention';
  if (grade === 'D' || grade === 'F') return 'critical';
  return 'unanalyzed';
}

function readPurpose(repo: RepoRow): string {
  const candidates = ['README.md', 'readme.md', 'Readme.md'];
  for (const f of candidates) {
    try {
      const p = path.join(repo.full_path, f);
      if (!fs.existsSync(p)) continue;
      const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
      const title = head.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('#'));
      if (title) return title.replace(/^#+\s*/, '').slice(0, 200);
      const firstText = head.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (firstText) return firstText.slice(0, 200);
    } catch { /* keep looking */ }
  }
  return repo.description || 'no stated purpose';
}

function readDevelopment(repo: RepoRow): string {
  try {
    const gitDir = path.join(repo.full_path, '.git');
    if (!fs.existsSync(gitDir)) return 'not a git repo';
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return 'no commits';
    const stat = fs.statSync(headPath);
    const days = Math.round((Date.now() - stat.mtimeMs) / 86_400_000);
    if (days <= 1) return 'active (today)';
    if (days <= 7) return `active (${days}d ago)`;
    if (days <= 30) return `dormant (${days}d ago)`;
    return `stale (${days}d ago)`;
  } catch {
    return 'unknown';
  }
}

function repoAuditScore(repo: RepoRow): { verdict: string | null; avg: number | null; findings: number } {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT report_json FROM audit_reports ORDER BY created_at DESC LIMIT 200').all() as Array<{ report_json: string }>;
    const targetNorm = repo.full_path.replace(/\\/g, '/').toLowerCase();
    for (const row of rows) {
      let report: any = null;
      try { report = JSON.parse(row.report_json); } catch { continue; }
      const t = typeof report?.target === 'string' ? report.target.replace(/\\/g, '/').toLowerCase() : '';
      const match = t === targetNorm || t.endsWith(`/${repo.name.toLowerCase()}`) || t.includes(`/${repo.name.toLowerCase()}/`) || t.includes(repo.name.toLowerCase());
      if (!match) continue;
      const results: any[] = Array.isArray(report.results) ? report.results : [];
      const scores = results.filter((r) => typeof r?.score === 'number').map((r) => r.score as number);
      const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
      // Findings from the agent readouts for this repo's name.
      const findings = buildWorkOrder(getAgentReadouts(repo.name)).total;
      return { verdict: report.overallStatus ?? null, avg, findings };
    }
  } catch { /* no audit data */ }
  return { verdict: null, avg: null, findings: 0 };
}

export function analyzeRepo(repo: RepoRow): DreamEntry {
  const purpose = readPurpose(repo);
  const development = readDevelopment(repo);
  const audit = repoAuditScore(repo);
  const score = audit.avg;
  const grade = score !== null ? gradeFromScore(score) : '—';
  const status = statusFromGrade(grade);
  const summary = [
    `${repo.name}: ${grade} (${score ?? 'unscored'})`,
    purpose,
    development,
    audit.findings ? `${audit.findings} findings` : 'no findings',
  ].join(' · ');
  return {
    repoId: repo.id,
    name: repo.name,
    status,
    purpose,
    development,
    grade: grade === '—' ? null : grade,
    score,
    findings: audit.findings,
    summary,
    lastAnalyzedAt: new Date().toISOString(),
  };
}

export function dreamTick(): number {
  ensureTable();
  const db = getDb();
  const repos = db.prepare('SELECT id, name, description, full_path, language FROM repositories').all() as RepoRow[];
  const upsert = db.prepare(`
    INSERT INTO dream_state (repo_id, status, purpose, development, grade, score, findings, summary, last_analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      status = excluded.status, purpose = excluded.purpose, development = excluded.development,
      grade = excluded.grade, score = excluded.score, findings = excluded.findings,
      summary = excluded.summary, last_analyzed_at = excluded.last_analyzed_at
  `);
  const now = new Date().toISOString();
  for (const repo of repos) {
    const entry = analyzeRepo(repo);
    upsert.run(entry.repoId, entry.status, entry.purpose, entry.development, entry.grade, entry.score, entry.findings, entry.summary, now);
  }
  return repos.length;
}

export function dreamState(): DreamEntry[] {
  ensureTable();
  const rows = getDb().prepare(`
    SELECT d.repo_id, r.name, d.status, d.purpose, d.development, d.grade, d.score, d.findings, d.summary, d.last_analyzed_at
    FROM dream_state d JOIN repositories r ON r.id = d.repo_id
    ORDER BY d.last_analyzed_at DESC
  `).all() as any[];
  return rows.map((r) => ({
    repoId: r.repo_id,
    name: r.name,
    status: r.status,
    purpose: r.purpose,
    development: r.development,
    grade: r.grade,
    score: r.score,
    findings: r.findings,
    summary: r.summary,
    lastAnalyzedAt: r.last_analyzed_at,
  }));
}

function ensureTable(): void {
  // Table is created in db.ts initializeDatabase; this is a no-op guard for tests.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS dream_state (
      repo_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'unanalyzed', purpose TEXT NOT NULL DEFAULT '',
      development TEXT NOT NULL DEFAULT 'inactive', grade TEXT, score REAL, findings INTEGER DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '', last_analyzed_at TEXT
    );
  `);
}

export function startDreamLoop(intervalMs = 120_000): NodeJS.Timeout {
  void dreamTick();
  return setInterval(() => {
    try { dreamTick(); } catch { /* a repo failing must not kill the loop */ }
  }, intervalMs);
}
