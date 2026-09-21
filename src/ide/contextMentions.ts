/**
 * Client-side mention detection and prompt assembly for the editor's context
 * attach. Detection is for display + deciding whether to call the resolver; the
 * server's `resolveMentions` is authoritative about what actually resolves.
 *
 * Supported forms (mirroring src/server/mentions.ts):
 *   @file:src/a.ts  @folder:src  @code:buildTaskContext  @docs:retrieval
 *   @git  @git:<ref>  and a bare @path/with/slash
 */

export type MentionKind = 'file' | 'folder' | 'code' | 'docs' | 'git' | 'path';

export interface MentionToken {
  raw: string;
  kind: MentionKind;
  value: string;
}

const TOKEN_RE = /@(file|folder|code|docs):([^\s]+)|@git(?::([^\s]+))?|@([A-Za-z0-9_][A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]*)/g;

export function mentionTokens(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push({ raw: m[0], kind: m[1] as MentionKind, value: m[2] });
    else if (m[0].startsWith('@git')) out.push({ raw: m[0], kind: 'git', value: m[3] ?? '' });
    else out.push({ raw: m[0], kind: 'path', value: m[4] });
  }
  return out;
}

export function hasMentions(text: string): boolean {
  return mentionTokens(text).length > 0;
}

/** Append a resolved context block to a prompt, or return the prompt unchanged. */
export function withContextBlock(text: string, block: string): string {
  const t = text.trim();
  const b = block.trim();
  return b ? `${t}\n\n${b}` : t;
}
