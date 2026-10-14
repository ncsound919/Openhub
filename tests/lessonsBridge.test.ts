import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveLessonsConfig,
  parseLessonsFindings,
  verifyCitations,
  loadLessonsFindings,
  summarizeLessons,
  type ResolvedLessons,
} from '../src/services/lessonsBridge';
import { createFinding, dedupKey, findingId } from '../src/services/findings';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-bridge-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, content = 'x\n'): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function converterFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: 'tests',
    category: 'lesson/2026-01-01-a',
    identity: 'lesson/2026-01-01-a|src/a.ts|1',
    source: 'lessons',
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    locatable: true,
    location: { file: 'src/a.ts', line: 1 },
    evidence: 'a recorded finding',
    ...over,
  };
}

describe('resolveLessonsConfig', () => {
  it('reports a reason when no dir resolves instead of silently disabling', () => {
    const r = resolveLessonsConfig('/repo', { enabled: true, dir: '', repoPath: '' }, {});
    expect(r.enabled).toBe(true);
    expect(r.dir).toBeNull();
    expect(r.reason).toMatch(/no lessons dir/i);
  });

  it('honours OPENHUB_LESSONS=0 over an enabled config', () => {
    const r = resolveLessonsConfig('/repo', { enabled: true, dir: 'lessons', repoPath: '' }, { OPENHUB_LESSONS: '0' });
    expect(r.enabled).toBe(false);
  });

  it('resolves a relative dir against the repo root and finds the converter', () => {
    const root = tmpDir();
    write(root, 'lessons/lessons-to-openhub.mjs', '// stub\n');
    const r = resolveLessonsConfig(root, { enabled: true, dir: 'lessons', repoPath: '' }, {});
    expect(r.script).toBe(path.join(root, 'lessons', 'lessons-to-openhub.mjs'));
    expect(r.reason).toBeUndefined();
  });

  it('reports a missing converter rather than pretending it will run', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'lessons'), { recursive: true });
    const r = resolveLessonsConfig(root, { enabled: true, dir: 'lessons', repoPath: '' }, {});
    expect(r.script).toBeNull();
    expect(r.reason).toMatch(/converter not found/i);
  });
});

describe('parseLessonsFindings', () => {
  it('synthesizes a stable identity for an older converter that omits it', () => {
    const out = parseLessonsFindings(JSON.stringify([converterFinding({ identity: undefined })]));
    expect(out).toHaveLength(1);
    expect(out[0].identity).toBe('lessons|lesson/2026-01-01-a|src/a.ts|1');
    // A per-tool `id` must be derived too, not left empty.
    expect(out[0].id).toBeTruthy();
    expect(out[0].id).toBe(findingId(out[0]));
  });

  it('rejects non-array stdout', () => {
    expect(() => parseLessonsFindings('{"not":"an array"}')).toThrow(/not a findings array/);
    expect(() => parseLessonsFindings('not json')).toThrow(/not JSON/);
  });
});

describe('verifyCitations', () => {
  it('routes present citations and reports absent ones as stale, never dropping them', () => {
    const root = tmpDir();
    write(root, 'src/a.ts', 'line1\nline2\n');
    const findings = [
      createFinding({ source: 'lessons', dimension: 'tests', category: 'lesson/ok', severity: 'high', identity: 'lesson/ok|src/a.ts|1', location: { file: 'src/a.ts', line: 1 } }),
      createFinding({ source: 'lessons', dimension: 'tests', category: 'lesson/gone', severity: 'high', identity: 'lesson/gone|src/z.ts|1', location: { file: 'src/z.ts', line: 1 } }),
      createFinding({ source: 'lessons', dimension: 'tests', category: 'lesson/past', severity: 'low', identity: 'lesson/past|src/a.ts|9', location: { file: 'src/a.ts', line: 9 } }),
    ];
    const { routeable, stale } = verifyCitations(findings, root);
    expect(routeable.map((f) => f.category)).toEqual(['lesson/ok']);
    expect(stale.map((s) => s.reason)).toEqual(['file absent in target tree', 'line 9 > 3']);
    expect(stale[0].lessons).toEqual(['lesson/gone']);
  });
});

describe('loadLessonsFindings', () => {
  const resolved: ResolvedLessons = { enabled: true, dir: '/corpus', script: '/corpus/lessons-to-openhub.mjs', repoPath: '/repo' };

  it('merges routeable findings and reports stale ones', async () => {
    const root = tmpDir();
    write(root, 'src/a.ts', 'line1\n');
    const runner = async () => ({ stdout: JSON.stringify([converterFinding()]), stderr: '', ok: true });
    const out = await loadLessonsFindings(resolved, root, { runner });
    expect(out.ran).toBe(true);
    expect(out.emitted).toBe(1);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].identity).toBe('lesson/2026-01-01-a|src/a.ts|1');
  });

  it('reports a converter failure as ran:false, never an empty success', async () => {
    const root = tmpDir();
    const runner = async () => ({ stdout: '', stderr: 'boom', ok: false, error: 'exit 1' });
    const out = await loadLessonsFindings(resolved, root, { runner });
    expect(out.ran).toBe(false);
    expect(out.error).toMatch(/converter failed/);
    expect(out.findings).toEqual([]);
  });

  it('does not run when disabled', async () => {
    let called = false;
    const runner = async () => { called = true; return { stdout: '[]', stderr: '', ok: true }; };
    const out = await loadLessonsFindings({ ...resolved, enabled: false }, tmpDir(), { runner });
    expect(out.ran).toBe(false);
    expect(called).toBe(false);
  });
});

describe('summarizeLessons', () => {
  it('reports counts and caps the stale list', () => {
    const s = summarizeLessons(
      { enabled: true, ran: true, dir: '/c', script: '/c/x.mjs', emitted: 3, findings: [], stale: Array.from({ length: 30 }, (_, i) => ({ file: `f${i}`, reason: 'absent', lessons: ['l'] })) },
      5,
    );
    expect(s.staleCitations).toBe(30);
    expect(s.stale).toHaveLength(5);
    expect(s.routed).toBe(0);
  });
});

describe('identity does not collide with scanner findings', () => {
  it('keeps a lesson citation distinct from a live finding at the same location', () => {
    const lesson = createFinding({ source: 'lessons', dimension: 'tests', category: 'lesson/x', severity: 'high', identity: 'lesson/x|src/a.ts|10', location: { file: 'src/a.ts', line: 10 } });
    const live = createFinding({ source: 'deep', dimension: 'tests', category: 'npe', severity: 'high', location: { file: 'src/a.ts', line: 10 } });
    expect(dedupKey(lesson)).not.toBe(dedupKey(live));
  });
});
