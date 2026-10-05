import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { authenticatedMutationHeaders, sharedCredentials } from '../helpers/auth';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');
const repoName = `workspace-tools-test-${Date.now()}`;

test.describe.serial('Workspace tools', () => {
  let username: string;
  let repoId: string;

  test.beforeAll(() => {
    ({ username } = sharedCredentials());
  });

  test.afterAll(async ({ browser }) => {
  // Don't leave an active project that breaks later specs (select is single-project).
  const context = await browser.newContext({ storageState: './playwright/.auth/user.json' });
  const page = await context.newPage();
  try {
    const headers = await authenticatedMutationHeaders(page);
    await context.request.delete('/api/project/active', { headers });
  } catch { /* best effort */ } finally {
    await context.close();
  }
});

  test('setup project with a tracked file then modify it on disk', async ({ page }) => {
    // One page load, one set of CSRF+token headers, reused for all mutations.
    const headers = await authenticatedMutationHeaders(page);

    const res = await page.context().request.post('/api/repos', {
      data: { name: repoName, description: 'Workspace tools test', isPrivate: false },
      headers,
    });
    expect(res.ok()).toBeTruthy();
    const repo = await res.json();
    expect(typeof repo.id).toBe('string');
    repoId = repo.id;

    const repoDir = path.join(REPOS_ROOT, username, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export function hello() {\n  return "Hello";\n}');

    // Turn it into a Git worktree with one committed baseline.
    git(repoDir, ['init', '--initial-branch=main']);
    git(repoDir, ['config', 'user.name', 'OpenHub E2E']);
    git(repoDir, ['config', 'user.email', 'e2e@openhub.test']);
    git(repoDir, ['add', 'index.ts']);
    git(repoDir, ['commit', '-m', 'Baseline']);

    // Clear any leftover active project (tolerate 404 when none is set).
    await page.context().request.delete('/api/project/active', { headers });

    const select = await page.context().request.post('/api/project/active', {
      data: { repoId },
      headers,
    });
    expect(select.ok()).toBeTruthy();

    // Modify a tracked file so Source Control shows a change.
    fs.appendFileSync(path.join(repoDir, 'index.ts'), '\nexport const flag = true;\n');
  });

  test('source control lists the change and opens an inline diff', async ({ page }) => {
    await page.goto('/workspace');
    await expect(page.getByText(repoName).first()).toBeVisible({ timeout: 10000 });

    await page.getByTitle('Source Control').click();
    await expect(page.getByRole('button', { name: /index\.ts/i }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/M/).first()).toBeVisible();

    // Open the file from source control -> opens in diff mode.
    await page.getByRole('button', { name: /index\.ts/i }).first().click();
    await expect(page.locator('.monaco-diff-editor').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  });

  test('search returns file:line results that open tabs', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByTitle('Search', { exact: true }).click();
    const input = page.getByPlaceholder('Search files…');
    await input.fill('flag');
    await expect(page.getByText(/index\.ts/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/flag = true/i).first()).toBeVisible();
  });

  test('terminal connects to a live shell', async ({ page }) => {
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('live')).toBeVisible({ timeout: 10000 });
  });
});