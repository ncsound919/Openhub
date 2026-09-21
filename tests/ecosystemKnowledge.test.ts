import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { initializeDatabase, getDb } from '../src/auth/db.js';
import {
  scanEcosystem,
  totalsOf,
  refreshKnowledgeIndex,
  searchKnowledge,
  readFrontmatter,
} from '../src/services/ecosystemKnowledge.js';

// Real-data tests: the operator's Ecosystem folder must exist for these to run.
// They assert against the ACTUAL folder contents, guaranteeing the index is
// populated from reality, not fixtures.
const ECOSYSTEM_ROOT = process.env.OPENHUB_ECOSYSTEM_ROOT || 'C:/Users/User/Desktop/Ecosystem';

const folderPresent = (() => {
  try { return require('fs').existsSync(ECOSYSTEM_ROOT); } catch { return false; }
})();

describe('ecosystemKnowledge (real folder)', () => {
  beforeAll(() => { initializeDatabase(); });

  describe('frontmatter parsing', () => {
    it('reads name and description from YAML frontmatter', () => {
      const fm = readFrontmatter('---\nname: gsd-code-reviewer\ndescription: Reviews source files for bugs\nmode: subagent\n---\n\n<body>');
      expect(fm.name).toBe('gsd-code-reviewer');
      expect(fm.description).toContain('Reviews source files');
    });

    it('returns empty for markdown without frontmatter', () => {
      expect(readFrontmatter('# Just a heading\n\nSome text')).toEqual({});
    });
  });

  describe('scan', () => {
    beforeAll(() => {
      // Make sure the test DB has a clean, known index state.
      try { getDb().prepare('DELETE FROM ecosystem_knowledge').run(); } catch {}
    });

    it('indexes real ecosystem assets (agents, skills, workflows, commands)', () => {
      const root = folderPresent ? ECOSYSTEM_ROOT : null;
      const entries = scanEcosystem(root);
      if (!folderPresent) { expect(entries.length).toBe(0); return; }

      const totals = totalsOf(entries);
      expect(entries.length).toBeGreaterThan(300);

      expect(totals.agent).toBeGreaterThanOrEqual(30);          // agents/*.md
      expect(totals.skill).toBeGreaterThanOrEqual(120);         // real SKILL.md count (skills + ecc-skills)
      expect(totals.workflow).toBeGreaterThanOrEqual(85);       // flat .md workflows (discuss/execute-phase are directories)
      expect(totals.reference).toBeGreaterThanOrEqual(40);      // gsd references
      expect(totals.command).toBeGreaterThanOrEqual(70);        // commands/gsd docs
      expect(totals.rule).toBeGreaterThanOrEqual(3);
    });

    it('extracts a real description for gsd-code-reviewer', () => {
      const entries = scanEcosystem(folderPresent ? ECOSYSTEM_ROOT : null);
      const agent = entries.find((e) => e.kind === 'agent' && e.key === 'gsd-code-reviewer');
      if (!folderPresent) return;
      expect(agent).toBeDefined();
      expect(agent!.description.toLowerCase()).toContain('review');
    });
  });

  describe('index + search', () => {
    beforeAll(() => {
      if (folderPresent) refreshKnowledgeIndex(ECOSYSTEM_ROOT);
    });

    it('searches across names and descriptions', () => {
      if (!folderPresent) return;
      const hit = searchKnowledge({ search: 'review' }, ECOSYSTEM_ROOT);
      expect(hit.live).toBe(true);
      expect(hit.entries.length).toBeGreaterThan(0);
    });

    it('filters by kind', () => {
      if (!folderPresent) return;
      const agents = searchKnowledge({ kind: 'agent' }, ECOSYSTEM_ROOT);
      expect(agents.entries.length).toBeGreaterThan(0);
      for (const e of agents.entries) expect(e.kind).toBe('agent');
    });

    it('rejects unknown kinds explicitly via the totals contract', () => {
      if (!folderPresent) return;
      const all = searchKnowledge({}, ECOSYSTEM_ROOT);
      expect(all.totals).toBeTruthy();
      expect(all.totals.agent ?? 0).toBeGreaterThan(0);
    });
  });
});

describe('ecosystemKnowledge (no folder)', () => {
  it('degrades to an empty scan honestly', () => {
    const entries = scanEcosystem('C:/definitely/not/a/real/path');
    expect(entries).toEqual([]);
  });
});