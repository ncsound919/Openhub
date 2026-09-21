import { describe, it, expect } from 'vitest';
import { gateRequired, prefersPlanGate } from '../src/lib/autonomy.js';

// The autonomy switch decides how much friction a consequential action gets.
describe('autonomy gate policy', () => {
  it('manual gates every consequential intensity', () => {
    expect(gateRequired('reversible', 'manual')).toBe(true);
    expect(gateRequired('destructive', 'manual')).toBe(true);
    expect(gateRequired('catastrophic', 'manual')).toBe(true);
  });

  it('auto lets reversible actions run and gates destructive ones', () => {
    expect(gateRequired('reversible', 'auto')).toBe(false);
    expect(gateRequired('destructive', 'auto')).toBe(true);
    expect(gateRequired('catastrophic', 'auto')).toBe(true);
  });

  it('plan gates everything and prefers an approvable plan', () => {
    expect(gateRequired('reversible', 'plan')).toBe(true);
    expect(prefersPlanGate('plan')).toBe(true);
    expect(prefersPlanGate('auto')).toBe(false);
    expect(prefersPlanGate('manual')).toBe(false);
  });
});
