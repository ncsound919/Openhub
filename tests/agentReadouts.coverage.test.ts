import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildWorkOrder,
  codegraphFindings,
  getAgentReadouts,
  getOssReviewReadouts,
  ocrFindings,
  type AgentReadout,
  type ReadoutFinding,
} from '../src/services/agentReadouts';
import type { OssReviewReport } from '../src/services/ossReview';

const tmpDirs: string[] = [];

function tmp(prefix = 'openhub-readouts-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function finding(overrides: Partial<ReadoutFinding> = {}): ReadoutFinding {
  return {
    ruleId: 'r',
    title: 'title',
    category: 'cat',
    source: 'src',
    file: 'f.ts',
    explanation: 'expl',
    severity: 'low',
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
});

describe('getAgentReadouts', () => {
  it('reads available, matched and unmatched reports from disk', () => {
    const deep = tmp('openhub-deep-');
    const codenexus = tmp('openhub-codenexus-');
    const benchmark = tmp('openhub-benchmark-');
    writeFile(deep, 'deep.json', JSON.stringify({
      target: 'C:/proj/myapp',
      scannedFiles: 12,
      counts: { high: 1 },
      findings: [{ ruleId: 'r1', title: 'XSS', category: 'security', source: 'static', file: 'src/a.ts:10', severity: 'high' }],
    }));
    writeFile(codenexus, 'cn.json', JSON.stringify({
      target: 'C:/proj/other-app', scannedFiles: 3, counts: {}, findings: [],
    }));
    writeFile(benchmark, 'bench.txt', 'Benchmark report for myapp\nscore 42');

    const env = {
      OPENHUB_DEEP_REPORT_DIR: deep,
      OPENHUB_CODENEXUS_REPORT_DIR: codenexus,
      OPENHUB_BENCHMARK_REPORT_DIR: benchmark,
    };
    const readouts = getAgentReadouts('myapp', env);
    expect(readouts).toHaveLength(3);

    const deepReadout = readouts.find((r) => r.tool === 'the-deep')!;
    expect(deepReadout.available).toBe(true);
    expect(deepReadout.matched).toBe(true);
    expect(deepReadout.scannedFiles).toBe(12);
    expect(deepReadout.counts).toEqual({ high: 1 });
    expect(deepReadout.findings).toHaveLength(1);
    expect(deepReadout.findings[0]).toMatchObject({ file: 'src/a.ts', line: '10', severity: 'high' });
    expect(deepReadout.score).toBe(100);
    expect(deepReadout.grade).toBe('A');
    expect(deepReadout.reportPath).toBeTruthy();

    const cn = readouts.find((r) => r.tool === 'codenexus')!;
    expect(cn.available).toBe(true);
    expect(cn.matched).toBe(false);
    expect(cn.note).toContain('different project');
    expect(cn.score).toBe(95);
    expect(cn.grade).toBe('A');

    const bench = readouts.find((r) => r.tool === 'benchmark-olympics')!;
    expect(bench.kind).toBe('text');
    expect(bench.available).toBe(true);
    expect(bench.matched).toBe(true);
    expect(bench.readout).toContain('Benchmark');
    expect(bench.score).toBe(80);
    expect(bench.grade).toBe('B');
  });

  it('reports every tool unavailable when its report dir is absent', () => {
    const env = {
      OPENHUB_DEEP_REPORT_DIR: path.join(os.tmpdir(), 'openhub-none-deep'),
      OPENHUB_CODENEXUS_REPORT_DIR: path.join(os.tmpdir(), 'openhub-none-cn'),
      OPENHUB_BENCHMARK_REPORT_DIR: path.join(os.tmpdir(), 'openhub-none-bench'),
    };
    const readouts = getAgentReadouts('whatever', env);
    for (const r of readouts) {
      expect(r.available).toBe(false);
      expect(r.matched).toBe(false);
      expect(r.note).toContain('no report in');
      expect(r.score).toBeUndefined();
    }
  });

  it('reports no parseable report when every JSON file is corrupt', () => {
    const deep = tmp('openhub-deep-bad-');
    writeFile(deep, 'broken.json', '{ not json');
    const readouts = getAgentReadouts('app', {
      OPENHUB_DEEP_REPORT_DIR: deep,
      OPENHUB_CODENEXUS_REPORT_DIR: deep,
      OPENHUB_BENCHMARK_REPORT_DIR: deep,
    });
    const deepReadout = readouts.find((r) => r.tool === 'the-deep')!;
    expect(deepReadout.available).toBe(false);
    expect(deepReadout.note).toBe('no parseable report');
  });

  it('falls back to an older parseable report when the newest is corrupt', () => {
    const deep = tmp('openhub-deep-fallback-');
    const valid = writeFile(deep, 'valid.json', JSON.stringify({ target: 'C:/app', findings: [] }));
    const broken = writeFile(deep, 'broken.json', '{ nope');
    const now = Date.now();
    fs.utimesSync(valid, new Date(now - 60_000), new Date(now - 60_000));
    fs.utimesSync(broken, new Date(now), new Date(now));

    const readouts = getAgentReadouts('app', {
      OPENHUB_DEEP_REPORT_DIR: deep,
      OPENHUB_CODENEXUS_REPORT_DIR: deep,
      OPENHUB_BENCHMARK_REPORT_DIR: deep,
    });
    const deepReadout = readouts.find((r) => r.tool === 'the-deep')!;
    expect(deepReadout.available).toBe(true);
    expect(deepReadout.reportPath).toBe(valid);
  });

  it('ignores reports older than the freshness window', () => {
    const deep = tmp('openhub-deep-stale-');
    const stale = writeFile(deep, 'stale.json', JSON.stringify({ target: 'C:/app', findings: [] }));
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(stale, old, old);
    const readouts = getAgentReadouts('app', {
      OPENHUB_DEEP_REPORT_DIR: deep,
      OPENHUB_CODENEXUS_REPORT_DIR: deep,
      OPENHUB_BENCHMARK_REPORT_DIR: path.join(deep, 'nope'),
    });
    expect(readouts.find((r) => r.tool === 'the-deep')!.available).toBe(false);
  });

  it('normalizes malformed finding fields defensively', () => {
    const deep = tmp('openhub-deep-shapes-');
    writeFile(deep, 'shapes.json', JSON.stringify({
      target: 'C:/app',
      findeings: [],
      findings: [
        { title: 'Only title' },
        { file: 42, severity: 7, category: 1, source: null, explanation: 0, ruleId: 9 },
        'not-an-object',
      ],
    }));
    const readouts = getAgentReadouts('app', {
      OPENHUB_DEEP_REPORT_DIR: deep,
      OPENHUB_CODENEXUS_REPORT_DIR: deep,
      OPENHUB_BENCHMARK_REPORT_DIR: deep,
    });
    const findings = readouts.find((r) => r.tool === 'the-deep')!.findings;
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({ file: '', explanation: 'Only title', category: 'unknown', severity: 'unknown' });
    expect(findings[1]).toMatchObject({ file: '', category: 'unknown', severity: 'unknown', ruleId: '' });
    expect(findings[2].file).toBe('');
  });

  it('reports an unreadable text report honestly', () => {
    const benchmark = tmp('openhub-benchmark-dir-');
    fs.mkdirSync(path.join(benchmark, 'bundle'), { recursive: true });
    const readouts = getAgentReadouts('app', {
      OPENHUB_DEEP_REPORT_DIR: path.join(benchmark, 'none'),
      OPENHUB_CODENEXUS_REPORT_DIR: path.join(benchmark, 'none'),
      OPENHUB_BENCHMARK_REPORT_DIR: benchmark,
    });
    const bench = readouts.find((r) => r.tool === 'benchmark-olympics')!;
    expect(bench.available).toBe(false);
    expect(bench.note).toBe('unreadable report');
  });

  it('marks a text report as unmatched when the target is absent', () => {
    const benchmark = tmp('openhub-benchmark-nomatch-');
    writeFile(benchmark, 'b.txt', 'score for another project');
    const readouts = getAgentReadouts('myapp', {
      OPENHUB_DEEP_REPORT_DIR: path.join(benchmark, 'none'),
      OPENHUB_CODENEXUS_REPORT_DIR: path.join(benchmark, 'none'),
      OPENHUB_BENCHMARK_REPORT_DIR: benchmark,
    });
    const bench = readouts.find((r) => r.tool === 'benchmark-olympics')!;
    expect(bench.available).toBe(true);
    expect(bench.matched).toBe(false);
    expect(bench.score).toBe(80);
    expect(bench.grade).toBe('B');
  });
});

describe('buildWorkOrder', () => {
  it('prioritizes by severity, then category, then location', () => {
    const readouts: AgentReadout[] = [{
      tool: 'the-deep',
      label: 'the-deep',
      kind: 'json',
      available: true,
      matched: true,
      scannedFiles: null,
      counts: null,
      findings: [
        finding({ ruleId: 'b', title: 'B', category: 'beta', file: 'z.ts', line: '9', explanation: '', severity: 'low' }),
        finding({ ruleId: 'a', title: 'A', category: 'alpha', file: 'a.ts', line: '2', explanation: 'why', severity: 'critical' }),
        finding({ ruleId: 'c', title: 'C', category: 'alpha', file: 'a.ts', line: '1', explanation: '', severity: 'unknown' }),
      ],
    }];
    const order = buildWorkOrder(readouts);
    expect(order.total).toBe(3);
    expect(order.items.map((i) => i.ruleId)).toEqual(['a', 'b', 'c']);
    expect(order.items[0].suggestion).toBe('why');
    expect(order.items[1].suggestion).toBe('B');
    expect(order.items[2].tool).toBe('the-deep');
    expect(order.total).toBe(order.items.length);
  });

  it('returns an empty order for readouts without findings', () => {
    expect(buildWorkOrder([])).toEqual({ items: [], total: 0 });
  });
});

describe('codegraphFindings', () => {
  it('grades review priorities by risk and omits location when absent', () => {
    const findings = codegraphFindings({
      graph: {
        available: true,
        report: {
          test_gaps: [
            { name: 'a', file: 'src/a.ts' },
            { file: 'src/b.ts', line_start: null },
          ],
          review_priorities: [
            { name: 'hi', file_path: 'src/hi.ts', risk_score: 0.8 },
            { name: 'mid', file_path: 'src/mid.ts', risk_score: 0.5 },
            { name: 'lo', file_path: 'src/lo.ts', risk_score: 0.2 },
            { name: 'nan', file_path: 'src/nan.ts', risk_score: 'x' },
          ],
        },
      },
    } as unknown as OssReviewReport);
    const gaps = findings.filter((f) => f.ruleId === 'crg:test-gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[0].title).toContain('a');
    expect(gaps[0].line).toBeUndefined();
    expect(gaps[1].ruleId).toBe('crg:test-gap');
    const risks = findings.filter((f) => f.ruleId === 'crg:change-risk');
    expect(risks.map((r) => r.severity)).toEqual(['high', 'medium', 'low', 'low']);
    expect(risks[0].line).toBeUndefined();
  });

  it('returns nothing when the graph or report is absent', () => {
    expect(codegraphFindings(undefined)).toEqual([]);
    expect(codegraphFindings({ graph: {} })).toEqual([]);
  });
});

describe('ocrFindings', () => {
  it('normalizes every alias field', () => {
    const findings = ocrFindings({
      llmReview: {
        configured: true,
        findings: [
          { path: 'p.ts', message: 'm', rule: 'r', suggestion: 's', level: 'HIGH' },
          { file_path: 'fp.ts', description: 'd', rule_id: 'rid' },
          { comment: 'c' },
          null,
        ],
      },
    });
    expect(findings).toHaveLength(4);
    expect(findings[0]).toMatchObject({ file: 'p.ts', title: 'm', ruleId: 'r', explanation: 's', severity: 'high' });
    expect(findings[1]).toMatchObject({ file: 'fp.ts', title: 'd', ruleId: 'rid' });
    expect(findings[2].title).toBe('c');
    expect(findings[3].title).toBe('Review comment');
  });

  it('caps findings at 200', () => {
    const many = Array.from({ length: 205 }, (_, i) => ({ file: `f${i}.ts`, message: `m${i}` }));
    const findings = ocrFindings({ llmReview: { configured: true, findings: many } });
    expect(findings).toHaveLength(200);
  });

  it('returns nothing for an object without a findings array', () => {
    expect(ocrFindings({ llmReview: { configured: true, findings: { other: [] } } })).toEqual([]);
  });
});

describe('getOssReviewReadouts', () => {
  it('surfaces graph, OCR and LLM details when everything is available', async () => {
    const report: OssReviewReport = {
      graph: {
        available: true,
        error: 'graph warning',
        report: {
          risk_score: 0.42,
          changed_functions: [{ name: 'a' }, { name: 'b' }],
          affected_flows: [{}, {}, {}],
          test_gaps: [{ name: 'a', file: 'src/a.ts', line_start: 1 }],
        },
      },
      ocr: { available: true, preview: { reviewable_count: 4, total_files: 5 } },
      llmReview: { configured: true, error: 'llm quota', findings: { findings: [{ message: 'x' }] } },
    };
    const readouts = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: true, report }));
    const graph = readouts.find((r) => r.tool === 'codegraph')!;
    expect(graph.available).toBe(true);
    expect(graph.scannedFiles).toBe(2);
    expect(graph.counts).toEqual({ testGaps: 1, changedFunctions: 2, affectedFlows: 3 });
    expect(graph.note).toBe('graph warning');
    expect(graph.findings).toHaveLength(1);

    const ocr = readouts.find((r) => r.tool === 'ocr')!;
    expect(ocr.scannedFiles).toBe(4);
    expect(ocr.counts).toEqual({ reviewable: 4, total: 5 });
    expect(ocr.note).toBe('llm quota');
    expect(ocr.findings).toHaveLength(1);
  });

  it('notes unavailable graph and OCR tools from their own errors', async () => {
    const report: OssReviewReport = {
      graph: { available: false, error: 'graph down' },
      ocr: { available: false, error: 'ocr down' },
    };
    const readouts = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: true, report }));
    const graph = readouts.find((r) => r.tool === 'codegraph')!;
    expect(graph.available).toBe(false);
    expect(graph.note).toBe('graph down');
    expect(graph.counts).toBeNull();
    const ocr = readouts.find((r) => r.tool === 'ocr')!;
    expect(ocr.available).toBe(false);
    expect(ocr.note).toBe('ocr down');
  });

  it('falls back to the generic unavailable note when the report is missing', async () => {
    const noReport = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: true }));
    expect(noReport.every((r) => r.note === 'Axiom oss-review unreachable')).toBe(true);

    const failed = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: false }));
    expect(failed.every((r) => r.note === 'Axiom oss-review unreachable')).toBe(true);
  });
});
