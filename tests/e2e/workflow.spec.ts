import { test, expect } from '@playwright/test';
import { authenticatedMutationHeaders } from '../helpers/auth';

const primaryRepo = 'active-project-primary';
const secondaryRepo = 'active-project-secondary';

test.describe.serial('Active-project selection workflow', () => {
  test('requires an explicit unload before another repository can be selected', async ({ page }) => {
    const headers = await authenticatedMutationHeaders(page);
    const primary = await page.context().request.post('/api/repos', {
      data: { name: primaryRepo, description: 'Primary context test repository', isPrivate: false },
      headers,
    });
    if (!primary.ok()) throw new Error(`create primary repo failed: ${primary.status()} ${await primary.text()}`);
    const primaryId = (await primary.json()).id;

    const secondary = await page.context().request.post('/api/repos', {
      data: { name: secondaryRepo, description: 'Secondary context test repository', isPrivate: false },
      headers: await authenticatedMutationHeaders(page),
    });
    expect(secondary.ok()).toBeTruthy();
    const secondaryId = (await secondary.json()).id;

    const selectedPrimary = await (async () => {
      const h = await authenticatedMutationHeaders(page);
      let s = await page.context().request.post('/api/project/active', { data: { repoId: primaryId }, headers: h });
      if (s.status() === 409) {
        // Single-project model: another spec may already hold an active project.
        await page.context().request.delete('/api/project/active', { headers: h });
        s = await page.context().request.post('/api/project/active', { data: { repoId: primaryId }, headers: h });
      }
      return s;
    })();
    expect(selectedPrimary.ok()).toBeTruthy();

    const blocked = await page.context().request.post('/api/project/active', {
      data: { repoId: secondaryId },
      headers: await authenticatedMutationHeaders(page),
    });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).code).toBe('ACTIVE_PROJECT_EXISTS');

    const unloaded = await page.context().request.delete('/api/project/active', {
      headers: await authenticatedMutationHeaders(page),
    });
    expect(unloaded.ok()).toBeTruthy();

    const selectedSecondary = await page.context().request.post('/api/project/active', {
      data: { repoId: secondaryId },
      headers: await authenticatedMutationHeaders(page),
    });
    expect(selectedSecondary.ok()).toBeTruthy();
    expect((await selectedSecondary.json()).project.repoId).toBe(secondaryId);

    const finalUnload = await page.context().request.delete('/api/project/active', {
      headers: await authenticatedMutationHeaders(page),
    });
    expect(finalUnload.ok()).toBeTruthy();
  });
});
