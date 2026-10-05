import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { authenticatedHeaders, authenticatedMutationHeaders, sharedCredentials } from '../helpers/auth';

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');
const repoName = 'context-repository-test';

test.describe.serial('Active project repository access', () => {
  let username: string;
  let repoId: string;

  test.beforeAll(() => {
    ({ username } = sharedCredentials());
  });

  test('selects an owned local repository as the active project', async ({ page }) => {
    const create = await page.context().request.post('/api/repos', {
      data: { name: repoName, description: 'Active project E2E worktree', isPrivate: false },
      headers: await authenticatedMutationHeaders(page),
    });
    if (!create.ok()) throw new Error(`create repo failed: ${create.status()} ${await create.text()}`);
    repoId = (await create.json()).id;

    const repoDir = path.join(REPOS_ROOT, username, repoName);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Active project\n');

    const headers = await authenticatedMutationHeaders(page);
    let select = await page.context().request.post('/api/project/active', { data: { repoId }, headers });
    if (select.status() === 409) {
      // Single-project model: another spec may already hold an active project.
      await page.context().request.delete('/api/project/active', { headers });
      select = await page.context().request.post('/api/project/active', { data: { repoId }, headers });
    }
    expect(select.ok()).toBeTruthy();
    expect((await select.json()).project.repositoryName).toBe(repoName);
  });

  test('exposes the selected project in the workspace', async ({ page }) => {
    await page.goto('/workspace');
    await expect(page.getByText(repoName).first()).toBeVisible();
    await expect(page.getByText('README.md', { exact: true })).toBeVisible();
  });

  test('reads the selected project through the context-bound file API', async ({ page }) => {
    const headers = await authenticatedHeaders(page);
    const contents = await page.context().request.get('/api/project/active/contents?path=README.md', { headers });
    expect(contents.ok()).toBeTruthy();
    const file = await contents.json();
    expect(file.content).toBe('# Active project\n');

    const unload = await page.context().request.delete('/api/project/active', {
      headers: await authenticatedMutationHeaders(page),
    });
    expect(unload.ok()).toBeTruthy();
  });
});
