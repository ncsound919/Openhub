// Inline-edit / completion request assembly and the retrieval trigger.
//
// Axiom runs its deterministic retrieval floor inside the editor prompt only
// when the request carries a workspace `dir`: `routes/editor.ts` maps it to
// `rootDir`, and `nextEdit.inlineEdit` / `completeInline` call
// `retrievalBlockFast` only when `rootDir` is set. So the editor consumes
// retrieval by attaching the project path — omitting it silently turns
// retrieval off. This module makes that decision explicit and testable instead
// of leaving it implicit in the provider call.

export interface RetrievalTrigger {
  /** The field to spread onto a request; present only when retrieval can run. */
  dir?: string;
  /** True when a workspace dir was attached (retrieval will be injected). */
  enabled: boolean;
  /** Human-readable state, safe to show in the editor status. */
  note: string;
}

export function retrievalTrigger(rootDir?: string): RetrievalTrigger {
  const dir = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (!dir) return { enabled: false, note: 'retrieval off — no project loaded' };
  return { dir, enabled: true, note: 'retrieval on — ranked project context attached' };
}

/**
 * Attach the retrieval-enabling `dir` to an editor request. The caller's own
 * fields are preserved; when no project is loaded `dir` is omitted entirely so
 * Axiom degrades to its non-retrieval prompt rather than erroring on an empty
 * path.
 */
export function withRetrievalDir<T extends Record<string, unknown>>(
  params: T,
  rootDir?: string,
): T & { dir?: string } {
  const trigger = retrievalTrigger(rootDir);
  return trigger.dir ? { ...params, dir: trigger.dir } : params;
}
