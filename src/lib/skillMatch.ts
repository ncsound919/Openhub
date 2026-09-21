export interface Matchable {
  id: string;
  name: string;
  description?: string | null;
  kind?: string | null;
}

export interface SkillMatch extends Matchable {
  score: number;
  reason: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'you',
  'are', 'our', 'all', 'any', 'app', 'use', 'add', 'get', 'new', 'run',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Rank registry tools / agents / knowledge assets against a task description.
 * Pure keyword overlap (name x3, kind x2, description x1) — deterministic,
 * no network, safe to run automatically on project load or goal input.
 */
export function matchSkills(task: string, candidates: Matchable[], limit = 5): SkillMatch[] {
  const taskTokens = new Set(tokens(task));
  if (taskTokens.size === 0 || candidates.length === 0) return [];
  const scored: SkillMatch[] = [];
  for (const c of candidates) {
    const nameTokens = new Set(tokens(c.name));
    const kindTokens = new Set(tokens(c.kind ?? ''));
    const descTokens = new Set(tokens(c.description ?? ''));
    const hits: string[] = [];
    let score = 0;
    for (const t of taskTokens) {
      const inName = [...nameTokens].some((n) => n === t || n.startsWith(t) || t.startsWith(n));
      const inKind = [...kindTokens].some((n) => n === t || n.startsWith(t) || t.startsWith(n));
      const inDesc = [...descTokens].some((n) => n === t || n.startsWith(t) || t.startsWith(n));
      if (inName) {
        score += 3;
        hits.push(t);
      } else if (inKind) {
        score += 2;
        hits.push(t);
      } else if (inDesc) {
        score += 1;
        hits.push(t);
      }
    }
    if (score > 0) {
      const unique = [...new Set(hits)].slice(0, 4);
      scored.push({ ...c, score, reason: `matches ${unique.map((h) => `“${h}”`).join(', ')}` });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Build a task description from drift state so matching runs with zero typing. */
export function driftTaskText(input: {
  repositoryName?: string | null;
  ahead: number;
  behind: number;
  uncommitted: number;
  files: string[];
  goal?: string;
}): string {
  const parts: string[] = [];
  if (input.goal?.trim()) parts.push(input.goal.trim());
  if (input.repositoryName) parts.push(input.repositoryName);
  if (input.behind > 0) parts.push('sync pull remote behind merge');
  if (input.ahead > 0) parts.push('push commit publish');
  if (input.uncommitted > 0) parts.push('commit review diff test');
  for (const f of input.files.slice(0, 8)) {
    const name = f.split(/[\s/\\]+/).pop() ?? '';
    const lang = name.split('.').pop() ?? '';
    if (lang) parts.push(lang);
  }
  return parts.join(' ');
}
