import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Project typecheck (D1) — runs the real TypeScript compiler against the active
 * project and returns parsed diagnostics. This is the same command the pipeline
 * readiness stage uses (`tsc --noEmit`), exposed for the workspace editor so a
 * broken import surfaces as an editor marker instead of a mystery.
 *
 * Honest degradation: a project with no tsconfig.json reports `available:false`
 * with a reason — it is never reported as "clean".
 */

export interface TsProblem {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface TypecheckResult {
  available: boolean;
  reason?: string;
  timedOut?: boolean;
  truncated?: boolean;
  errors: TsProblem[];
}

/** Parse `tsc --pretty false` output. Format: `path(line,col): error TSxxxx: msg`. */
export function parseTscOutput(out: string, cap = 500): TsProblem[] {
  const problems: TsProblem[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (!m) continue;
    problems.push({
      file: m[1].replace(/\\/g, '/'),
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5].trim(),
    });
    if (problems.length >= cap) break;
  }
  return problems;
}

/**
 * Resolve TypeScript's CLI entry from OpenHub's OWN dependency tree. Never run
 * `npx tsc` (or the project's `node_modules/.bin/tsc`) against a scanned repo:
 * that executes an untrusted project's binary — the exact "review this repo →
 * run this repo" hazard the scanner already documents in processRunner.ts.
 */
let tscCliPath: string | null | undefined;
function resolveLocalTsc(): string | null {
  if (tscCliPath !== undefined) return tscCliPath;
  try {
    tscCliPath = require.resolve('typescript/bin/tsc');
  } catch {
    tscCliPath = null;
  }
  return tscCliPath;
}

// Single-flight per project: repeated Ctrl+S must not stack concurrent
// compilers on the same working tree.
const inFlight = new Map<string, Promise<TypecheckResult>>();

export function runTypecheck(projectPath: string, timeoutMs = 60_000): Promise<TypecheckResult> {
  if (!fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
    return Promise.resolve({ available: false, reason: 'No tsconfig.json in this project', errors: [] });
  }
  const existing = inFlight.get(projectPath);
  if (existing) return existing;
  const tsc = resolveLocalTsc();
  if (!tsc) {
    return Promise.resolve({ available: false, reason: 'TypeScript compiler not installed in OpenHub', errors: [] });
  }
  const run = new Promise<TypecheckResult>((resolve) => {
    // argv array (no shell), cwd is the loaded project; the compiler itself is
    // always OpenHub's. tsc exits non-zero on errors, so stdout carries them.
    execFile(
      process.execPath,
      [tsc, '--noEmit', '--pretty', 'false'],
      { cwd: projectPath, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (Error & { killed?: boolean }) | null;
        if (e?.killed) return resolve({ available: true, timedOut: true, errors: [] });
        const errors = parseTscOutput(`${stdout || ''}${stderr || ''}`);
        resolve({ available: true, errors, truncated: errors.length >= 500 });
      },
    );
  }).finally(() => { inFlight.delete(projectPath); });
  inFlight.set(projectPath, run);
  return run;
}
