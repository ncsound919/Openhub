// Pure mapping from LSP diagnostics to Monaco marker inputs.
//
// LSP positions are 0-based (line, character); Monaco marker positions are
// 1-based. Severity enums differ too, so the caller supplies the Monaco
// MarkerSeverity values — keeping this module free of any Monaco import and
// therefore unit-testable without a DOM or the editor.

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** 1=Error, 2=Warning, 3=Information, 4=Hint (LSP DiagnosticSeverity). */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface MarkerSeverityMap {
  error: number;
  warning: number;
  info: number;
  hint: number;
}

export interface MonacoMarkerInput {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  code?: string;
  source?: string;
}

const EXT_SUPPORTED = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

/** True when Axiom's LSP client has a configured server for this file's language. */
export function lspLanguageSupported(pathOrExt: string): boolean {
  if (/^\.[a-z0-9]+$/i.test(pathOrExt)) return EXT_SUPPORTED.test(`x${pathOrExt}`);
  return EXT_SUPPORTED.test(pathOrExt);
}

function severityFor(severity: number | undefined, sev: MarkerSeverityMap): number {
  switch (severity) {
    case 1: return sev.error;
    case 2: return sev.warning;
    case 3: return sev.info;
    case 4: return sev.hint;
    default: return sev.warning;
  }
}

const oneBased = (n: number): number => (Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1);

/** Convert LSP diagnostics to Monaco marker inputs. Never throws on malformed
 *  input: a bad range collapses to the start position rather than dropping the
 *  diagnostic or crashing the editor. */
export function toMonacoMarkers(diags: LspDiagnostic[], sev: MarkerSeverityMap): MonacoMarkerInput[] {
  if (!Array.isArray(diags)) return [];
  return diags.map((d) => {
    const startLineNumber = oneBased(d.range?.start?.line ?? 0);
    const startColumn = oneBased(d.range?.start?.character ?? 0);
    const endLineNumber = oneBased(d.range?.end?.line ?? d.range?.start?.line ?? 0);
    const endColumn = oneBased(d.range?.end?.character ?? d.range?.start?.character ?? 0);
    // Guarantee a well-formed range (Monaco rejects end before start).
    const valid = endLineNumber > startLineNumber || (endLineNumber === startLineNumber && endColumn >= startColumn);
    return {
      startLineNumber,
      startColumn,
      endLineNumber: valid ? endLineNumber : startLineNumber,
      endColumn: valid ? endColumn : startColumn,
      severity: severityFor(d.severity, sev),
      message: typeof d.message === 'string' ? d.message : String(d.message ?? ''),
      ...(d.code !== undefined ? { code: String(d.code) } : {}),
      ...(d.source ? { source: d.source } : {}),
    };
  });
}
