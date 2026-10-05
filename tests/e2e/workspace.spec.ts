import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { authenticatedMutationHeaders, sharedCredentials } from '../helpers/auth';

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');
const repoName = 'workspace-test';

test.describe.serial('Workspace', () => {
  let username: string;
  let repoId: string;
  test.beforeAll(() => {
    ({ username } = sharedCredentials());
  });

  test('create repo with files', async ({ page }) => {
    const res = await page.context().request.post('/api/repos', {
      data: { name: repoName, description: 'Workspace test repo', isPrivate: false },
      headers: await authenticatedMutationHeaders(page),
    });
    expect(res.ok()).toBeTruthy();
    const repo = await res.json();
    repoId = repo.id;

    const repoDir = path.join(REPOS_ROOT, username, repoName);
    const subDir = path.join(repoDir, 'src');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export function hello() {\n  return "Hello from workspace!";\n}');
    fs.writeFileSync(path.join(subDir, 'utils.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}');

    const select = await page.context().request.post('/api/project/active', {
      data: { repoId },
      headers: await authenticatedMutationHeaders(page),
    });
    if (select.status() === 409) {
      // Single-project model: clear whatever is active, then select.
      const headers = await authenticatedMutationHeaders(page);
      await page.context().request.delete('/api/project/active', { headers });
      const retry = await page.context().request.post('/api/project/active', { data: { repoId }, headers });
      expect(retry.ok()).toBeTruthy();
      expect((await retry.json()).project.repoId).toBe(repoId);
    } else {
      expect(select.ok()).toBeTruthy();
      expect((await select.json()).project.repoId).toBe(repoId);
    }
  });

  test('workspace page loads the selected project with its breadcrumb', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForURL('/workspace');

    // Breadcrumb should show repo name
    await expect(page.getByText(repoName).first()).toBeVisible({ timeout: 10000 });
    // Save button exists (disabled until file opened)
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible({ timeout: 5000 });
  });

  test('terminal and save buttons are available', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForURL('/workspace');

    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible({ timeout: 5000 });
  });
});
