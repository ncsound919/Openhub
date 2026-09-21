import { test, expect } from '@playwright/test';

test.describe.serial('Ecosystem inventory filters', () => {
  test('filters the actual ecosystem inventory without creating local records', async ({ page }) => {
    await page.goto('/fleet?tab=ecosystem');
    await expect(page.getByRole('heading', { name: /Knowledge/i })).toBeVisible();

    const search = page.getByPlaceholder('Search agents, skills, workflows, rules…');
    await search.fill('agent');
    await expect(search).toHaveValue('agent');

    const kindAll = page.getByRole('button', { name: /^all\b/i }).first();
    await expect(kindAll).toBeVisible();
    await kindAll.click();

    await expect(page.getByRole('button', { name: /New Resource/i })).toHaveCount(0);
  });
});