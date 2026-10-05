import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFinding, type Finding } from '../src/services/findings';
import {
  collectCoreFiles,
  readManifestDependencies,
  runAuditCore,
  loadLifecycle,
  saveLifecycle,
  runRulesForRepo,
  makeTextCompleter,
} from '../src/services/auditCore';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-core-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function finding(over: Record<string, unknown> = {}): Finding {
  return createFinding({
    source: 'deep',
    dimension: 'security',
    category: 'secret',
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    location: { file: 'src/a.ts', line: 1 },
    evidence: 'sk-live-abcdef123456',
    ...over,
  });
}

describe('collectCoreFiles / readManifestDependencies', () => {
  it('walks source files and skips node_modules', () => {
    const d = tmpDir();
    write(d, 'src/a.ts', 'const x = 1;\n');
    write(d, 'node_modules/pkg/index.js', 'module.exports = {};\n');
    write(d, 'README.md', '# hi');
    const files = collectCoreFiles(d).map((f) => f.file).sort();
    expect(files).toEqual(['src/a.ts']);
  });

  it('reads direct dependencies from package.json', () => {
    const d = tmpDir();
    write(d, 'package.json', JSON.stringify({ dependencies: { axios: '^1.0.0' }, devDependencies: { vitest: '^4' } }));
    const deps = readManifestDependencies(d);
    expect(deps.has('axios')).toBe(true);
    expect(deps.has('vitest')).toBe(true);
  });
});

describe('runAuditCore', () => {
  it('validates, lifecycles, gates and persists', () => {
    const d = tmpDir();
    write(d, 'src/a.ts', `const API_KEY = "sk-live-abcdef123456";\n`);
    const findings = [
      finding(), // confirmed secret
      finding({ category: 'npe', dimension: 'correctness', location: { file: 'gone.ts', line: 1 } }), // stale
    ];
    const r = runAuditCore({ rootDir: d, findings });
    expect(r.validation.confirmed).toBe(1);
    expect(r.validation.stale).toBe(1);
    expect(r.validation.droppedStale).toBe(1);
    expect(r.lifecycle.created).toBe(1);
    expect(r.gate.passed).toBe(false); // new high finding
    expect(loadLifecycle(d)).toHaveLength(1);
  });

  it('marks a repeat finding persisting and passes the new-only gate', () => {
    const d = tmpDir();
    write(d, 'src/a.ts', `const API_KEY = "sk-live-abcdef123456";\n`);
    runAuditCore({ rootDir: d, findings: [finding()] });
    const second = runAuditCore({ rootDir: d, findings: [finding()] });
    expect(second.lifecycle.persisting).toBe(1);
    expect(second.lifecycle.created).toBe(0);
    expect(second.gate.passed).toBe(true);
  });

  it('auto-resolves a finding that disappeared', () => {
    const d = tmpDir();
    write(d, 'src/a.ts', `const API_KEY = "sk-live-abcdef123456";\n`);
    runAuditCore({ rootDir: d, findings: [finding()] });
    const next = runAuditCore({ rootDir: d, findings: [] });
    expect(next.lifecycle.resolvedNow).toBe(1);
  });

  it('does not persist when persist:false', () => {
    const d = tmpDir();
    write(d, 'src/a.ts', 'const x = 1;\n');
    runAuditCore({ rootDir: d, findings: [], persist: false });
    expect(fs.existsSync(path.join(d, '.openhub', 'audit-lifecycle.json'))).toBe(false);
  });
});

describe('lifecycle persistence', () => {
  it('round-trips records', () => {
    const d = tmpDir();
    saveLifecycle(d, [{ fingerprint: 'x', source: 's', category: 'c', dimension: 'correctness', severity: 'low', status: 'open', firstSeen: '', lastSeen: '', seenCount: 1 }]);
    expect(loadLifecycle(d)[0].fingerprint).toBe('x');
  });
});

describe('rules + completer', () => {
  it('returns null when no LLM endpoint is configured', () => {
    expect(makeTextCompleter({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('evaluates repo rules with an injected completer', async () => {
    const d = tmpDir();
    write(d, 'openhub.yaml', ['rules:', '  - name: No secrets', '    description: Flag hardcoded secrets.', '    severity: high', '    include: ["src/**"]'].join('\n'));
    write(d, 'src/a.ts', 'const k = "x";\n');
    const complete = async () => '[{"file":"src/a.ts","line":1,"message":"hardcoded secret","severity":"high"}]';
    const r = await runRulesForRepo(d, complete);
    expect(r.configSource).toBe('openhub.yaml');
    expect(r.evaluated).toEqual(['No secrets']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].category).toBe('rule:no-secrets');
  });
});
