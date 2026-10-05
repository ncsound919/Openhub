import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectTheaterAndMocks } from '../src/services/systemScanner';
import { builtinDuplication } from '../src/services/p2Scorers';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-signal-'));
}

describe('theater detection is comment/string-aware (B3)', () => {
  it('does not flag real variable names or legitimate fallback comments', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), [
      'const sampleSize = 10;',
      'const mockClient = realClient;',
      '// fallback path when the service is offline',
      'const mockData = [{ id: 1 }];',
      '// stub',
    ].join('\n'));
    try {
      const scan = detectTheaterAndMocks(root);
      const mock = scan.occurrences.filter((o) => o.category === 'mock_data');
      const stub = scan.occurrences.filter((o) => o.category === 'stub_implementation');
      expect(mock).toHaveLength(1);
      expect(mock[0].content).toContain('mockData');
      expect(mock.some((o) => o.content.includes('sampleSize'))).toBe(false);
      expect(mock.some((o) => o.content.includes('mockClient'))).toBe(false);
      expect(stub).toHaveLength(1);
      expect(stub[0].content).toContain('stub');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('duplication coalesces a block into one finding (B4)', () => {
  it('emits a single block finding per contiguous clone, not one per window', () => {
    const root = tmpDir();
    const block = Array.from({ length: 14 }, (_, i) => `const value${i} = compute(${i}, ${i + 1});`).join('\n');
    fs.writeFileSync(path.join(root, 'a.py'), block);
    fs.writeFileSync(path.join(root, 'b.py'), block);
    try {
      const findings = builtinDuplication(root);
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe('duplicate-code');
      expect(findings[0].location?.endLine).toBeGreaterThan(findings[0].location?.line ?? 0);
      expect(findings[0].evidence).toMatch(/\d+ lines duplicated/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
