import { test, expect } from '@playwright/test';
import { authenticatedHeaders } from '../helpers/auth';

/**
 * Audit-team integration (E3/fleet): verifies the audit team surfaces through
 * the auth-gated roster API — the same roster the audit suite and repair
 * dispatch read from. The concrete agent slug is environment-owned (the roster
 * reads the local agents directory and the vendor was renamed), so this asserts
 * the wiring contract rather than pinning one vendor name.
 */
test('audit team roster surfaces a wired audit agent', async ({ page }) => {
  const headers = await authenticatedHeaders(page);
  const res = await page.context().request.get('/api/agents/roster', { headers });
  expect(res.ok()).toBeTruthy();

  const json = await res.json();
  expect(json.ok).toBe(true);
  expect(Array.isArray(json.audit)).toBe(true);
  expect(Array.isArray(json.research)).toBe(true);

  const wired = json.audit.filter((a: { present?: boolean }) => a.present);
  expect(wired.length, 'at least one audit agent is present on disk').toBeGreaterThan(0);
  for (const agent of wired) {
    expect(agent.role).toBe('audit');
    expect(typeof agent.slug).toBe('string');
    expect(agent.path).toMatch(new RegExp(`${agent.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  }
});

test('roster is honest about a missing audit agent directory', async ({ page }) => {
  const headers = await authenticatedHeaders(page);
  const res = await page.context().request.get('/api/agents/roster', { headers });
  const json = await res.json();

  // Every roster entry carries an explicit present flag — never silently dropped.
  for (const agent of [...json.audit, ...json.research]) {
    expect(typeof agent.present).toBe('boolean');
    expect(agent).toHaveProperty('slug');
    expect(agent).toHaveProperty('path');
  }
});
