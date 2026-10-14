import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanRepoForSecrets } from '../src/services/secretScan';

describe('scanRepoForSecrets', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns no findings for clean files', () => {
    fs.writeFileSync(path.join(dir, 'clean.ts'), 'export const x = 1;\n');
    expect(scanRepoForSecrets(dir)).toEqual([]);
  });

  it('detects an AWS access key with file and line info', () => {
    fs.writeFileSync(path.join(dir, 'aws.ts'), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const findings = scanRepoForSecrets(dir);
    const aws = findings.filter((f) => f.title.includes('AWS Key'));
    expect(aws.length).toBeGreaterThan(0);
    expect(aws[0].severity).toBe('CRITICAL');
    expect(aws[0].file).toBe('aws.ts');
    expect(aws[0].line).toBe(1);
  });

  it('detects a GitHub token', () => {
    fs.writeFileSync(path.join(dir, 'gh.ts'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    expect(scanRepoForSecrets(dir).some((f) => f.title.includes('GitHub Token'))).toBe(true);
  });

  it('skips node_modules', () => {
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
    fs.writeFileSync(path.join(dir, 'top.ts'), 'export const ok = true;\n');
    const findings = scanRepoForSecrets(dir);
    expect(findings.every((f) => !f.file.includes('node_modules'))).toBe(true);
  });
});
