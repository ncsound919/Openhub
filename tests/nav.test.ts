import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, BREADCRUMBS } from '../src/lib/nav.js';

describe('nav', () => {
  it('exposes the editor and drops the redundant missions route', () => {
    const tos = NAV_ITEMS.map((i) => i.to);
    expect(tos).toContain('/editor');
    expect(tos).not.toContain('/missions');
    expect(tos).not.toContain('/workspace');
  });
  it('has a breadcrumb for the editor', () => {
    expect(BREADCRUMBS['/editor']).toBe('Editor');
    expect(BREADCRUMBS['/missions']).toBeUndefined();
  });
});
