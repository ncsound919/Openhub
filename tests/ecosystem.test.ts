import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEcosystemContext, summarizeEcosystem } from '../src/services/ecosystem';

describe('loadEcosystemContext', () => {
  let tmp: string;
  let home: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('degrades gracefully when not configured', () => {
    const ctx = loadEcosystemContext({}, home);
    expect(ctx.configured).toBe(false);
    expect(ctx.source).toBe('degraded');
    expect(ctx.layers.every((l) => l.content === null)).toBe(true);
    expect(ctx.fleetCatalog.path).toBeNull();
    expect(ctx.draymondState).toEqual([]);
    expect(() => summarizeEcosystem(ctx)).not.toThrow();
  });

  it('loads layer files from the ecosystem root', () => {
    const rulesDir = path.join(tmp, 'rules', 'overlay365');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'SOUL.md'), '# Soul\nvoice: test');
    fs.writeFileSync(path.join(rulesDir, 'ECOSYSTEM.md'), '# Ecosystem Map\nroot: test');

    const ctx = loadEcosystemContext({ OPENHUB_ECOSYSTEM_ROOT: tmp }, home);
    expect(ctx.configured).toBe(true);
    expect(ctx.source).toBe('live');
    expect(ctx.layers.find((l) => l.name === 'soul')?.content).toContain('voice: test');
    expect(ctx.layers.find((l) => l.name === 'ops')?.content).toBeNull();
  });

  it('reads the fleet catalog and draymond brain-state inventory', () => {
    const orch = path.join(tmp, 'Draymond-Orchestrator');
    fs.mkdirSync(path.join(orch, '.draymond'), { recursive: true });
    fs.writeFileSync(path.join(orch, 'OPS-CATALOG.md'), '# Catalog\n324 assets');
    fs.writeFileSync(path.join(orch, '.draymond', 'treasury.json'), '{}');
    fs.writeFileSync(path.join(orch, '.draymond', 'learning-lessons.json'), '{}');

    const ctx = loadEcosystemContext({ OPENHUB_ECOSYSTEM_ROOT: tmp }, home);
    expect(ctx.fleetCatalog.path).toBeTruthy();
    expect(ctx.fleetCatalog.excerpt).toContain('324 assets');
    expect(ctx.draymondState).toContain('treasury.json');
    expect(ctx.draymondState).toContain('learning-lessons.json');
  });
});