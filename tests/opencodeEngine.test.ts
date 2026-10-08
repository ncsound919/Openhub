import { describe, it, expect } from 'vitest';
import { OPENCODE_BASE, buildServeArgs, parsePassword } from '../src/services/opencodeEngine.js';

describe('opencodeEngine', () => {
  it('targets a dedicated loopback port', () => {
    expect(OPENCODE_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
  it('builds serve args with host and port', () => {
    expect(buildServeArgs()).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(Number(process.env.OPENCODE_PORT || '4196'))]);
  });
  it('trims a trailing newline from the password', () => {
    expect(parsePassword('secret\n')).toBe('secret');
    expect(parsePassword(undefined)).toBe('');
  });
});
