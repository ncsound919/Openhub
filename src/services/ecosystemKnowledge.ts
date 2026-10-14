import fs from 'fs';
import path from 'path';
import { getDb } from '../auth/db.js';

/**
 * Ecosystem knowledge index — the operator's `Ecosystem` folder as a
 * searchable catalog shared by OpenHub (SQLite-persisted here) and Axiom
 * (in-memory twin in src/server/ecosystemKnowledge.ts).
 *
 * Sources scanned (all real files on disk):
 *   agents/<name>.md                 -> kind 'agent'     (YAML frontmatter)
 *   skills/<name>/SKILL.md           -> kind 'skill'
 *   ecc-skills/<name>/SKILL.md       -> kind 'skill'
 *   get-shit-done/workflows/<name>   -> kind 'workflow'  (markdown files)
 *   get-shit-done/references/<name>  -> kind 'reference' (markdown files)
 *   get-shit-done/templates/<name>   -> kind 'template'  (directories)
 *   rules/<name>.md                  -> kind 'rule'      (excluding nested dirs)
 *   commands/gsd/<name>.md           -> kind 'command'
 *
 * Honest degradation: no configured root -> live=false + explicit error, never
 * invented data. The index is a projection of the folder; a refresh rebuilds it.
 */

export type KnowledgeKind =
  | 'agent' | 'skill' | 'workflow' | 'reference' | 'template' | 'rule' | 'command';

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  key: string;
  name: string;
  description: string;
  path: string; // relative to the ecosystem root
}

export interface KnowledgeSnapshot {
  live: boolean;
  root: string | null;
  entries: KnowledgeEntry[];
  totals: Record<string, number>;
  refreshedAt: string;
  error?: string;
}

const MAX_DESCRIPTION_CHARS = 400;

export function ecosystemRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENHUB_ECOSYSTEM_ROOT || null;
}

/**
 * All configured ecosystem roots. OPENHUB_ECOSYSTEM_ROOTS is `;`-delimited
 * (`:` is illegal — Windows paths contain it). Falls back to the single
 * OPENHUB_ECOSYSTEM_ROOT for backward compatibility.
 */
export function ecosystemRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const plural = env.OPENHUB_ECOSYSTEM_ROOTS;
  if (typeof plural === 'string' && plural.trim() !== '') {
    return plural.split(';').map((s) => s.trim()).filter(Boolean);
  }
  const single = ecosystemRoot(env);
  return single ? [single] : [];
}

/** Short source label for namespacing (directory basename). */
export function rootLabel(root: string): string {
  return root.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || root;
}

/** Parse `---` YAML frontmatter for name/description. Best-effort. */
export function readFrontmatter(raw: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    const cleaned = value.trim().replace(/^["']|["']$/g, '');
    if (key === 'name' && cleaned) out.name = cleaned;
    if (key === 'description' && cleaned) out.description = cleaned;
    if (out.name && out.description) break;
  }
  return out;
}

/** First non-frontmatter, non-empty line-pair (heading + sentence) as a fallback. */
function firstParagraph(raw: string): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => l.startsWith('#'));
  const text = lines.find((l) => !l.startsWith('#'));
  return [heading ? heading.replace(/^#+\s*/, '') : '', text ?? ''].filter(Boolean).join(' — ').slice(0, MAX_DESCRIPTION_CHARS);
}

function cleanKey(raw: string): string {
  return raw.replace(/\.md$/i, '').replace(/\.markdown$/i, '');
}

/** Scan one markdown file into an entry (frontmatter preferred). */
function scanMarkdown(root: string, abs: string, rel: string, kind: KnowledgeKind, key: string): KnowledgeEntry {
  let raw = '';
  try { raw = fs.readFileSync(abs, 'utf8').slice(0, 60_000); } catch { /* unreadable → degrade below */ }
  const fm = readFrontmatter(raw);
  const name = fm.name || cleanKey(key).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const description = (fm.description || firstParagraph(raw)).slice(0, MAX_DESCRIPTION_CHARS);
  return { kind, key: cleanKey(key), name, description, path: rel.split(path.sep).join('/') };
}

/** Scan the whole ecosystem folder into entries. Never throws. */
export function scanEcosystem(root: string | null): KnowledgeEntry[] {
  if (!root || !fs.existsSync(root)) return [];

  const entries: KnowledgeEntry[] = [];
  const push = (e: KnowledgeEntry | null) => { if (e) entries.push(e); };

  // agents/*.md — YAML frontmatter agents.
  try {
    for (const f of fs.readdirSync(path.join(root, 'agents'))) {
      if (!/\.md$/i.test(f)) continue;
      const abs = path.join(root, 'agents', f);
      push(scanMarkdown(root, abs, path.join('agents', f), 'agent', cleanKey(f)));
    }
  } catch { /* absent */ }

  // skills/*/SKILL.md and ecc-skills/*/SKILL.md
  for (const dir of ['skills', 'ecc-skills']) {
    try {
      for (const sub of fs.readdirSync(path.join(root, dir))) {
        const skillMd = path.join(root, dir, sub, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const rel = path.join(dir, sub, 'SKILL.md');
        push(scanMarkdown(root, skillMd, rel, 'skill', sub));
      }
    } catch { /* absent */ }
  }

  // get-shit-done/workflows/* and references/*
  for (const [sub, kind] of [['workflows', 'workflow'], ['references', 'reference']] as const) {
    const dir = path.join(root, 'get-shit-done', sub);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.md$/i.test(f)) continue;
        const abs = path.join(dir, f);
        push(scanMarkdown(root, abs, path.join('get-shit-done', sub, f), kind, cleanKey(f)));
      }
    } catch { /* absent */ }
  }

  // get-shit-done/templates/* — directories
  try {
    for (const sub of fs.readdirSync(path.join(root, 'get-shit-done', 'templates'))) {
      const abs = path.join(root, 'get-shit-done', 'templates', sub);
      if (!fs.statSync(abs).isDirectory()) continue;
      // Describe via the first README/markdown inside the template, if any.
      let description = '';
      try {
        const inner = fs.readdirSync(abs).find((f) => /\.md$/i.test(f));
        if (inner) {
          const raw = fs.readFileSync(path.join(abs, inner), 'utf8').slice(0, 20_000);
          description = (readFrontmatter(raw).description || firstParagraph(raw)).slice(0, MAX_DESCRIPTION_CHARS);
        }
      } catch { /* keep empty */ }
      entries.push({
        kind: 'template',
        key: sub,
        name: sub.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description,
        path: `get-shit-done/templates/${sub}`,
      });
    }
  } catch { /* absent */ }

  // rules/*.md (top level only — the overlay365 subdir is the layer docs)
  try {
    for (const f of fs.readdirSync(path.join(root, 'rules'))) {
      if (!/\.md$/i.test(f)) continue;
      const abs = path.join(root, 'rules', f);
      push(scanMarkdown(root, abs, path.join('rules', f), 'rule', cleanKey(f)));
    }
  } catch { /* absent */ }

  // commands/gsd/*.md — CLI reference docs (BRIEF.md style)
  try {
    for (const f of fs.readdirSync(path.join(root, 'commands', 'gsd'))) {
      if (!/\.md$/i.test(f)) continue;
      const abs = path.join(root, 'commands', 'gsd', f);
      push(scanMarkdown(root, abs, path.join('commands', 'gsd', f), 'command', cleanKey(f)));
    }
  } catch { /* absent */ }

  return entries;
}

export function totalsOf(entries: KnowledgeEntry[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of entries) totals[e.kind] = (totals[e.kind] ?? 0) + 1;
  return totals;
}

// ---------------------------------------------------------------------------
// Generic per-root scan: SKILL.md / AGENTS.md / docs anywhere, not just the
// canonical layout. Keys and paths are namespaced `${label}/…` so multiple
// roots never collide in the shared index table.
// ---------------------------------------------------------------------------

/** Directories never descended into (secrets, caches, vendored code). */
const GENERIC_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor',
  'Keywire', '__pycache__', '.pytest_cache', '.ruff_cache', 'target',
  '.venv', 'venv', '.qdrant_data', '.aether_prime_cache', '.aether_prime_memory',
]);

const MAX_GENERIC_SKILLS = 150;
const MAX_GENERIC_AGENTS = 80;
const MAX_GENERIC_REFS = 60;
const MAX_GENERIC_DEPTH = 6;

/** Canonical skill dirs whose SKILL.md files the layout scan already covers. */
function underCanonicalSkills(root: string, abs: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return /^(skills|ecc-skills)\//.test(rel);
}

function walkMarkdown(root: string, maxDepth: number, visit: (abs: string, rel: string, depth: number) => void): void {
  const stack: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];
  while (stack.length) {
    const { abs, depth } = stack.pop() as { abs: string; depth: number };
    let dirents: { name: string; isDirectory: () => boolean }[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.') || GENERIC_SKIP.has(d.name)) continue;
      if (depth + 1 > maxDepth) continue;
      const child = path.join(abs, d.name);
      const rel = path.relative(root, child);
      visit(child, rel, depth + 1);
      stack.push({ abs: child, depth: depth + 1 });
    }
  }
}

/** Broad scan of one root: scattered skills, agent files, and doc folders. */
export function scanGeneric(root: string | null, label?: string): KnowledgeEntry[] {
  if (!root || !fs.existsSync(root)) return [];
  const source = label ?? rootLabel(root);
  const entries: KnowledgeEntry[] = [];
  const seen = new Set<string>();

  const push = (e: KnowledgeEntry) => {
    const id = `${e.kind}:${e.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push(e);
  };

  // 1. Any SKILL.md not already covered by the canonical skills/ dirs.
  let skills = 0;
  const collectSkillDirs: { abs: string; rel: string }[] = [];
  walkMarkdown(root, MAX_GENERIC_DEPTH, (abs, rel) => collectSkillDirs.push({ abs, rel }));
  const candidates: { abs: string; rel: string }[] = [{ abs: root, rel: '' }, ...collectSkillDirs];
  for (const { abs, rel } of candidates) {
    if (skills >= MAX_GENERIC_SKILLS) break;
    let dirents: string[] = [];
    try {
      dirents = fs.readdirSync(abs);
    } catch {
      continue;
    }
    if (!dirents.includes('SKILL.md')) continue;
    const skillAbs = path.join(abs, 'SKILL.md');
    if (underCanonicalSkills(root, skillAbs)) continue;
    const sub = rel === '' ? 'root' : rel.split(path.sep).join('/');
    let raw = '';
    try { raw = fs.readFileSync(skillAbs, 'utf8').slice(0, 60_000); } catch { continue; }
    const fm = readFrontmatter(raw);
    const base = sub.split('/').pop() || sub;
    const pretty = base.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    push({
      kind: 'skill',
      key: `${source}/${sub}`,
      name: fm.name || pretty,
      description: (fm.description || firstParagraph(raw)).slice(0, MAX_DESCRIPTION_CHARS),
      path: `${source}/${sub}/SKILL.md`,
    });
    skills++;
  }

  // 2. AGENTS.md / AGENT.md files as agent entries.
  let agents = 0;
  for (const { abs, rel } of candidates) {
    if (agents >= MAX_GENERIC_AGENTS) break;
    for (const fname of ['AGENTS.md', 'AGENT.md']) {
      const absFile = path.join(abs, fname);
      let raw = '';
      try {
        if (!fs.statSync(absFile).isFile()) continue;
        raw = fs.readFileSync(absFile, 'utf8').slice(0, 60_000);
      } catch {
        continue;
      }
      const where = rel === '' ? 'root' : rel.split(path.sep).join('/');
      push({
        kind: 'agent',
        key: `${source}/${where}/${fname}`,
        name: `${where === 'root' ? source : where.split('/').pop() || where} agents`,
        description: firstParagraph(raw),
        path: `${source}/${where === 'root' ? fname : `${where}/${fname}`}`,
      });
      agents++;
      break;
    }
  }

  // 3. docs/, plans/, knowledge_bank/ markdown as references (top 2 levels).
  for (const folder of ['docs', 'plans', 'knowledge_bank']) {
    let refs = 0;
    const base = path.join(root, folder);
    if (!fs.existsSync(base)) continue;
    const pools: string[] = [base];
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.') && !GENERIC_SKIP.has(d.name)) {
          pools.push(path.join(base, d.name));
        }
      }
    } catch { /* base only */ }
    for (const pool of pools) {
      if (refs >= MAX_GENERIC_REFS) break;
      let files: string[] = [];
      try {
        files = fs.readdirSync(pool).filter((f) => /\.md$/i.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        if (refs >= MAX_GENERIC_REFS) break;
        const abs = path.join(pool, f);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        push(scanMarkdown(root, abs, `${source}/${rel}`, 'reference', `${source}/${cleanKey(rel)}`));
        refs++;
      }
    }
  }

  // 4. Root-level README / overview markdown as references.
  try {
    const top = fs.readdirSync(root).filter((f) => /\.md$/i.test(f)).slice(0, 10);
    for (const f of top) {
      const abs = path.join(root, f);
      try {
        if (!fs.statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      push(scanMarkdown(root, abs, `${source}/${f}`, 'reference', `${source}/${cleanKey(f)}`));
    }
  } catch { /* absent */ }

  // 5. Agent manifests (agent.json / metadata.json) as agent entries, so
  //    directory-based agents are discoverable by research and skill matching.
  let manifests = 0;
  for (const { abs, rel } of candidates) {
    if (manifests >= MAX_GENERIC_AGENTS) break;
    const relPrefix = rel === '' ? '' : `${rel.split(path.sep).join('/')}/`;
    const tryManifest = (filename: string): boolean => {
      const p = path.join(abs, filename);
      let parsed: Record<string, unknown> | null = null;
      try {
        if (!fs.statSync(p).isFile()) return false;
        parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        return false;
      }
      if (!parsed) return false;
      const name = typeof parsed.name === 'string' ? parsed.name : typeof parsed.id === 'string' ? parsed.id : '';
      const desc = [parsed.description, parsed.tagline, parsed.bio].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      // metadata.json is used broadly; only index it when it looks like an
      // agent manifest (name + description/capabilities), never a stray file.
      if (filename === 'metadata.json' && (!name || (!desc && !Array.isArray(parsed.majorCapabilities)))) return false;
      const pretty = (name || (rel === '' ? source : rel.split('/').pop() || source)).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      push({
        kind: 'agent',
        key: `${source}/${relPrefix}${filename.replace(/\.json$/i, '')}`,
        name: name || pretty,
        description: (desc ?? '').slice(0, MAX_DESCRIPTION_CHARS),
        path: `${source}/${relPrefix}${filename}`,
      });
      manifests++;
      return true;
    };
    if (tryManifest('agent.json')) continue;
    tryManifest('metadata.json');
  }

  return entries;
}

/** Scan every root: canonical layout scan + generic scan per root. */
export function scanEcosystems(roots: string[]): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = [];
  const seen = new Set<string>();
  const multi = roots.filter((r) => r && fs.existsSync(r)).length > 1;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const label = rootLabel(root);
    // In multi-root mode canonical entries are namespaced too, so every
    // path identifies its source and keys can never collide across roots.
    const canonical = multi
      ? scanEcosystem(root).map((e) => ({ ...e, key: `${label}/${e.key}`, path: `${label}/${e.path}` }))
      : scanEcosystem(root);
    for (const e of [...canonical, ...scanGeneric(root)]) {
      const id = `${e.kind}:${e.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQLite persistence + query
// ---------------------------------------------------------------------------

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ecosystem_knowledge (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      source_root TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    );
  `);
}

/** Full rebuild of the index table from the folder (idempotent). */
export function refreshKnowledgeIndex(root: string | null): KnowledgeSnapshot {
  const entries = scanEcosystem(root);
  if (root) {
    persistEntries(entries, root);
  }
  return { live: true, root, entries, totals: totalsOf(entries), refreshedAt: new Date().toISOString() };
}

function persistEntries(entries: KnowledgeEntry[], labelRoot: string): void {
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM ecosystem_knowledge');
  const ins = db.prepare(
    'INSERT OR REPLACE INTO ecosystem_knowledge (kind, key, name, description, path, source_root, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    del.run();
    for (const e of entries) ins.run(e.kind, e.key, e.name, e.description, e.path, labelRoot, now);
  })();
}

/** Full rebuild across every configured root (canonical + generic scans). */
export function refreshKnowledgeIndexes(roots: string[] = ecosystemRoots()): KnowledgeSnapshot {
  const entries = scanEcosystems(roots);
  if (roots.length > 0) {
    ensureTable();
    const db = getDb();
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT OR REPLACE INTO ecosystem_knowledge (kind, key, name, description, path, source_root, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    // Attribute each entry to the root its path is namespaced under.
    const sourceOf = (e: KnowledgeEntry): string => {
      const hit = roots.find((r) => e.path === rootLabel(r) || e.path.startsWith(`${rootLabel(r)}/`));
      return hit ?? roots[0];
    };
    db.transaction(() => {
      db.prepare('DELETE FROM ecosystem_knowledge').run();
      for (const e of entries) ins.run(e.kind, e.key, e.name, e.description, e.path, sourceOf(e), now);
    })();
  }
  return {
    live: true,
    root: roots[0] ?? null,
    entries,
    totals: totalsOf(entries),
    refreshedAt: new Date().toISOString(),
  };
}

/** Populate the index from all roots when it is empty (first call). */
export function ensureKnowledgeIndexed(roots: string[] = ecosystemRoots()): void {
  try {
    ensureTable();
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM ecosystem_knowledge').get() as { n: number };
    if (row.n === 0 && roots.length > 0) refreshKnowledgeIndexes(roots);
  } catch { /* read paths degrade via searchKnowledge */ }
}

export interface KnowledgeSource {
  root: string;
  label: string;
  entries: number;
}

/** Per-root entry counts for the awareness UI. */
export function sourceCounts(): KnowledgeSource[] {
  try {
    ensureTable();
    const rows = getDb()
      .prepare('SELECT source_root AS root, COUNT(*) AS n FROM ecosystem_knowledge GROUP BY source_root')
      .all() as { root: string; n: number }[];
    return rows.map((r) => ({ root: r.root, label: rootLabel(r.root), entries: r.n }));
  } catch {
    return [];
  }
}

export interface KnowledgeQuery {
  kind?: string;
  search?: string;
  limit?: number;
}

/** Search the persisted index. Falls back to a fresh scan when the index is
 *  empty but the folder exists (first call). */
export function searchKnowledge(query: KnowledgeQuery = {}, root: string | null = ecosystemRoot()): KnowledgeSnapshot {
  ensureTable();
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM ecosystem_knowledge').get() as { n: number };

  if (row.n === 0 && root) {
    refreshKnowledgeIndex(root);
  }

  const kind = query.kind?.trim() || '';
  const search = query.search?.trim() || '';
  const limit = Math.min(300, Math.max(1, query.limit ?? 200));
  const like = `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`;

  let sql = 'SELECT kind, key, name, description, path FROM ecosystem_knowledge';
  const binds: unknown[] = [];
  const where: string[] = [];
  if (kind) { where.push('kind = ?'); binds.push(kind); }
  if (search) {
    where.push("(LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) OR LOWER(key) LIKE LOWER(?))");
    binds.push(like, like, like);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY kind, key LIMIT ?';
  binds.push(limit);

  const rows = db.prepare(sql).all(...binds) as unknown as KnowledgeEntry[];
  const all = db.prepare('SELECT kind, key, name, description, path FROM ecosystem_knowledge').all() as unknown as KnowledgeEntry[];

  return {
    live: row.n > 0,
    root,
    entries: rows,
    totals: totalsOf(all),
    refreshedAt: new Date().toISOString(),
    ...(row.n === 0 && !root ? { error: 'ecosystem root not configured (OPENHUB_ECOSYSTEM_ROOT)' } : {}),
  };
}