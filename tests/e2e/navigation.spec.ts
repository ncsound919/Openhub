import { test, expect } from '@playwright/test';

const pages = [
  { name: 'Command', path: '/' },
  { name: 'Workspace', path: '/workspace' },
  { name: 'Projects', path: '/projects' },
  { name: 'CRM', path: '/crm' },
  { name: 'Loops', path: '/axiom' },
  { name: 'Assurance', path: '/assurance' },
  { name: 'Fleet Hub', path: '/fleet' },
  { name: 'Insights', path: '/insights' },
  { name: 'Activity', path: '/activity' },
  { name: 'Settings', path: '/settings' },
  { name: 'Studio', path: '/studio' },
];

test('all main pages load correctly', async ({ page }) => {
  for (const p of pages) {
    await page.goto(p.path);
    await expect(page.locator('main')).toBeVisible({ timeout: 8000 });
  }
});

test('legacy routes redirect to their consolidated home', async ({ page }) => {
  test.setTimeout(180000);
  const redirects: { from: string; to: string }[] = [
    { from: '/github', to: '/projects' },
    { from: '/autonomous', to: '/assurance?tab=pipelines' },
    { from: '/audit', to: '/assurance?tab=audit' },
    { from: '/repair', to: '/assurance?tab=repair' },
    { from: '/readiness', to: '/assurance?tab=readiness' },
    { from: '/testing', to: '/assurance?tab=readiness' },
    { from: '/registry', to: '/fleet?tab=ecosystem' },
    { from: '/services', to: '/fleet?tab=services' },
    { from: '/ecosystem', to: '/fleet?tab=ecosystem' },
    { from: '/integrations', to: '/settings?tab=integrations' },
  ];
  for (const r of redirects) {
    // Client-side <Navigate> redirects abort the initial navigation promise
    // (net::ERR_ABORTED) even though the SPA redirect succeeds. Use `waitForURL`
    // (driven by Playwright's navigation events) rather than evaluating JS in
    // the page, whose main thread can be busy while the redirect settles.
        await page.goto(r.from, { waitUntil: 'commit' }).catch(() => {});
    await page.waitForURL(
      (url) => url.pathname + url.search === r.to,
      { timeout: 10000, waitUntil: 'commit' },
    );
    await expect(page.locator('main')).toBeVisible({ timeout: 8000 });
  }
});
