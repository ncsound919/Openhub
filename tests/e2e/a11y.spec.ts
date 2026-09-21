import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility gate (E4) — runs axe-core against the primary IA surfaces, in
 * BOTH themes, and fails on serious or critical violations. The light pass
 * doubles as the E1 theme regression check: if a token regresses contrast,
 * this fails. Runs under the authenticated `e2e` Playwright project.
 */

const PRIMARY_PAGES = [
  { name: 'Command', path: '/' },
  { name: 'Workspace', path: '/workspace' },
  { name: 'Activity', path: '/activity' },
  { name: 'Projects', path: '/projects' },
  { name: 'Assurance', path: '/assurance' },
  { name: 'Loops', path: '/axiom' },
  { name: 'Fleet', path: '/fleet' },
  { name: 'CRM', path: '/crm' },
  { name: 'Reporter', path: '/reporter' },
  { name: 'Insights', path: '/insights' },
  { name: 'Models', path: '/models' },
  { name: 'Studio', path: '/studio' },
  { name: 'Settings', path: '/settings' },
  { name: 'Antagonist', path: '/antagonist' },
];

const THEMES = ['dark', 'light'] as const;

for (const theme of THEMES) {
  for (const target of PRIMARY_PAGES) {
    test(`a11y: ${target.name} (${theme}) has no serious or critical axe violations`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('openhub.theme', t);
        } catch { /* private mode */ }
      }, theme);

      await page.goto(target.path);
      await expect(page.locator('main')).toBeVisible({ timeout: 8000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      const serious = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 6).map((n) => ({
            target: n.target.join(' '),
            html: (n.html || '').slice(0, 120),
            summary: (n.failureSummary || '').replace(/\n/g, ' ').slice(0, 180),
          })),
        }));

      expect(serious, `axe serious/critical violations on ${target.path} (${theme})`).toEqual([]);
    });
  }
}