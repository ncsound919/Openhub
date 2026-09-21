/**
 * Machine-readable test-report parsing (P1, workstream B).
 *
 * The old QA gate scored 100/0 from the process exit code alone, which threw
 * away the real pass/fail/coverage signal a repo already prints. These parsers
 * turn the runners' own structured output (vitest/jest JSON, pytest-json-report,
 * JUnit XML) plus a coverage-text fallback into one summary the scorer can
 * reason about — including the individual failing tests.
 */

export interface TestFailure {
  name: string;
  file?: string;
  message?: string;
}

export interface TestSummary {
  runner: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  xfailed: number;
  durationMs: number | null;
  coveragePct: number | null;
  failures: TestFailure[];
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function emptySummary(runner: string): TestSummary {
  return {
    runner,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    xfailed: 0,
    durationMs: null,
    coveragePct: null,
    failures: [],
  };
}

function finalize(s: TestSummary): TestSummary | null {
  const accounted = s.passed + s.failed + s.skipped + s.xfailed;
  if (s.total === 0 && accounted === 0) return null;
  if (s.total === 0) s.total = accounted;
  return s;
}

function firstLine(text: unknown, max = 300): string | undefined {
  if (typeof text !== 'string') return undefined;
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, max);
}

/**
 * Vitest `--reporter=json` and Jest `--json` share a jest-compatible shape:
 * `numTotalTests` / `numPassedTests` / `numFailedTests` / `numPendingTests`
 * plus `testResults[].assertionResults[]` for the failure detail.
 */
export function parseJestLike(json: unknown, runner: string): TestSummary | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const s = emptySummary(runner);

  const total = num(o.numTotalTests);
  const passed = num(o.numPassedTests);
  const failed = num(o.numFailedTests);
  const pending = num(o.numPendingTests);
  const todo = num(o.numTodoTests);
  const suites = Array.isArray(o.testResults) ? (o.testResults as Array<Record<string, unknown>>) : [];

  if (total !== null || passed !== null || failed !== null) {
    s.total = total ?? 0;
    s.passed = passed ?? 0;
    s.failed = failed ?? 0;
    s.skipped = (pending ?? 0) + (todo ?? 0);
  } else {
    for (const suite of suites) {
      const assertions = Array.isArray(suite.assertionResults)
        ? (suite.assertionResults as Array<Record<string, unknown>>)
        : [];
      const name = typeof suite.name === 'string' ? suite.name : undefined;
      for (const a of assertions) {
        s.total += 1;
        const status = String(a.status ?? '').toLowerCase();
        if (status === 'passed') s.passed += 1;
        else if (status === 'failed') {
          s.failed += 1;
          const msgs = Array.isArray(a.failureMessages) ? a.failureMessages : [];
          s.failures.push({
            name: String(a.fullName ?? a.title ?? 'unnamed test'),
            ...(name ? { file: name } : {}),
            ...(msgs.length ? { message: firstLine(msgs[0]) } : {}),
          });
        } else if (status === 'pending' || status === 'todo' || status === 'skipped') s.skipped += 1;
        else if (status === 'xfailed') s.xfailed += 1;
      }
    }
  }

  // Failure detail when counts came from the summary but detail is available.
  if (s.failures.length === 0 && s.failed > 0) {
    for (const suite of suites) {
      const assertions = Array.isArray(suite.assertionResults)
        ? (suite.assertionResults as Array<Record<string, unknown>>)
        : [];
      for (const a of assertions) {
        if (String(a.status ?? '').toLowerCase() !== 'failed') continue;
        const msgs = Array.isArray(a.failureMessages) ? a.failureMessages : [];
        s.failures.push({
          name: String(a.fullName ?? a.title ?? 'unnamed test'),
          ...(typeof suite.name === 'string' ? { file: suite.name } : {}),
          ...(msgs.length ? { message: firstLine(msgs[0]) } : {}),
        });
      }
    }
  }

  if (typeof o.startTime === 'number' && typeof o.endTime === 'number') {
    s.durationMs = Math.max(0, o.endTime - o.startTime);
  }
  return finalize(s);
}

/**
 * pytest-json-report shape: `{ summary: {...}, tests: [{nodeid, outcome, ...}] }`.
 */
export function parsePytestJson(json: unknown, runner = 'pytest'): TestSummary | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const summary = (o.summary && typeof o.summary === 'object' ? o.summary : null) as Record<string, unknown> | null;
  if (!summary) return null;
  const s = emptySummary(runner);
  s.total = num(summary.total) ?? num(summary.collected) ?? 0;
  s.passed = num(summary.passed) ?? 0;
  s.failed = (num(summary.failed) ?? 0) + (num(summary.error) ?? 0);
  s.skipped = num(summary.skipped) ?? 0;
  s.xfailed = num(summary.xfailed) ?? 0;
  const dur = num(summary.duration);
  if (dur !== null) s.durationMs = Math.round(dur * 1000);

  const tests = Array.isArray(o.tests) ? (o.tests as Array<Record<string, unknown>>) : [];
  for (const t of tests) {
    const outcome = String(t.outcome ?? '').toLowerCase();
    if (outcome !== 'failed' && outcome !== 'error') continue;
    const call = (t.call && typeof t.call === 'object' ? t.call : null) as Record<string, unknown> | null;
    s.failures.push({
      name: String(t.nodeid ?? 'unnamed test'),
      message: firstLine(call?.longrepr ?? (call?.crash != null ? String(call.crash) : undefined)),
    });
  }
  return finalize(s);
}

/**
 * JUnit XML (pytest `--junitxml`, vitest/jest junit reporters). Regex-parsed so
 * we add no XML dependency.
 */
export function parseJUnitXml(xml: string, runner = 'junit'): TestSummary | null {
  if (typeof xml !== 'string' || !xml.includes('<testsuite')) return null;
  const s = emptySummary(runner);

  const suiteHead = /<testsuites?\b([^>]*)>/i.exec(xml);
  const suiteTags = xml.match(/<testsuite\b[^>]*>/gi) ?? [];
  const attr = (tag: string, name: string): number | null => {
    const m = new RegExp(`${name}="(-?\\d+(?:\\.\\d+)?)"`, 'i').exec(tag);
    return m ? Number(m[1]) : null;
  };

  for (const tag of suiteTags) {
    s.total += attr(tag, 'tests') ?? 0;
    s.failed += (attr(tag, 'failures') ?? 0) + (attr(tag, 'errors') ?? 0);
    s.skipped += attr(tag, 'skipped') ?? 0;
  }
  if (suiteHead) {
    const rootTotal = attr(suiteHead[1], 'tests');
    if (rootTotal !== null && s.total === 0) s.total = rootTotal;
  }
  if (s.total === 0) s.total = s.failed + s.skipped;

  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gi;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml)) !== null) {
    const [, attrs, , body] = m;
    if (!body || !/<(failure|error)\b/i.test(body)) continue;
    const nameM = /\bname="([^"]*)"/i.exec(attrs);
    const classM = /classname="([^"]*)"/i.exec(attrs);
    const msgM = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/i.exec(body);
    s.failures.push({
      name: nameM?.[1] ?? 'unnamed test',
      ...(classM?.[1] ? { file: classM[1] } : {}),
      ...(msgM?.[1] ? { message: firstLine(msgM[1]) } : {}),
    });
  }

  // Derive passes when the suite aggregate only reported failures.
  if (s.total > 0 && s.passed === 0) s.passed = Math.max(0, s.total - s.failed - s.skipped);
  return finalize(s);
}

/**
 * Coverage from human-readable output as a fallback when no structured coverage
 * artifact exists. Handles istanbul's `All files` row, pytest-cov's `TOTAL`,
 * and the common `coverage: 68.7%` / `Lines : 68.7%` phrasings.
 */
export function parseCoverageFromText(output: string): number | null {
  if (!output) return null;

  for (const line of output.split(/\r?\n/)) {
    if (/^\s*All files\b/i.test(line)) {
      // istanbul rows are pipe-delimited and end with the Lines % (no sign).
      const pct = line.includes('|') ? lastNumericField(line) : lastPercentInLine(line);
      if (pct !== null) return pct;
    }
    if (/^\s*TOTAL\b/i.test(line)) {
      const pct = lastPercentInLine(line) ?? (line.includes('|') ? lastNumericField(line) : null);
      if (pct !== null) return pct;
    }
  }

  const labelled = /(?:Statements|Lines|Coverage)\s*[:=]\s*(\d{1,3}(?:\.\d+)?)\s*%/i.exec(output);
  if (labelled) return clampPct(Number(labelled[1]));

  const generic = /coverage[^%\d]{0,24}(\d{1,3}(?:\.\d+)?)\s*%/i.exec(output);
  if (generic) return clampPct(Number(generic[1]));

  return null;
}

/** Last `<n>%` on a coverage row. */
function lastPercentInLine(line: string): number | null {
  const matches = line.match(/(\d{1,3}(?:\.\d+)?)%/g);
  if (!matches || matches.length === 0) return null;
  return clampPct(Number(matches[matches.length - 1].replace('%', '')));
}

/** Last numeric column on a pipe-delimited row (istanbul has no `%` signs). */
function lastNumericField(line: string): number | null {
  const fields = line.split('|').map((s) => s.trim()).filter(Boolean);
  for (let i = fields.length - 1; i >= 0; i--) {
    const n = Number(fields[i]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return clampPct(n);
  }
  return null;
}

function clampPct(n: number): number | null {
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

export interface ParsedTestOutput {
  summary: TestSummary | null;
  coveragePct: number | null;
}

/**
 * Best-effort parse of captured stdout/stderr: try JSON (whole body, or the
 * last JSON object embedded in the output), then JUnit XML, then coverage text.
 */
export function parseTestOutput(output: string, runner: string): ParsedTestOutput {
  const trimmed = (output ?? '').trim();
  const coveragePct = parseCoverageFromText(trimmed);

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = tryJson(trimmed);
    if (json) {
      const summary = runner === 'pytest' ? parsePytestJson(json, runner) : parseJestLike(json, runner);
      if (summary) {
        summary.coveragePct = coveragePct;
        return { summary, coveragePct };
      }
    }
  }

  const embedded = extractLastJsonObject(trimmed);
  if (embedded) {
    const json = tryJson(embedded);
    if (json) {
      const summary = runner === 'pytest' ? parsePytestJson(json, runner) : parseJestLike(json, runner);
      if (summary) {
        summary.coveragePct = coveragePct;
        return { summary, coveragePct };
      }
    }
  }

  const junit = parseJUnitXml(trimmed, runner);
  if (junit) {
    junit.coveragePct = coveragePct;
    return { summary: junit, coveragePct };
  }

  return { summary: null, coveragePct };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Find the last balanced {...} block in noisy output (reporter JSON after logs). */
function extractLastJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let last: string | null = null;
  let begin = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) begin = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && begin !== -1) last = text.slice(begin, i + 1);
    }
  }
  return last;
}

/** Score a run: pass-rate blend with coverage-vs-gate when coverage is known. */
export function scoreTestSummary(
  summary: TestSummary | null,
  opts: { coverageGatePct?: number; exitOk: boolean } = { exitOk: false },
): number {
  const gate = opts.coverageGatePct ?? 80;
  if (!summary || summary.total === 0) return opts.exitOk ? 100 : 0;
  const executed = summary.passed + summary.failed;
  const passRate = executed > 0 ? summary.passed / executed : summary.failed === 0 ? 1 : 0;
  const passScore = passRate * 100;
  if (summary.coveragePct == null) {
    // No coverage signal: a clean run is 100, otherwise the pass-rate stands.
    return Math.max(0, Math.min(100, Math.round(passScore)));
  }
  const coverageFactor = Math.max(0, Math.min(1, summary.coveragePct / gate));
  const blended = passScore * 0.7 + coverageFactor * 100 * 0.3;
  return Math.max(0, Math.min(100, Math.round(blended)));
}
