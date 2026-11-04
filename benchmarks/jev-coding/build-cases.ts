/**
 * Builds `cases.json` from real artifacts in this workspace.
 *
 * Inputs (all read-only):
 *   - openhub git history (real commits + diffs)
 *   - audit-reports/<app>/report.json + audit-reports/openhub/web_findings.json
 *   - openhub/AUDIT-UPGRADE.md (curated findings, cited by section)
 *   - the openhub working tree (real file paths)
 *
 * Run: npx tsx benchmarks/jev-coding/build-cases.ts
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditAdvisory,
  repairAdvisory,
  reviewAdvisory,
  workspaceAdvisory,
} from '../../src/services/jevClient.js';
import { labelAudit, labelRepair, labelReview, labelWorkspace } from './labeler.js';
import type { BenchmarkCase, ExpectedValue } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENHUB = path.resolve(HERE, '../..');
const WORKSPACE = path.resolve(OPENHUB, '..');
const AUDIT_REPORTS = path.join(WORKSPACE, 'audit-reports');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: OPENHUB, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function expected(labels: Record<string, ExpectedValue>): Record<string, ExpectedValue> {
  return labels;
}

// ---------------------------------------------------------------------------
// review: real commits
// ---------------------------------------------------------------------------

interface CommitMeta {
  sha: string;
  subject: string;
}

function reviewCases(): BenchmarkCase[] {
  const log = git(['log', '--format=%H|%s', '-24']).trim().split(/\r?\n/);
  const cases: BenchmarkCase[] = [];

  for (const line of log) {
    const [sha, subject] = line.split('|');
    if (!sha || !subject) continue;

    const numstat = git(['show', '--numstat', '--format=', sha]).trim();
    const files: string[] = [];
    let addedLines = 0;
    let removedLines = 0;
    for (const row of numstat.split(/\r?\n/)) {
      const parts = row.split('\t');
      if (parts.length < 3) continue;
      files.push(parts[2]);
      if (/^\d+$/.test(parts[0])) addedLines += Number(parts[0]);
      if (/^\d+$/.test(parts[1])) removedLines += Number(parts[1]);
    }
    if (files.length === 0) continue;

    const diff = git(['show', '--format=', '--unified=0', sha]);
    const addedText = diff
      .split(/\r?\n/)
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n')
      .slice(0, 6000);

    const label = labelReview({ addedText, files, addedLines, removedLines });
    const state = {
      fileCount: files.length,
      addedLines,
      removedLines,
      diffSummary: [
        `commit: ${subject}`,
        `files: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`,
        addedText
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 14)
          .join('\n'),
      ]
        .join('\n')
        .slice(0, 800),
    };

    const { state: jevState, questions } = reviewAdvisory(state);
    cases.push({
      id: `review/${sha.slice(0, 7)}`,
      family: 'review',
      source: `openhub@${sha.slice(0, 7)} — ${subject}`,
      state: jevState,
      questions,
      expected: expected({ verdict: label.verdict, merge: label.merge, risk: label.risk }),
      labelBasis: `Policy: addedLines=${addedLines} files=${files.length} tests=${files.some((f) => /test|spec/.test(f))}`,
      meta: { files, addedLines, removedLines },
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// repair: real audit findings
// ---------------------------------------------------------------------------

interface ReportFinding {
  rule: string;
  sev: string;
  cat?: string;
  file?: string;
  line?: number;
  msg?: string;
  hint?: string;
  autofix?: unknown;
}

interface AppReport {
  app?: string;
  before?: Record<string, number>;
  after?: Record<string, number>;
  findings?: ReportFinding[];
}

function repairCases(): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];
  const apps = fs
    .readdirSync(AUDIT_REPORTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const app of apps) {
    const file = path.join(AUDIT_REPORTS, app, 'report.json');
    if (!fs.existsSync(file)) continue;
    const report = readJson<AppReport>(file);
    const findings = (report.findings ?? []).slice(0, 2);
    for (const f of findings) {
      const finding = `${f.rule} ${f.sev}: ${f.msg ?? ''} (${f.file ?? 'unknown'}:${f.line ?? 0})`.slice(0, 400);
      const brief = `category=${f.cat ?? 'unknown'}; autofix=${f.autofix != null ? 'available' : 'none'}; hint=${f.hint ?? ''}`.slice(0, 1200);
      const label = labelRepair({ severity: f.sev, category: f.cat, rule: f.rule, autofix: f.autofix });
      const { state, questions } = repairAdvisory({ finding, brief });
      cases.push({
        id: `repair/${app}-${f.rule}-${f.line ?? 0}`,
        family: 'repair',
        source: `audit-reports/${app}/report.json`,
        state,
        questions,
        expected: expected({ lane: label.lane, urgent: label.urgent }),
        labelBasis: `Policy: severity=${f.sev} category=${f.cat ?? 'n/a'} autofix=${f.autofix != null}`,
        meta: { app, rule: f.rule, severity: f.sev },
      });
    }
  }

  // OpenHub's own lightweight web findings (all LOW, mostly mechanical).
  const web = readJson<Array<{ rule: string; severity: string; file: string; line: number; message: string }>>(
    path.join(AUDIT_REPORTS, 'openhub', 'web_findings.json'),
  );
  for (const f of web.slice(0, 6)) {
    const finding = `${f.rule} ${f.severity}: ${f.message} (${f.file}:${f.line})`.slice(0, 400);
    const brief = `category=lint; autofix=available; hint=mechanical lint finding`.slice(0, 1200);
    const label = labelRepair({ severity: f.severity, category: 'lint', rule: f.rule, autofix: 'available' });
    const { state, questions } = repairAdvisory({ finding, brief });
    cases.push({
      id: `repair/openhub-web-${f.rule}-${f.line}`.replace(/[^a-z0-9/-]+/gi, '-'),
      family: 'repair',
      source: `audit-reports/openhub/web_findings.json`,
      state,
      questions,
      expected: expected({ lane: label.lane, urgent: label.urgent }),
      labelBasis: `Policy: severity=${f.severity} category=lint autofix=available`,
      meta: { app: 'openhub', rule: f.rule, severity: f.severity },
    });
  }

  // Curated CRITICAL findings documented in openhub/AUDIT-UPGRADE.md.
  const criticals: Array<{ id: string; finding: string; brief: string; severity: string; category: string }> = [
    {
      id: 'C1',
      finding: 'SECURITY: unauthenticated /api/auth/quick-access creates an account and returns tokens (server.ts)',
      brief: 'category=security; autofix=none; hint=remove or gate the endpoint behind a dev-only flag',
      severity: 'CRITICAL',
      category: 'security',
    },
    {
      id: 'C2',
      finding: 'SECURITY: seeded accounts with hardcoded password123 (server.ts)',
      brief: 'category=security; autofix=none; hint=remove demo seeding from boot',
      severity: 'CRITICAL',
      category: 'security',
    },
    {
      id: 'C3',
      finding: 'Theater: /api/pipeline/run advances stages with setTimeout and fabricates success',
      brief: 'category=correctness; autofix=none; hint=replace with the real verification pipeline',
      severity: 'HIGH',
      category: 'correctness',
    },
    {
      id: 'C4',
      finding: 'Config: hardcoded fallback JWT secrets and reflect-any-origin credentialed CORS',
      brief: 'category=security; autofix=none; hint=persistent key file + ALLOWED_ORIGINS allowlist',
      severity: 'CRITICAL',
      category: 'security',
    },
    {
      id: 'C5',
      finding: 'Type safety: non-strict TypeScript hides 5 real type errors',
      brief: 'category=type_safety; autofix=available; hint=enable strict and fix the five errors',
      severity: 'MEDIUM',
      category: 'type_safety',
    },
  ];
  for (const c of criticals) {
    const label = labelRepair({ severity: c.severity, category: c.category, rule: c.finding, autofix: c.category === 'type_safety' ? 'available' : undefined });
    const { state, questions } = repairAdvisory({ finding: c.finding, brief: c.brief });
    cases.push({
      id: `repair/audit-upgrade-${c.id}`,
      family: 'repair',
      source: 'openhub/AUDIT-UPGRADE.md',
      state,
      questions,
      expected: expected({ lane: label.lane, urgent: label.urgent }),
      labelBasis: `Policy: severity=${c.severity} category=${c.category}`,
      meta: { app: 'openhub', rule: c.id, severity: c.severity },
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// audit: real audit reports
// ---------------------------------------------------------------------------

function sum(counts: Record<string, number> | undefined): number {
  return Object.values(counts ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

function auditCases(): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];
  const apps = fs
    .readdirSync(AUDIT_REPORTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const app of apps) {
    const file = path.join(AUDIT_REPORTS, app, 'report.json');
    if (!fs.existsSync(file)) continue;
    const report = readJson<AppReport>(file);
    const beforeTotal = sum(report.before);
    const afterTotal = sum(report.after);
    if (beforeTotal === 0 && afterTotal === 0 && (report.findings ?? []).length === 0) {
      // A genuinely clean app is a valid case: accept / severity 0.
      const { state, questions } = auditAdvisory({
        status: 'pass',
        factCount: 1,
        passedFacts: 1,
        discrepancies: [],
      });
      const label = labelAudit({ factCount: 1, passedFacts: 1, discrepancies: [] });
      cases.push({
        id: `audit/${app}-clean`,
        family: 'audit',
        source: `audit-reports/${app}/report.json`,
        state,
        questions,
        expected: expected({ severity: label.severity, next: label.next }),
        labelBasis: 'Policy: zero findings -> accept',
        meta: { app },
      });
      continue;
    }

    const factCount = Math.max(beforeTotal, afterTotal, 1);
    const passedFacts = Math.max(0, factCount - afterTotal);
    const discrepancies = (report.findings ?? []).map((f) => `${f.rule} ${f.sev}: ${f.msg ?? ''}`).slice(0, 6);
    const status = afterTotal === 0 ? 'pass' : 'fail';
    const label = labelAudit({ factCount, passedFacts, discrepancies });
    const { state, questions } = auditAdvisory({ status, factCount, passedFacts, discrepancies });
    cases.push({
      id: `audit/${app}`,
      family: 'audit',
      source: `audit-reports/${app}/report.json`,
      state,
      questions,
      expected: expected({ severity: label.severity, next: label.next }),
      labelBasis: `Policy: ${afterTotal} open / ${factCount} facts, status=${status}`,
      meta: { app, beforeTotal, afterTotal },
    });
  }

  // OpenHub's web findings: 50 LOW checks, so a real state with no fixes applied.
  const web = readJson<Array<{ rule: string; severity: string; message: string }>>(
    path.join(AUDIT_REPORTS, 'openhub', 'web_findings.json'),
  );
  const rules = [...new Set(web.map((f) => `${f.rule} ${f.severity}`))];
  const label = labelAudit({ factCount: web.length, passedFacts: 0, discrepancies: rules });
  const { state, questions } = auditAdvisory({
    status: 'fail',
    factCount: web.length,
    passedFacts: 0,
    discrepancies: rules,
  });
  cases.push({
    id: 'audit/openhub-web',
    family: 'audit',
    source: 'audit-reports/openhub/web_findings.json',
    state,
    questions,
    expected: expected({ severity: label.severity, next: label.next }),
    labelBasis: `Policy: ${web.length} low/mechanical findings, 0 fixed`,
    meta: { app: 'openhub' },
  });

  return cases;
}

// ---------------------------------------------------------------------------
// workspace: real paths in the working tree
// ---------------------------------------------------------------------------

function workspaceCases(): BenchmarkCase[] {
  const tracked = git(['ls-files']).trim().split(/\r?\n/);
  const pick = (re: RegExp): string | undefined => tracked.find((p) => re.test(p));

  const paths: Array<{ path: string; operation: string }> = [
    { path: pick(/^src\/services\/llmRouter\.ts$/) ?? 'src/services/llmRouter.ts', operation: 'read' },
    { path: pick(/^src\/services\/llmRouter\.ts$/) ?? 'src/services/llmRouter.ts', operation: 'write' },
    { path: 'server.ts', operation: 'write' },
    { path: pick(/^tests\/.*\.test\.ts$/) ?? 'tests/workspaceTools.routes.test.ts', operation: 'read' },
    { path: 'package.json', operation: 'write' },
    { path: 'README.md', operation: 'write' },
    { path: 'README.md', operation: 'read' },
    { path: '.env', operation: 'read' },
    { path: '.env', operation: 'write' },
    { path: '.env.example', operation: 'write' },
    { path: '.git/config', operation: 'read' },
    { path: '.git/config', operation: 'write' },
    { path: 'node_modules/react/package.json', operation: 'read' },
    { path: 'node_modules/react/package.json', operation: 'write' },
    { path: pick(/^Logo\/.*\.(png|svg|jpg)$/) ?? 'Logo/logo.png', operation: 'read' },
    { path: '../outside-workspace.txt', operation: 'write' },
    { path: 'C:/Windows/System32/drivers/etc/hosts', operation: 'read' },
    { path: 'docs/notes.md', operation: 'delete' },
    { path: 'src/App.tsx', operation: 'delete' },
    { path: 'src/auth/tokenService.ts', operation: 'write' },
  ];

  return paths.map((c, index) => {
    const label = labelWorkspace(c.path, c.operation);
    const { state, questions } = workspaceAdvisory(c);
    return {
      id: `workspace/${String(index + 1).padStart(2, '0')}-${c.operation}-${c.path.replace(/[^a-z0-9]+/gi, '-')}`,
      family: 'workspace' as const,
      source: `openhub working tree: ${c.path}`,
      state,
      questions,
      expected: expected({ allow: label.allow, risk: label.risk }),
      labelBasis: `Policy: path=${c.path} operation=${c.operation}`,
      meta: { path: c.path, operation: c.operation },
    };
  });
}

// ---------------------------------------------------------------------------

function main(): void {
  const all = [...reviewCases(), ...repairCases(), ...auditCases(), ...workspaceCases()];
  const seen = new Set<string>();
  const unique = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const out = path.join(HERE, 'cases.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), cases: unique }, null, 2) + '\n');

  const byFamily = unique.reduce<Record<string, number>>((acc, c) => {
    acc[c.family] = (acc[c.family] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`wrote ${unique.length} cases to ${path.relative(process.cwd(), out)}`);
  console.log(byFamily);
}

main();
