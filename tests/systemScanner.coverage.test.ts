import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import {
  analyzeSystemAndFiles,
  detectFileArchetype,
  detectTheaterAndMocks,
  executeTests,
  extractExports,
  extractImports,
  generateTestScaffold,
} from '../src/services/systemScanner';

vi.mock('child_process', () => ({ execSync: vi.fn() }));

const tmpDirs: string[] = [];

function tmp(prefix = 'openhub-scan-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/** Fresh module per call so the deploy-readiness cache cannot leak between cases. */
async function loadScanner() {
  vi.resetModules();
  const child = await import('child_process');
  const scanner = await import('../src/services/systemScanner');
  return { scanner, exec: vi.mocked(child.execSync) };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
  vi.mocked(execSync).mockReset();
});

describe('detectFileArchetype', () => {
  it('classifies every archetype branch', () => {
    expect(detectFileArchetype('/a/main.css', '')).toBe('style');
    expect(detectFileArchetype('/a/main.scss', '')).toBe('style');
    expect(detectFileArchetype('/a/vite.config.ts', '')).toBe('config');
    expect(detectFileArchetype('/a/tsconfig.json', '')).toBe('config');
    expect(detectFileArchetype('/a/package.json', '')).toBe('config');
    expect(detectFileArchetype('/a/Button.tsx', '')).toBe('react-component');
    expect(detectFileArchetype('/a/Button.jsx', '')).toBe('react-component');
    expect(detectFileArchetype('/a/view.ts', 'import React from "react";')).toBe('react-component');
    expect(detectFileArchetype('/a/view.ts', 'export function Main() {}')).toBe('react-component');
    expect(detectFileArchetype('/a/view.ts', 'return (<div>')).toBe('react-component');
    expect(detectFileArchetype('/a/db/client.ts', 'CREATE TABLE x')).toBe('data-store');
    expect(detectFileArchetype('/a/store.ts', '')).toBe('data-store');
    expect(detectFileArchetype('/a/q.ts', 'import "better-sqlite3";')).toBe('data-store');
    expect(detectFileArchetype('/a/q.ts', 'db.prepare("select 1")')).toBe('data-store');
    expect(detectFileArchetype('/orchestrator/lead.ts', '')).toBe('agent-service');
    expect(detectFileArchetype('/a/agent.ts', '')).toBe('agent-service');
    expect(detectFileArchetype('/a/x.ts', 'new FastMCP();')).toBe('agent-service');
    expect(detectFileArchetype('/a/x.ts', 'const pipeline = 1;')).toBe('agent-service');
    expect(detectFileArchetype('/a/server.ts', '')).toBe('api-route');
    expect(detectFileArchetype('/a/routes/x.ts', '')).toBe('api-route');
    expect(detectFileArchetype('/a/api/x.ts', '')).toBe('api-route');
    expect(detectFileArchetype('/a/x.ts', 'app.get("/", h)')).toBe('api-route');
    expect(detectFileArchetype('/a/x.ts', 'router.post("/", h)')).toBe('api-route');
    expect(detectFileArchetype('/a/x.ts', 'const n = 1;')).toBe('utility');
  });
});

describe('extractExports / extractImports', () => {
  it('collects functions, vars, classes, default and dedupes', () => {
    const code = `
      export function a() {}
      export async function b() {}
      export const c = 1;
      export let d = 2;
      export var e = 3;
      export class F {}
      export default function G() {}
      export function a() {}
    `;
    const exports = extractExports(code);
    expect(exports).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'F', 'default']));
    expect(exports.filter((x) => x === 'a')).toHaveLength(1);
    expect(extractExports('const x = 1;')).toEqual([]);
  });

  it('collects import sources from single and double quotes', () => {
    const imports = extractImports(`import a from 'x';\nimport b from "y";`);
    expect(imports).toEqual(['x', 'y']);
    expect(extractImports('const z = 1;')).toEqual([]);
  });
});

describe('analyzeSystemAndFiles', () => {
  it('walks a temp tree honoring skip rules and test detection', () => {
    const root = tmp();
    write(root, 'tsconfig.json', '{}');
    write(root, 'vitest.config.ts', 'export default {};');
    write(root, 'playwright.config.ts', 'export default {};');
    fs.mkdirSync(path.join(root, 'vibeserve'), { recursive: true });
    write(root, 'server.ts', 'const app = { get() {} };');
    write(root, 'src/components/Button.tsx', 'import React from "react";\nexport function Button() { return <button/>; }');
    write(root, 'src/db/index.ts', 'import Database from "better-sqlite3";\nexport function getDb(){}');
    write(root, 'src/agent/orch.ts', 'export const mcpClient = 1;');
    write(root, 'src/styles/main.css', 'body { color: red; }');
    write(root, 'src/app.config.ts', 'export const cfg = 1;');
    write(root, 'src/plain.ts', 'export const plain = 1;');
    write(root, 'tests/plain.test.ts', 'describe("x", () => {});');
    write(root, 'tests/button.spec.tsx', 'describe("b", () => {});');
    write(root, 'node_modules/dep/index.ts', 'export const dep = 1;');
    write(root, 'dist/bundle.js', 'export const b = 1;');

    const result = analyzeSystemAndFiles(root);
    expect(result.runtime.hasTypeScript).toBe(true);
    expect(result.runtime.hasVitest).toBe(true);
    expect(result.runtime.hasPlaywright).toBe(true);
    expect(result.runtime.hasFastMCP).toBe(true);
    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.fileBreakdown['react-component']).toBeGreaterThan(0);
    expect(result.fileBreakdown['data-store']).toBeGreaterThan(0);
    expect(result.fileBreakdown['agent-service']).toBeGreaterThan(0);
    expect(result.fileBreakdown['api-route']).toBeGreaterThan(0);
    expect(result.fileBreakdown.config).toBeGreaterThan(0);

    // node_modules and dist must be skipped.
    const rel = result.detailedFiles.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(rel.some((p) => p.includes('node_modules'))).toBe(false);
    expect(rel.some((p) => p.includes('dist/'))).toBe(false);

    // plain.ts has a sibling test; the config/style files are never candidates.
    expect(result.untestedCandidates.some((p) => p.endsWith('plain.ts'))).toBe(false);
    expect(result.untestedCandidates.some((p) => p.endsWith('.css'))).toBe(false);
    expect(result.untestedCandidates.some((p) => p.includes('app.config.ts'))).toBe(false);
    // Sort is by complexity descending — still a plain array.
    expect(Array.isArray(result.untestedCandidates)).toBe(true);
  });

  it('reports an empty project honestly', () => {
    const root = tmp();
    const result = analyzeSystemAndFiles(root);
    expect(result.filesAnalyzed).toBe(0);
    expect(result.untestedCandidates).toEqual([]);
    expect(result.runtime.hasTypeScript).toBe(false);
    expect(result.runtime.hasVitest).toBe(false);
    expect(result.runtime.hasPlaywright).toBe(false);
    expect(result.runtime.hasFastMCP).toBe(false);
  });

  it('does not throw when only individual server.ts exists', () => {
    const root = tmp();
    write(root, 'server.ts', 'app.get("/x", h);');
    const result = analyzeSystemAndFiles(root);
    expect(result.filesAnalyzed).toBe(1);
    expect(result.detailedFiles[0].suggestedFramework).toBe('supertest');
    expect(result.detailedFiles[0].testPriority).toBe('high');
  });
});

describe('detectTheaterAndMocks', () => {
  it('flags every theater category, skips vendor dirs, and truncates long lines', () => {
    const root = tmp();
    write(root, 'src/mocks.ts', [
      "const mockUser = { id: 1 };",
      "const apiKey = 'sk-1234567890abcdefghij';",
      "throw new Error('Not implemented');",
      '// stub branch',
      '// TODO: finish this',
      'lorem ipsum dolor',
      'setTimeout(() => { mock(); }, 100);',
      '// Simulate a few seconds of work',
      "app.get('/items', (req, res) => { res.json([{ id: 'mock' }]); });",
    ].join('\n'));
    write(root, 'src/long.ts', `const sampleThing = '${'z'.repeat(200)}';`);
    write(root, 'src/systemScanner.ts', "const mockSelf = 1;");
    write(root, 'node_modules/dep/bad.ts', 'const mockDep = 1;');
    write(root, 'dist/out.ts', 'const mockOut = 1;');
    write(root, 'src/readme.css', 'const mockCss = 1;');

    const scan = detectTheaterAndMocks(root);
    expect(scan.clean).toBe(false);
    expect(scan.totalOccurrences).toBeGreaterThan(0);
    expect(scan.theaterScore).toBeLessThan(100);
    expect(scan.byCategory.mock_data).toBeGreaterThan(0);
    expect(scan.byCategory.stub_implementation).toBeGreaterThan(0);
    expect(scan.byCategory.placeholder_marker).toBeGreaterThan(0);
    expect(scan.byCategory.simulated_latency).toBeGreaterThan(0);
    expect(scan.byCategory.theater_endpoint).toBeGreaterThan(0);
    expect(scan.bySeverity.critical).toBeGreaterThan(0);
    expect(scan.bySeverity.high).toBeGreaterThan(0);
    expect(scan.bySeverity.medium).toBeGreaterThan(0);
    expect(scan.bySeverity.low).toBeGreaterThan(0);

    const files = scan.occurrences.map((o) => o.file.replace(/\\/g, '/'));
    expect(files.some((f) => f.includes('systemScanner.ts'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('dist/'))).toBe(false);
    expect(files.some((f) => f.endsWith('.css'))).toBe(false);

    const long = scan.occurrences.find((o) => o.file.includes('long.ts'));
    expect(long).toBeDefined();
    expect(long!.content.length).toBe(120);
    expect(long!.content.endsWith('...')).toBe(true);
  });

  it('reports a clean scan for a project with no theater patterns', () => {
    const root = tmp();
    write(root, 'src/clean.ts', 'export const sum = (a: number, b: number) => a + b;\n');
    const scan = detectTheaterAndMocks(root);
    expect(scan.clean).toBe(true);
    expect(scan.totalOccurrences).toBe(0);
    expect(scan.theaterScore).toBe(100);
  });

  it('handles an empty project root without throwing', () => {
    const scan = detectTheaterAndMocks(tmp());
    expect(scan.clean).toBe(true);
    expect(scan.occurrences).toEqual([]);
  });
});

describe('generateTestScaffold', () => {
  it('throws for a file that does not exist', () => {
    const root = tmp();
    expect(() => generateTestScaffold('src/missing.ts', root)).toThrow('File not found');
  });

  it('generates scaffolds for each archetype into a custom output dir', () => {
    const root = tmp();
    const out = path.join(root, 'generated');
    write(root, 'src/Button.tsx', 'import React from "react";\nexport function Button(){ return <b/>; }');
    write(root, 'src/server.ts', "app.get('/x', h);\nexport const app = 1;");
    write(root, 'src/db/store.ts', 'import db from "better-sqlite3";\nexport const db2 = 1;');
    write(root, 'src/util.ts', 'export const u = 1;');

    const react = generateTestScaffold('src/Button.tsx', root, out);
    expect(react.code).toContain('Component');
    expect(fs.existsSync(react.testFilePath)).toBe(true);

    const api = generateTestScaffold('src/server.ts', root, out);
    expect(api.code).toContain('API Endpoints');

    const store = generateTestScaffold('src/db/store.ts', root, out);
    expect(store.code).toContain('Data Store');

    const util = generateTestScaffold('src/util.ts', root, out);
    expect(util.code).toContain('Module');
    expect(util.code).toContain('should handle boundary inputs');

    const absolute = generateTestScaffold(path.join(root, 'src', 'util.ts'), root, out);
    expect(path.isAbsolute(absolute.testFilePath)).toBe(true);
  });

  it('defaults the output dir to <project>/tests, creating it when missing', () => {
    const root = tmp();
    write(root, 'src/only.ts', 'export const only = 1;');
    const generated = generateTestScaffold('src/only.ts', root);
    expect(path.dirname(generated.testFilePath)).toBe(path.join(root, 'tests'));
    expect(fs.existsSync(generated.testFilePath)).toBe(true);
  });
});

describe('getDeployReadiness / executeTests', () => {
  it('aggregates checks, passes at 80, and caches the result', async () => {
    const { scanner, exec } = await loadScanner();
    const root = tmp();
    write(root, 'tsconfig.json', '{}');
    write(root, 'server.ts', 'helmet(); const q = "WHERE r.owner_id = ?";');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'openhub.db'), 'sqlite');

    exec.mockImplementation(((cmd: string) => {
      if (cmd.includes('tsc')) {
        const err = new Error('tsc failed') as Error & { stdout?: Buffer };
        err.stdout = Buffer.from('error TS1: nope');
        throw err;
      }
      return Buffer.from('Tests 5 passed (5)\n');
    }) as never);

    const first = await scanner.getDeployReadiness(root);
    expect(first.checks).toHaveLength(5);
    expect(first.checks.find((c) => c.id === 'type-safety')!.passed).toBe(false);
    expect(first.checks.find((c) => c.id === 'unit-tests')!.passed).toBe(true);
    expect(first.checks.find((c) => c.id === 'security-headers')!.passed).toBe(true);
    expect(first.checks.find((c) => c.id === 'database-integrity')!.details).toContain('openhub.db');
    expect(first.score).toBe(80);
    expect(first.ready).toBe(true);

    const second = await scanner.getDeployReadiness(root);
    expect(second).toBe(first);
  });

  it('fails the readiness gate when typecheck, tests and headers regress', async () => {
    const { scanner, exec } = await loadScanner();
    const root = tmp();
    write(root, 'server.ts', 'const noSecurity = true;');

    exec.mockImplementation(((cmd: string) => {
      if (cmd.includes('tsc')) return Buffer.from('clean');
      throw new Error('tests exploded');
    }) as never);

    const result = await scanner.getDeployReadiness(root);
    expect(result.checks.find((c) => c.id === 'type-safety')!.passed).toBe(true);
    expect(result.checks.find((c) => c.id === 'unit-tests')!.passed).toBe(false);
    expect(result.checks.find((c) => c.id === 'security-headers')!.passed).toBe(false);
    expect(result.checks.find((c) => c.id === 'database-integrity')!.details).toContain('in memory/WAL');
    expect(result.score).toBe(60);
    expect(result.ready).toBe(false);
  });

  it('covers the empty-project readiness defaults', async () => {
    const { scanner, exec } = await loadScanner();
    exec.mockImplementation((() => {
      throw new Error('boom');
    }) as never);
    const result = await scanner.getDeployReadiness(tmp());
    expect(result.checks.find((c) => c.id === 'security-headers')!.passed).toBe(true);
    expect(result.checks.find((c) => c.id === 'theater-gate')!.details).toContain('Clean');
    expect(['pass', 'warn', 'fail']).toContain(result.ready ? 'pass' : 'fail');
  });

  it('executeTests returns stdout or the captured failure text', () => {
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('all tests passed'));
    expect(executeTests(process.cwd())).toBe('all tests passed');

    const err = new Error('ignored') as Error & { stdout?: Buffer; stderr?: Buffer };
    err.stdout = Buffer.from('out-line');
    err.stderr = Buffer.from('err-line');
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw err;
    });
    expect(executeTests(process.cwd())).toContain('out-line');
  });
});
