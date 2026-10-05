// Pure helpers for the proactive fix loop (Monaco Code Actions -> Axiom).
//
// Kept free of Monaco and fetch so the two decisions that matter — "what
// instruction does this diagnostic imply" and "which region should the fix
// rewrite" — are unit-testable, while `monacoProviders` wires them to the
// editor and the existing inline-edit lane.

export interface DiagnosticLike {
  /** 1-based start line. */
  line: number;
  /** 1-based start column. */
  column: number;
  /** 1-based end line (defaults to `line` when absent). */
  endLine?: number;
  /** 1-based end column. */
  endColumn?: number;
  /** Compiler/server code, e.g. `TS2345`. */
  code?: string;
  message: string;
}

export interface FixRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(v) ? Math.floor(v) : min));

/** The inline-edit instruction that asks Axiom to correct one diagnostic. */
export function fixInstructionFor(d: DiagnosticLike): string {
  const code = d.code ? ` ${d.code}` : '';
  return `Fix the compiler error${code}: ${d.message}. Return only the corrected code for the selected region — no explanation, no markdown fences.`;
}

/** The instruction for "explain this problem" (used by the explain action). */
export function explainInstructionFor(d: DiagnosticLike): string {
  const code = d.code ? ` (${d.code})` : '';
  return `In one or two sentences, explain why${code} "${d.message}" happens and the minimal fix.`;
}

/**
 * The selection to hand to the inline-edit lane. Widened to whole lines so a
 * fix can rewrite the offending statement (and clamped to the document), rather
 * than the sub-token span a compiler often reports.
 */
export function fixRangeFor(d: DiagnosticLike, lineCount: number): FixRange {
  const lines = Math.max(1, lineCount);
  const startLineNumber = clamp(d.line, 1, lines);
  const endLineNumber = clamp(Math.max(d.endLine ?? d.line, startLineNumber), startLineNumber, lines);
  // Column 1 -> a column past any line's end so the range covers full lines.
  return { startLineNumber, startColumn: 1, endLineNumber, endColumn: 1_000_000 };
}

/** Stable identity for a diagnostic, for dedupe / telemetry. */
export function diagnosticKey(d: DiagnosticLike): string {
  return `${d.code ?? ''}:${d.line}:${d.column}:${d.message}`;
}

/** Errors only, in the order a top-down fix pass would touch them. */
export function fixableDiagnostics<T extends DiagnosticLike>(all: T[]): T[] {
  return all.filter((d) => typeof d.message === 'string' && d.message.trim().length > 0);
}
