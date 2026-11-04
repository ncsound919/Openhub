/**
 * Runs the JEV coding benchmark.
 *
 *   npx tsx benchmarks/jev-coding/build-cases.ts     # regenerate cases.json
 *   npx tsx benchmarks/jev-coding/run.ts             # HF JEV vs DeepSeek Flash
 *   npx tsx benchmarks/jev-coding/run.ts --judge     # + DeepSeek Pro adjudicates disagreements
 *   npx tsx benchmarks/jev-coding/run.ts --families=review,workspace --limit=8
 *
 * Writes benchmarks/jev-coding/report.json and REPORT.md.
 */

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { costUsd, isCorrect, judgeCase, runDeepSeek, runLocalJev } from './runners.js';
import type { AnswerMap, BenchmarkCase, CaseResult, EngineRun, Family } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENHUB = path.resolve(HERE, '../..');
dotenv.config({ path: path.join(OPENHUB, '.env'), quiet: true });

// ---------------------------------------------------------------------------
// Case loading + args
// ---------------------------------------------------------------------------

interface CaseFile {
  generatedAt: string;
  cases: BenchmarkCase[];
}

function args(): {
  families?: Family[];
  limit?: number;
  judge: boolean;
  reuse: boolean;
  retryFailures: boolean;
  reportOnly: boolean;
  model: string;
  tag: string;
} {
  const out = {
    families: undefined as Family[] | undefined,
    limit: undefined as number | undefined,
    judge: false,
    reuse: false,
    retryFailures: false,
    reportOnly: false,
    model: 'deepseek-flash',
    tag: '',
  };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--judge') out.judge = true;
    else if (raw === '--report-only') {
      out.reportOnly = true;
      out.reuse = true;
    } else if (raw === '--judge-only') {
      out.judge = true;
      out.reuse = true;
    } else if (raw === '--reuse') out.reuse = true;
    else if (raw === '--retry-failures') out.retryFailures = true;
    else if (raw.startsWith('--families=')) out.families = raw.slice('--families='.length).split(',') as Family[];
    else if (raw.startsWith('--limit=')) out.limit = Number(raw.slice('--limit='.length));
    else if (raw.startsWith('--model=')) out.model = raw.slice('--model='.length);
    else if (raw.startsWith('--tag=')) out.tag = raw.slice('--tag='.length);
  }
  return out;
}

interface PreviousReport {
  model?: string;
  results?: CaseResult[];
}

function previousResults(model: string): Map<string, CaseResult> {
  const file = path.join(HERE, 'report.json');
  if (!fs.existsSync(file)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as PreviousReport;
    if (data.model && data.model !== model) return new Map();
    // The report stores a flat row keyed by `id` (not the full case object).
    return new Map(
      (data.results ?? []).map((r) => {
        const row = r as unknown as CaseResult & { id: string };
        return [row.id, row] as const;
      }),
    );
  } catch {
    return new Map();
  }
}

function loadCases(opts: ReturnType<typeof args>): BenchmarkCase[] {
  const file = path.join(HERE, 'cases.json');
  if (!fs.existsSync(file)) throw new Error('cases.json missing — run build-cases.ts first');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CaseFile;
  let cases = data.cases;
  if (opts.families?.length) cases = cases.filter((c) => opts.families!.includes(c.family));
  if (opts.limit) cases = cases.slice(0, opts.limit);
  return cases;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreRun(c: BenchmarkCase, run: EngineRun): Record<string, boolean> {
  const scores: Record<string, boolean> = {};
  for (const [key, expected] of Object.entries(c.expected)) {
    scores[key] = isCorrect(expected, run.answers[key]);
  }
  return scores;
}

interface Metrics {
  cases: number;
  exact: number;
  keys: number;
  correctKeys: number;
  keyAccuracy: number;
  exactRate: number;
  latencyMs: { mean: number; p50: number; max: number };
  tokens: { input: number; output: number; reasoning: number };
  costUsd: number;
  errors: number;
  byKey: Record<string, { correct: number; total: number; rate: number }>;
}

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * 0.5)];
}

function metrics(results: Array<{ case: BenchmarkCase; run: EngineRun; scores: Record<string, boolean> }>): Metrics {
  const byKey: Metrics['byKey'] = {};
  let correctKeys = 0;
  let keys = 0;
  let exact = 0;
  let errors = 0;
  const tokens = { input: 0, output: 0, reasoning: 0 };
  let cost = 0;
  const latencies: number[] = [];

  for (const r of results) {
    if (!r.run.ok) errors++;
    // A timeout is not a latency sample: report the mean over completed runs
    // and surface the failure count separately.
    else latencies.push(r.run.latencyMs);
    if (r.run.usage) {
      tokens.input += r.run.usage.inputTokens;
      tokens.output += r.run.usage.outputTokens;
      tokens.reasoning += r.run.usage.reasoningTokens ?? 0;
    }
    cost += costUsd(r.run.model ?? '', r.run.usage);
    const entries = Object.entries(r.scores);
    keys += entries.length;
    const hits = entries.filter(([, ok]) => ok).length;
    correctKeys += hits;
    if (hits === entries.length) exact++;
    for (const [key, ok] of entries) {
      byKey[key] ??= { correct: 0, total: 0, rate: 0 };
      byKey[key].total++;
      if (ok) byKey[key].correct++;
    }
  }
  for (const v of Object.values(byKey)) v.rate = v.total ? v.correct / v.total : 0;
  return {
    cases: results.length,
    exact,
    keys,
    correctKeys,
    keyAccuracy: keys ? correctKeys / keys : 0,
    exactRate: results.length ? exact / results.length : 0,
    latencyMs: {
      mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50: p50(latencies),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    tokens,
    costUsd: cost,
    errors,
    byKey,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

function answerLabel(a: AnswerMap[string] | undefined): string {
  if (!a) return '—';
  if (a.type === 'noul') return a.value ? 'true' : 'false';
  return String(a.value);
}

function expectedLabel(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

function familyTable(byFamily: Record<string, { jev: Metrics; deepseek: Metrics }>): string {
  const rows = Object.entries(byFamily)
    .map(
      ([family, m]) =>
        `| ${family} | ${m.jev.cases} | ${pct(m.jev.keyAccuracy)} | ${pct(m.deepseek.keyAccuracy)} | ${pct(m.jev.exactRate)} | ${pct(m.deepseek.exactRate)} |`,
    )
    .join('\n');
  return `| Family | Cases | JEV keys | DeepSeek keys | JEV exact | DeepSeek exact |\n|---|---:|---:|---:|---:|---:|\n${rows}`;
}

function keyTable(byFamily: Record<string, { jev: Metrics; deepseek: Metrics }>): string {
  const keys = new Set<string>();
  for (const m of Object.values(byFamily)) for (const k of Object.keys(m.jev.byKey)) keys.add(k);
  const rows = [...keys]
    .map((key) => {
      const jevTotal = Object.values(byFamily).reduce((a, m) => a + (m.jev.byKey[key]?.total ?? 0), 0);
      const jevCorrect = Object.values(byFamily).reduce((a, m) => a + (m.jev.byKey[key]?.correct ?? 0), 0);
      const dsTotal = Object.values(byFamily).reduce((a, m) => a + (m.deepseek.byKey[key]?.total ?? 0), 0);
      const dsCorrect = Object.values(byFamily).reduce((a, m) => a + (m.deepseek.byKey[key]?.correct ?? 0), 0);
      return `| ${key} | ${pct(jevTotal ? jevCorrect / jevTotal : 0)} (${jevCorrect}/${jevTotal}) | ${pct(dsTotal ? dsCorrect / dsTotal : 0)} (${dsCorrect}/${dsTotal}) |`;
    })
    .join('\n');
  return `| Question | JEV | DeepSeek |\n|---|---:|---:|\n${rows}`;
}

function confusion(results: CaseResult[]): string {
  const choiceKeys = [...new Set(results.flatMap((r) => Object.entries(r.case.questions).filter(([, q]) => q.type === 'choice').map(([k]) => k)))];
  const blocks: string[] = [];
  for (const key of choiceKeys) {
    const labels = new Set<string>();
    const matrix: Record<string, Record<string, { jev: number; deepseek: number }>> = {};
    for (const r of results) {
      const expected = r.case.expected[key];
      if (expected === undefined) continue;
      const e = expectedLabel(expected);
      labels.add(e);
      matrix[e] ??= {};
      for (const engine of ['jev', 'deepseek'] as const) {
        const pred = answerLabel(r[engine].answers[key]);
        labels.add(pred);
        matrix[e][pred] ??= { jev: 0, deepseek: 0 };
        matrix[e][pred][engine]++;
      }
    }
    const cols = [...labels];
    const header = `| ${key} (expected ↓ / predicted →) | ${cols.join(' | ')} |`;
    const sep = `|---|${cols.map(() => '---:').join('|')}|`;
    const rows = [...labels].map((e) => {
      const cells = cols.map((p) => {
        const cell = matrix[e]?.[p];
        if (!cell) return '';
        return `J ${cell.jev} / D ${cell.deepseek}`;
      });
      return `| **${e}** | ${cells.join(' | ')} |`;
    });
    blocks.push(`${header}\n${sep}\n${rows.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Per-class precision/recall for every choice question (handles skew). */
function classTable(results: CaseResult[]): string {
  const keys = [...new Set(results.flatMap((r) => Object.entries(r.case.questions).filter(([, q]) => q.type === 'choice').map(([k]) => k)))];
  const rows: string[] = [];
  for (const key of keys) {
    const classes = new Set<string>();
    for (const r of results) {
      if (r.case.expected[key] !== undefined) classes.add(expectedLabel(r.case.expected[key]));
    }
    for (const cls of classes) {
      const stats = (engine: 'jev' | 'deepseek') => {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        for (const r of results) {
          const exp = r.case.expected[key];
          if (exp === undefined) continue;
          const isExpected = expectedLabel(exp) === cls;
          const pred = answerLabel(r[engine].answers[key]);
          const isPred = pred === cls;
          if (isExpected && isPred) tp++;
          else if (!isExpected && isPred) fp++;
          else if (isExpected && !isPred) fn++;
        }
        return `${tp + fp ? ((tp / (tp + fp)) * 100).toFixed(0) : '—'}% / ${tp + fn ? ((tp / (tp + fn)) * 100).toFixed(0) : '—'}%`;
      };
      rows.push(`| ${key} | ${cls} | ${stats('jev')} | ${stats('deepseek')} |`);
    }
  }
  return `| Question | Class | JEV P/R | DeepSeek P/R |\n|---|---|---:|---:|\n${rows.join('\n')}`;
}

function labelBalance(results: CaseResult[]): string {
  const counts: Record<string, number> = {};
  for (const r of results) for (const v of Object.values(r.case.expected)) counts[expectedLabel(v)] = (counts[expectedLabel(v)] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

function disagreements(results: CaseResult[]): CaseResult[] {
  return results.filter((r) =>
    Object.keys(r.case.expected).some((k) => {
      const j = r.jev.answers[k];
      const d = r.deepseek.answers[k];
      return (j ? String(j.value) : '—') !== (d ? String(d.value) : '—');
    }),
  );
}

function markdown(
  cases: BenchmarkCase[],
  results: CaseResult[],
  byFamily: Record<string, { jev: Metrics; deepseek: Metrics }>,
  overall: { jev: Metrics; deepseek: Metrics },
  judgeSummary: { calls: number; jevWins: number; deepseekWins: number; ties: number; agreesWithPolicy: number } | null,
): string {
  const now = new Date().toISOString();
  const model = results[0]?.deepseek.model ?? 'deepseek-flash';
  const dis = disagreements(results);
  const judgeRows = dis
    .filter((r) => r.judge)
    .slice(0, 15)
    .map(
      (r) =>
        `| \`${r.case.id}\` | ${r.case.family} | ${Object.entries(r.case.expected)
          .map(([k, v]) => `${k}=${expectedLabel(v)}`)
          .join(', ')} | ${Object.entries(r.case.expected)
          .map(([k]) => answerLabel(r.jev.answers[k]))
          .join(', ')} | ${Object.entries(r.case.expected)
          .map(([k]) => answerLabel(r.deepseek.answers[k]))
          .join(', ')} | ${r.judge?.winner ?? '—'}${r.judge?.agreesWithPolicy ? ' ✓' : ''} |`,
    )
    .join('\n');

  return `# OpenHub coding decisions — JEV vs DeepSeek

Generated: **${now}**

## What this measures

OpenHub's coding-decision surface (review / repair triage / audit verdict / workspace
safety) was replayed over **${cases.length} cases extracted from real artifacts** in this
workspace. Each case is answered by two engines over the *same* typed state and questions:

- **HF JEV** — OpenHub's \`decideSystemOne\` against
  \`chaoliangUNSW/Jev-Style-0.8B-Decision-v3\` served locally by \`jev-style serve\` on
  \`127.0.0.1:8790\`.
- **DeepSeek Flash** — \`${model}\` via \`api.deepseek.com\` (temperature 0, \`effort=low\`).

Ground truth is produced by deterministic policy functions in \`labeler.ts\`; neither
engine sees the label. This is a decision-agreement benchmark, not a code-generation test.

## Headline

| Engine | Case exact | Key accuracy | Mean latency | p50 | Tokens in / out | Cost |
|---|---:|---:|---:|---:|---:|---:|
| HF JEV (Jev-Style 0.8B) | ${pct(overall.jev.exactRate)} | ${pct(overall.jev.keyAccuracy)} | ${fmtMs(overall.jev.latencyMs.mean)} | ${fmtMs(overall.jev.latencyMs.p50)} | ${overall.jev.tokens.input} / ${overall.jev.tokens.output} | ${fmtUsd(overall.jev.costUsd)} |
| DeepSeek Flash | ${pct(overall.deepseek.exactRate)} | ${pct(overall.deepseek.keyAccuracy)} | ${fmtMs(overall.deepseek.latencyMs.mean)} | ${fmtMs(overall.deepseek.latencyMs.p50)} | ${overall.deepseek.tokens.input} / ${overall.deepseek.tokens.output} | ${fmtUsd(overall.deepseek.costUsd)} |

DeepSeek output tokens include ${overall.deepseek.tokens.reasoning} reasoning tokens.
Cost uses the rates in \`src/services/costTracker.ts\` (not a live price feed).

## By family

${familyTable(byFamily)}

## By question

${keyTable(byFamily)}

## Confusion (expected → predicted, J = JEV, D = DeepSeek)

${confusion(results)}

## Class balance

${labelBalance(results)}

## Per-class precision / recall (choice questions)

${classTable(results)}

## Disagreements

${dis.length} of ${results.length} cases differ on at least one answer.

| Case | Family | Policy | JEV | DeepSeek | Judge |
|---|---|---|---|---|---|
${judgeRows || '| — | — | — | — | — | — |'}

${
  judgeSummary
    ? `### Judge (DeepSeek Pro, disagreements only)\n\n- Calls: ${judgeSummary.calls}\n- Preferred JEV: ${judgeSummary.jevWins}\n- Preferred DeepSeek: ${judgeSummary.deepseekWins}\n- Ties: ${judgeSummary.ties}\n- Judge's own answers agree with the policy: ${judgeSummary.agreesWithPolicy}/${judgeSummary.calls} (${pct(judgeSummary.calls ? judgeSummary.agreesWithPolicy / judgeSummary.calls : 0)})\n`
    : '> Judge pass not run. Re-run with `--judge` to have DeepSeek Pro adjudicate disagreements.\n'
}

## Method

1. \`build-cases.ts\` reads only real artifacts:
   - **review** — real commits + diffs from \`openhub\` git history.
   - **repair** — real findings in \`audit-reports/*/report.json\`, \`audit-reports/openhub/web_findings.json\`,
     and the CRITICAL items documented in \`openhub/AUDIT-UPGRADE.md\`.
   - **audit** — real before/after severity counts in \`audit-reports/*/report.json\`.
   - **workspace** — real paths from the working tree (\`.env\`, \`.git/config\`, \`node_modules\`, source,
     docs, and out-of-root probes).
2. \`run.ts\` sends each case through OpenHub's own advisory builders (\`reviewAdvisory\`,
   \`repairAdvisory\`, \`auditAdvisory\`, \`workspaceAdvisory\`) and then through both engines.
3. Answers are compared key-by-key with the policy labels; \`noul\` is compared at the 0.5
   threshold, \`score\` at the exact integer, \`choice\` at the exact criteria key.
4. The optional judge sees the state, questions and both answer sets — never the policy label —
   and returns its own answer plus a winner.

### Label policies (short form)

- **workspace** — out-of-root, secret/credential files (even for reads), and mutations under
  \`.git\`/\`node_modules\` are risky; otherwise risk = operation blast radius.
- **repair** — CRITICAL or security-flavoured → \`hold\`; HIGH non-security → \`dispatch\`;
  mechanical/autofixable LOW/MEDIUM → \`autofix\`; else \`dispatch\`.
- **audit** — no failed facts → \`accept\`; security findings → \`flag\` (or \`reject\` when
  explicitly blocking); else severity from the failure ratio and \`autofix\`/\`flag\`.
- **review** — committed secret → \`block\`; risky construct, security-flavoured file,
  1000+ line change, or an untested non-trivial source change → \`request_changes\`; else \`approve\`.

## Limitations

- Labels are policy-derived, not human-adjudicated. They encode a defensible but opinionated
  policy; read \`labeler.ts\` before treating a delta as an error.
- The review class balance is skewed toward \`approve\` because this history is mostly healthy.
  Per-class precision/recall matter more than raw accuracy here.
- The HF JEV engine runs 0.8B parameters on CPU here; its latency is hardware-specific.
- DeepSeek cost uses the repository's configured rates, not a live pricing API.

## Reproduce

\`\`\`bash
cd openhub
npx tsx benchmarks/jev-coding/build-cases.ts
npx tsx benchmarks/jev-coding/run.ts --judge
\`\`\`
`;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = args();
  const cases = loadCases(opts);
  if (cases.length === 0) throw new Error('no cases matched');

  const prior = opts.reuse ? previousResults(opts.model) : new Map<string, CaseResult>();
  if (prior.size) console.log(`reusing ${prior.size} prior engine runs from report.json`);
  console.log(`running ${cases.length} cases (${opts.model}${opts.judge ? ' + judge' : ''})`);
  const results: CaseResult[] = [];

  if (opts.reportOnly) {
    for (const c of cases) {
      const cached = prior.get(c.id);
      if (!cached) throw new Error(`--report-only: no prior result for ${c.id}`);
      results.push({
        ...cached,
        case: c,
        scores: { jev: scoreRun(c, cached.jev), deepseek: scoreRun(c, cached.deepseek) },
      });
    }
    console.log(`report-only: rebuilt ${results.length} results from report.json`);
  }

  for (let i = 0; !opts.reportOnly && i < cases.length; i++) {
    const c = cases[i];
    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/${cases.length}] ${c.id} … `);

    const cached = prior.get(c.id);
    let result: CaseResult;
    if (cached) {
      result = {
        ...cached,
        case: c,
        scores: { jev: scoreRun(c, cached.jev), deepseek: scoreRun(c, cached.deepseek) },
      };
      if (opts.retryFailures && (!result.jev.ok || !result.deepseek.ok)) {
        // Re-ask only the engine that failed; keep the successful half.
        if (!result.jev.ok) {
          await new Promise((r) => setTimeout(r, 500));
          result.jev = await runLocalJev(c);
        }
        if (!result.deepseek.ok) result.deepseek = await runDeepSeek(c, opts.model);
        result.scores = { jev: scoreRun(c, result.jev), deepseek: scoreRun(c, result.deepseek) };
      }
    } else {
      const jev = await runLocalJev(c);
      const deepseek = await runDeepSeek(c, opts.model);
      result = { case: c, jev, deepseek, scores: { jev: scoreRun(c, jev), deepseek: scoreRun(c, deepseek) } };
    }

    const differs = Object.keys(c.expected).some((k) => {
      const j = result.jev.answers[k];
      const d = result.deepseek.answers[k];
      return (j ? String(j.value) : '—') !== (d ? String(d.value) : '—');
    });
    const alreadyJudged = result.judge?.model?.includes('pro');
    if (opts.judge && differs && !alreadyJudged && results.filter((r) => r.judge).length < 20) {
      const verdict = await judgeCase(c, result.jev, result.deepseek);
      if (verdict) {
        const judgeScores = scoreRun(c, {
          engine: 'judge',
          ok: true,
          answers: verdict.answers,
          latencyMs: 0,
          model: verdict.model,
        });
        result.judge = {
          winner: verdict.winner,
          reason: verdict.reason,
          agreesWithPolicy: Object.values(judgeScores).every(Boolean),
          model: verdict.model,
        };
      }
    }
    results.push(result);
    console.log(
      `${cached ? 'reused' : `JEV ${result.jev.ok ? 'ok' : 'FAIL'} / DeepSeek ${result.deepseek.ok ? 'ok' : 'FAIL'}`}${
        result.judge ? ` / judge ${result.judge.winner}` : ''
      }`,
    );
  }

  const byFamily: Record<string, { jev: Metrics; deepseek: Metrics }> = {};
  for (const family of [...new Set(cases.map((c) => c.family))]) {
    const subset = results.filter((r) => r.case.family === family);
    byFamily[family] = {
      jev: metrics(subset.map((r) => ({ case: r.case, run: r.jev, scores: r.scores.jev }))),
      deepseek: metrics(subset.map((r) => ({ case: r.case, run: r.deepseek, scores: r.scores.deepseek }))),
    };
  }
  const overall = {
    jev: metrics(results.map((r) => ({ case: r.case, run: r.jev, scores: r.scores.jev }))),
    deepseek: metrics(results.map((r) => ({ case: r.case, run: r.deepseek, scores: r.scores.deepseek }))),
  };

  const judged = results.filter((r) => r.judge);
  const judgeSummary = judged.length
    ? {
        calls: judged.length,
        jevWins: judged.filter((r) => r.judge!.winner === 'jev').length,
        deepseekWins: judged.filter((r) => r.judge!.winner === 'deepseek').length,
        ties: judged.filter((r) => r.judge!.winner === 'tie').length,
        agreesWithPolicy: judged.filter((r) => r.judge!.agreesWithPolicy).length,
      }
    : null;

  const payload = {
    generatedAt: new Date().toISOString(),
    model: opts.model,
    tag: opts.tag || undefined,
    caseCount: cases.length,
    overall,
    byFamily,
    results: results.map((r) => ({
      id: r.case.id,
      family: r.case.family,
      source: r.case.source,
      expected: r.case.expected,
      labelBasis: r.case.labelBasis,
      jev: { ok: r.jev.ok, answers: r.jev.answers, latencyMs: r.jev.latencyMs, model: r.jev.model, raw: r.jev.raw, error: r.jev.error },
      deepseek: { ok: r.deepseek.ok, answers: r.deepseek.answers, latencyMs: r.deepseek.latencyMs, model: r.deepseek.model, raw: r.deepseek.raw, usage: r.deepseek.usage, error: r.deepseek.error },
      scores: r.scores,
      judge: r.judge,
    })),
  };
  fs.writeFileSync(path.join(HERE, 'report.json'), JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(path.join(HERE, 'REPORT.md'), markdown(cases, results, byFamily, overall, judgeSummary));

  console.log('\n=== overall ===');
  console.log(`JEV      exact ${pct(overall.jev.exactRate)}  key ${pct(overall.jev.keyAccuracy)}  mean ${fmtMs(overall.jev.latencyMs.mean)}`);
  console.log(`DeepSeek exact ${pct(overall.deepseek.exactRate)}  key ${pct(overall.deepseek.keyAccuracy)}  mean ${fmtMs(overall.deepseek.latencyMs.mean)}  cost ${fmtUsd(overall.deepseek.costUsd)}`);
  console.log('wrote report.json + REPORT.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
