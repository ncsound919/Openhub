import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, BREADCRUMBS } from '../src/lib/nav.js';

describe('nav', () => {
  it('exposes Missions and Editor, not Workspace', () => {
    const tos = NAV_ITEMS.map((i) => i.to);
    expect(tos).toContain('/missions');
    expect(tos).toContain('/editor');
    expect(tos).not.toContain('/workspace');
  });
  it('has breadcrumbs for the new routes', () => {
    expect(BREADCRUMBS['/missions']).toBe('Missions');
    expect(BREADCRUMBS['/editor']).toBe('Editor');
  });
});
