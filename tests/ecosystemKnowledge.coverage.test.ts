import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../src/auth/db.js';
import {
  ecosystemRoot,
  ecosystemRoots,
  rootLabel,
  readFrontmatter,
  scanEcosystem,
  scanGeneric,
  scanEcosystems,
  totalsOf,
  refreshKnowledgeIndex,
  refreshKnowledgeIndexes,
  ensureKnowledgeIndexed,
  sourceCounts,
  searchKnowledge,
} from '../src/services/ecosystemKnowledge.js';

let base: string;
let ecoRoot: string;
let otherBase: string;
let ecoRoot2: string;
let dbFile: string;

function write(rel: string, content: string): void {
  const abs = path.join(ecoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function mkdir(rel: string): void {
  fs.mkdirSync(path.join(ecoRoot, rel), { recursive: true });
}

function clearIndex(): void {
  try {
    getDb().prepare('DELETE FROM ecosystem_knowledge').run();
  } catch {
    /* table may not exist yet */
  }
}

function countRows(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM ecosystem_knowledge').get() as { n: number }).n;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-eco-'));
  ecoRoot = path.join(base, 'Eco');
  fs.mkdirSync(ecoRoot, { recursive: true });

  // Canonical layout
  write('agents/foo-agent.md', '---\nname: Foo Agent\ndescription: A helpful foo agent\nmode: subagent\n---\n\n# Foo\nBody');
  write('agents/bar.md', '# Bar Agent\nBar description line\n');
  write('agents/notes.txt', 'ignore me');
  mkdir('agents/weird.md');

  write('skills/alpha/SKILL.md', '---\nname: Alpha\ndescription: Alpha skill\n---\n# Alpha\n');
  write('skills/alpha/extra.md', 'ignored canonical sibling');
  write('skills/beta/SKILL.md', '# Beta Skill\nBeta does things\n');
  write('ecc-skills/gamma/SKILL.md', '---\ndescription: Gamma skill\n---\n');

  write('get-shit-done/workflows/w1.md', '# Workflow One\ntext\n');
  write('get-shit-done/references/r1.md', '# Reference One\ntext\n');
  write('get-shit-done/templates/tpl/README.md', '---\ndescription: Template readme\n---\n# T\n');
  mkdir('get-shit-done/templates/plain-tpl');
  write('get-shit-done/templates/file.txt', 'not a dir');

  write('rules/rule-a.md', '# Rule A\ntext\n');
  write('commands/gsd/cmd-a.md', '# Command A\ntext\n');

  // Generic layout
  write('SKILL.md', '---\nname: Root Skill\ndescription: root level\n---\n');
  write('genericDir/nested/SKILL.md', '---\nname: Nested Skill\ndescription: nested\n---\n');
  write('subagents/AGENTS.md', '# Sub agents\nAgents live here\n');
  write('subagents2/AGENT.md', '# Single agent\n');
  write('manifest/agent.json', JSON.stringify({ name: 'Manifest Agent', description: 'from json' }));
  write('meta1/metadata.json', JSON.stringify({ name: 'Meta Agent', description: 'meta desc' }));
  write('meta2/metadata.json', JSON.stringify({ name: 'Cap Agent', majorCapabilities: ['x'] }));
  write('meta3/metadata.json', JSON.stringify({ description: 'no name' }));
  write('meta4/metadata.json', '{ not valid json');
  write('meta5/agent.json', '\uFEFF' + JSON.stringify({ name: 'Bom Agent', description: 'bom' }));
  write('meta6/agent.json', '{ broken');
  write('docs/guide.md', '# Guide\ntext\n');
  write('docs/nested/deep.md', '# Deep\ntext\n');
  write('docs/.hidden/secret.md', '# Secret\n');
  write('plans/plan.md', '# Plan\ntext\n');
  write('knowledge_bank/kb.md', '# KB\ntext\n');
  write('README.md', '# Eco Root\nOverview text\n');
  write('node_modules/pkg/SKILL.md', 'should be skipped');
  write('.hidden/SKILL.md', 'should be skipped');
  write('deep/d1/d2/d3/d4/d5/d6/d7/SKILL.md', 'too deep');

  // Second root with the same basename (multi-root namespacing / dedupe)
  otherBase = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-eco2-'));
  ecoRoot2 = path.join(otherBase, 'Eco');
  fs.mkdirSync(path.join(ecoRoot2, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(ecoRoot2, 'agents', 'foo-agent.md'),
    '---\nname: Foo Agent\ndescription: duplicate key\n---\n',
    'utf8',
  );

  dbFile = path.join(base, 'test.db');
  vi.stubEnv('OPENHUB_DB_PATH', dbFile);
  ensureKnowledgeIndexed([]); // creates the table
});

afterAll(() => {
  closeDb();
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(otherBase, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  clearIndex();
});

describe('ecosystemKnowledge coverage — env + labels', () => {
  it('reads single and plural roots from an injected env', () => {
    expect(ecosystemRoot({ OPENHUB_ECOSYSTEM_ROOT: '/x' } as any)).toBe('/x');
    expect(ecosystemRoot({} as any)).toBeNull();
    expect(ecosystemRoots({ OPENHUB_ECOSYSTEM_ROOTS: ' /a ; /b ;; ' } as any)).toEqual(['/a', '/b']);
    expect(ecosystemRoots({ OPENHUB_ECOSYSTEM_ROOT: '/s' } as any)).toEqual(['/s']);
    expect(ecosystemRoots({ OPENHUB_ECOSYSTEM_ROOTS: '   ' } as any)).toEqual([]);
    expect(ecosystemRoots({} as any)).toEqual([]);
  });

  it('derives a short label from a path', () => {
    expect(rootLabel('/a/b/')).toBe('b');
    expect(rootLabel('C:\\x\\y\\')).toBe('y');
    expect(rootLabel('/')).toBe('/');
  });
});

describe('ecosystemKnowledge coverage — readFrontmatter', () => {
  it('parses, strips quotes and stops once both fields are found', () => {
    const fm = readFrontmatter('---\nname: "Alpha"\ndescription: \'A skill\'\nmode: subagent\n---\nbody');
    expect(fm).toEqual({ name: 'Alpha', description: 'A skill' });
  });

  it('omits empty values and ignores malformed lines', () => {
    const fm = readFrontmatter('---\nnot a kv line\nname:\ndescription: real\n---\n');
    expect(fm).toEqual({ description: 'real' });
  });

  it('returns empty without frontmatter', () => {
    expect(readFrontmatter('# heading\ntext')).toEqual({});
  });
});

describe('ecosystemKnowledge coverage — scanEcosystem', () => {
  it('returns empty for null, missing and unreadable roots', () => {
    expect(scanEcosystem(null)).toEqual([]);
    expect(scanEcosystem(path.join(base, 'does-not-exist'))).toEqual([]);
  });

  it('indexes the full canonical layout with names and descriptions', () => {
    const entries = scanEcosystem(ecoRoot);
    const totals = totalsOf(entries);

    expect(totals.agent).toBe(3);
    expect(totals.skill).toBe(3);
    expect(totals.workflow).toBe(1);
    expect(totals.reference).toBe(1);
    expect(totals.template).toBe(2);
    expect(totals.rule).toBe(1);
    expect(totals.command).toBe(1);

    const foo = entries.find((e) => e.kind === 'agent' && e.key === 'foo-agent')!;
    expect(foo.name).toBe('Foo Agent');
    expect(foo.description).toBe('A helpful foo agent');
    expect(foo.path).toBe('agents/foo-agent.md');

    const bar = entries.find((e) => e.kind === 'agent' && e.key === 'bar')!;
    expect(bar.description).toContain('Bar description');

    const weird = entries.find((e) => e.kind === 'agent' && e.key === 'weird')!;
    expect(weird.description).toBe('');

    const tpl = entries.find((e) => e.kind === 'template' && e.key === 'tpl')!;
    expect(tpl.description).toBe('Template readme');
    expect(entries.find((e) => e.kind === 'template' && e.key === 'plain-tpl')!.description).toBe('');
    expect(entries.some((e) => e.kind === 'agent' && e.key === 'notes')).toBe(false);
  });
});

describe('ecosystemKnowledge coverage — scanGeneric', () => {
  it('returns empty for null and missing roots', () => {
    expect(scanGeneric(null)).toEqual([]);
    expect(scanGeneric(path.join(base, 'nope'))).toEqual([]);
  });

  it('collects skills, agents, manifests and references with a custom label', () => {
    const entries = scanGeneric(ecoRoot, 'Custom');
    const kinds = (k: string) => entries.filter((e) => e.kind === k);

    const rootSkill = entries.find((e) => e.kind === 'skill' && e.key === 'Custom/root')!;
    expect(rootSkill.name).toBe('Root Skill');
    const nestedSkill = entries.find((e) => e.kind === 'skill' && e.key === 'Custom/genericDir/nested')!;
    expect(nestedSkill.path).toBe('Custom/genericDir/nested/SKILL.md');

    // canonical skills are not re-indexed as generic skills
    expect(entries.some((e) => e.key.includes('skills/alpha'))).toBe(false);

    expect(kinds('agent').some((e) => e.key === 'Custom/subagents/AGENTS.md')).toBe(true);
    expect(kinds('agent').some((e) => e.key === 'Custom/subagents2/AGENT.md')).toBe(true);
    expect(kinds('agent').some((e) => e.name === 'Manifest Agent')).toBe(true);
    expect(kinds('agent').some((e) => e.name === 'Meta Agent')).toBe(true);
    expect(kinds('agent').some((e) => e.name === 'Cap Agent')).toBe(true);
    expect(kinds('agent').some((e) => e.name === 'Bom Agent')).toBe(true);
    expect(kinds('agent').some((e) => e.name === 'No name')).toBe(false);

    const refs = kinds('reference');
    expect(refs.some((e) => e.path === 'Custom/docs/guide.md')).toBe(true);
    expect(refs.some((e) => e.path === 'Custom/docs/nested/deep.md')).toBe(true);
    expect(refs.some((e) => e.path === 'Custom/plans/plan.md')).toBe(true);
    expect(refs.some((e) => e.path === 'Custom/knowledge_bank/kb.md')).toBe(true);
    expect(refs.some((e) => e.path === 'Custom/README.md')).toBe(true);
  });

  it('skips hidden/vendored dirs and honours the depth limit', () => {
    const entries = scanGeneric(ecoRoot);
    expect(entries.some((e) => e.path.includes('node_modules'))).toBe(false);
    expect(entries.some((e) => e.path.includes('.hidden'))).toBe(false);
    expect(entries.some((e) => e.path.includes('/d7/'))).toBe(false);
  });

  it('defaults the label to the root basename', () => {
    const entries = scanGeneric(ecoRoot);
    expect(entries.every((e) => e.key.startsWith('Eco/'))).toBe(true);
  });
});

describe('ecosystemKnowledge coverage — scanEcosystems', () => {
  it('returns empty for no roots and skips missing ones', () => {
    expect(scanEcosystems([])).toEqual([]);
    expect(scanEcosystems([path.join(base, 'missing')])).toEqual([]);
  });

  it('merges canonical and generic entries for a single root', () => {
    const entries = scanEcosystems([ecoRoot]);
    expect(entries.some((e) => e.kind === 'agent' && e.key === 'foo-agent')).toBe(true);
    expect(entries.some((e) => e.kind === 'skill' && e.key === 'Eco/root')).toBe(true);
    // canonical skill kept, generic duplicate suppressed
    expect(entries.filter((e) => e.kind === 'skill' && e.key === 'alpha')).toHaveLength(1);
  });

  it('namespaces and de-duplicates canonical entries across roots', () => {
    const entries = scanEcosystems([ecoRoot, ecoRoot2]);
    const foo = entries.filter((e) => e.kind === 'agent' && e.key === 'Eco/foo-agent');
    expect(foo).toHaveLength(1);
    // generic-only entry from the primary root survives
    expect(entries.some((e) => e.key === 'Eco/root')).toBe(true);
  });
});

describe('ecosystemKnowledge coverage — persistence + query', () => {
  it('refreshKnowledgeIndex with null does not persist', () => {
    const snap = refreshKnowledgeIndex(null);
    expect(snap.live).toBe(true);
    expect(snap.root).toBeNull();
    expect(snap.entries).toEqual([]);
    expect(countRows()).toBe(0);
  });

  it('refreshKnowledgeIndex persists canonical entries and reports sources', () => {
    const snap = refreshKnowledgeIndex(ecoRoot);
    expect(snap.entries.length).toBeGreaterThan(0);
    expect(snap.totals.agent).toBe(3);

    const sources = sourceCounts();
    expect(sources).toHaveLength(1);
    expect(sources[0].label).toBe('Eco');
    expect(sources[0].entries).toBe(snap.entries.length);
  });

  it('refreshKnowledgeIndexes handles empty and populated root sets', () => {
    const empty = refreshKnowledgeIndexes([]);
    expect(empty.root).toBeNull();
    expect(countRows()).toBe(0);

    const single = refreshKnowledgeIndexes([ecoRoot]);
    expect(single.entries.some((e) => e.kind === 'skill' && e.key === 'Eco/root')).toBe(true);

    const multi = refreshKnowledgeIndexes([ecoRoot, ecoRoot2]);
    expect(multi.entries.length).toBeGreaterThan(0);
    // Both roots share the label "Eco", so entries attribute to the first root.
    expect(sourceCounts()).toHaveLength(1);
  });

  it('ensureKnowledgeIndexed populates once and then no-ops', () => {
    ensureKnowledgeIndexed([ecoRoot]);
    const afterFirst = countRows();
    expect(afterFirst).toBeGreaterThan(0);

    ensureKnowledgeIndexed([ecoRoot2]);
    expect(countRows()).toBe(afterFirst);
  });

  it('searchKnowledge filters by kind, search text and clamps the limit', () => {
    // Empty index but a configured root triggers a canonical refresh.
    const refreshed = searchKnowledge({}, ecoRoot);
    expect(refreshed.entries.length).toBeGreaterThan(0);

    const agents = searchKnowledge({ kind: 'agent' }, ecoRoot);
    expect(agents.entries.length).toBeGreaterThan(0);
    for (const e of agents.entries) expect(e.kind).toBe('agent');

    const found = searchKnowledge({ search: 'foo' }, ecoRoot);
    expect(found.entries.some((e) => e.key === 'foo-agent')).toBe(true);

    // Wildcard characters must be escaped, not treated as SQL wildcards.
    expect(() => searchKnowledge({ search: '%_x' }, ecoRoot)).not.toThrow();

    const tiny = searchKnowledge({ limit: 0 }, ecoRoot);
    expect(tiny.entries.length).toBeLessThanOrEqual(1);

    const huge = searchKnowledge({ limit: 99_999 }, ecoRoot);
    expect(huge.entries.length).toBeLessThanOrEqual(300);

    const blank = searchKnowledge({ kind: '   ', search: '  ' }, ecoRoot);
    expect(blank.entries.length).toBeGreaterThan(0);
  });

  it('searchKnowledge reports a missing root honestly', () => {
    const snap = searchKnowledge({}, null);
    expect(snap.live).toBe(false);
    expect(snap.entries).toEqual([]);
    expect(snap.error).toContain('ecosystem root not configured');
  });
});
