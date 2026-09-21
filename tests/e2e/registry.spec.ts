import { test, expect } from '@playwright/test';

test.describe.serial('Ecosystem knowledge inventory', () => {
  test('shows the live ecosystem inventory instead of editable registry records', async ({ page }) => {
    await page.goto('/fleet?tab=ecosystem');
    await expect(page.getByRole('heading', { name: /Knowledge/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-index' })).toBeVisible();
    await expect(page.getByPlaceholder('Search agents, skills, workflows, rules…')).toBeVisible();
    await expect(page.getByRole('button', { name: /New Resource/i })).toHaveCount(0);
  });
});