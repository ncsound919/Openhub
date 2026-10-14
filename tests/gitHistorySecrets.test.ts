import { describe, it, expect } from 'vitest';
import { scanSecretContent } from '../src/services/p2Scorers.js';

// The self-audit reported 24 "secrets" that were all dummy keys in test fixtures.
// The heuristic scan must skip fixtures and placeholders; gitleaks remains the
// authoritative scan for everything.
describe('scanSecretContent (heuristic git-history secret scan)', () => {
  it('skips test and fixture paths', () => {
    expect(scanSecretContent('const key = "AKIAZ3XQ7PLMN4VW2RTY"', 'tests/a.test.ts')).toEqual([]);
    expect(scanSecretContent('const key = "AKIAZ3XQ7PLMN4VW2RTY"', 'src/__mocks__/x.ts')).toEqual([]);
    expect(scanSecretContent('const key = "AKIAZ3XQ7PLMN4VW2RTY"', 'e2e/login.spec.ts')).toEqual([]);
    expect(scanSecretContent('const key = "AKIAZ3XQ7PLMN4VW2RTY"', 'test/fixtures/config.json')).toEqual([]);
  });

  it('skips obvious placeholder values', () => {
    expect(scanSecretContent('const k = "AKIAIOSFODNN7EXAMPLE"', 'src/config.ts')).toEqual([]);
    expect(scanSecretContent('const stripe = "sk_test_1234567890abcdef"', 'src/pay.ts')).toEqual([]);
    expect(scanSecretContent('const apiKey = "your_api_key_here"', 'src/config.ts')).toEqual([]);
  });

  it('flags a real-looking AWS key outside tests', () => {
    const f = scanSecretContent('const k = "AKIAZ3XQ7PLMN4VW2RTY"', 'src/aws.ts');
    expect(f).toHaveLength(1);
    expect(f[0].category).toBe('secret-aws-key');
    expect(f[0].location?.line).toBe(1);
  });

  it('flags a real-looking generic key outside tests', () => {
    const f = scanSecretContent('const apiKey = "a1b2c3d4e5f6g7h8i9j0"', 'src/service.ts');
    expect(f.some((x) => x.category === 'secret-generic')).toBe(true);
  });
});
