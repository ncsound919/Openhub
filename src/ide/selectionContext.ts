/**
 * Turn a code selection into a compact prompt fragment for the editor agent.
 *
 * Claude Code / Codex style: the agent gets the file path, the line range and
 * the literal selected text, fenced with the file's language. The user's cursor
 * lands after the fragment so they can say what they want changed.
 */

export interface SelectionContextInput {
  path: string;
  language: string;
  value: string;
  start: number;
  end: number;
  /** Cap on selected characters; the fragment says when it was truncated. */
  maxChars?: number;
}

export const DEFAULT_SELECTION_MAX_CHARS = 6000;

const FENCE_LANGUAGES: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  shell: 'sh',
  powershell: 'powershell',
  markdown: 'md',
  cpp: 'cpp',
  csharp: 'cs',
};

function fenceLanguage(language: string): string {
  const clean = language.trim().toLowerCase();
  return FENCE_LANGUAGES[clean] ?? (clean.replace(/[^a-z0-9+#-]/g, '') || '');
}

/** 1-based line number containing `offset`. */
export function lineAt(value: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, value.length));
  let line = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (value.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function buildSelectionPrompt(input: SelectionContextInput): string {
  const start = Math.max(0, Math.min(input.start, input.end));
  const end = Math.max(start, Math.min(Math.max(input.start, input.end), input.value.length));
  const raw = input.value.slice(start, end);
  if (!raw.trim()) return '';

  const maxChars = Math.max(200, input.maxChars ?? DEFAULT_SELECTION_MAX_CHARS);
  const truncated = raw.length > maxChars;
  const text = truncated ? raw.slice(0, maxChars) : raw;
  const startLine = lineAt(input.value, start);
  const endLine = lineAt(input.value, Math.max(start, end - 1));
  const lang = fenceLanguage(input.language);

  return [
    `In \`${input.path}\` (lines ${startLine}-${endLine}):`,
    '',
    `\`\`\`${lang}`,
    text,
    '```',
    ...(truncated ? ['', `(selection truncated after ${maxChars} characters)`] : []),
    '',
  ].join('\n');
}
