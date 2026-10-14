import { test, expect, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { authenticatedMutationHeaders, sharedCredentials } from '../helpers/auth';

// E2E for Axiom's Monaco providers (src/ide/monacoProviders.ts), which had unit
// coverage but no browser verification. The Axiom upstream may not be running in
// CI, so these specs mock the OpenHub proxy boundary (/api/axiom/editor/*) and
// assert the full browser path: provider registration -> proxy call -> Monaco
// ghost text / suggest widget / selection replacement.

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');
const repoName = 'monaco-providers-test';
const FILE = 'index.ts';

test.describe.serial('Axiom Monaco providers', () => {
  let username = '';

  test.beforeAll(() => {
    ({ username } = sharedCredentials());
  });

  // The streaming lane exists now and Axiom may be live in this environment.
  // Force the non-stream fallback so these specs deterministically exercise the
  // mocked `/api/axiom/editor/complete` proxy boundary.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/axiom/editor/complete-stream', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"error","message":"stream disabled in e2e"}\n\n',
      }));
  });

  test('loads a project with an editable file', async ({ page }) => {
    const headers = await authenticatedMutationHeaders(page);
    const res = await page.context().request.post('/api/repos', {
      data: { name: repoName, description: 'Monaco providers e2e', isPrivate: false },
      headers,
    });
    let repoId: string;
    if (res.ok()) {
      repoId = (await res.json()).id as string;
    } else {
      // 409 when the worktree already exists (e.g. a serial retry) — reuse it.
      const list = await page.context().request.get('/api/repos', { headers });
      const match = ((await list.json()).data as Array<{ id: string; name: string }>)
        .find((r) => r.name === repoName);
      expect(match, `repo ${repoName} should exist after a 409`).toBeTruthy();
      repoId = match!.id;
    }

    const repoDir = path.join(REPOS_ROOT, username, repoName);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, FILE), 'export const answer = 1;\n');

    const select = await page.context().request.post('/api/project/active', { data: { repoId }, headers });
    if (select.status() === 409) {
      await page.context().request.delete('/api/project/active', { headers });
      const retry = await page.context().request.post('/api/project/active', { data: { repoId }, headers });
      expect(retry.ok()).toBeTruthy();
    } else {
      expect(select.ok()).toBeTruthy();
    }
  });

  // Monaco renders same-line inline completions as an injected `after` text with
  // class `ghost-text-decoration`; `ghost-text` is only used for extra lines.
  function ghostText(editor: Locator) {
    return editor.locator('.ghost-text-decoration, .ghost-text-decoration-preview, .ghost-text');
  }

  async function openEditor(page: Page) {
    await page.goto('/workspace');
    await page.waitForURL('/workspace');
    const file = page.getByTitle(FILE, { exact: true }).first();
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.dblclick();
    const editor = page.locator('.monaco-editor').first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await editor.locator('.view-lines').click();
    return editor;
  }

  test('inline completion (Tab) inserts local-model text', async ({ page }) => {
    let completeRequests = 0;
    await page.route('**/api/axiom/editor/complete', async (route) => {
      completeRequests += 1;
      await route.fulfill({ json: { ok: true, data: { ok: true, text: ' return 42;', source: 'local-model' } } });
    });

    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nfunction sq(n: number) {', { delay: 25 });

    // Monaco splits the injected completion into token spans, so read the line
    // text rather than a single `.ghost-text-decoration` node.
    await expect(editor.locator('.view-lines')).toContainText('return 42;', { timeout: 10000 });
    await expect(ghostText(editor).first()).toBeAttached();
    expect(completeRequests).toBeGreaterThan(0);

    await page.keyboard.press('Tab');
    // Tab commits the completion: the injected ghost text is gone.
    await expect(ghostText(editor)).toHaveCount(0);
    await expect(editor.locator('.view-lines')).toContainText('return 42;');
  });

  test('inline completion stays silent when the model is unavailable', async ({ page }) => {
    let completeRequests = 0;
    await page.route('**/api/axiom/editor/complete', async (route) => {
      completeRequests += 1;
      await route.fulfill({ json: { ok: true, data: { ok: true, source: 'none' } } });
    });

    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nfunction add(a, b) {', { delay: 25 });
    await expect.poll(() => completeRequests, { timeout: 10000 }).toBeGreaterThan(0);

    await page.waitForTimeout(500);
    await expect(ghostText(editor)).toHaveCount(0);
  });

  test('@-mention completion lists project files from the Axiom index', async ({ page }) => {
    let indexRequests = 0;
    await page.route('**/api/axiom/editor/index', async (route) => {
      indexRequests += 1;
      await route.fulfill({
        json: { ok: true, data: { ok: true, entries: [{ path: 'src/utils.ts' }, { path: 'README.md' }] } },
      });
    });


    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    // The editor is controlled by React, so type with a delay and assert the
    // trigger landed before expecting the widget.
    await page.keyboard.type('\n// mention ', { delay: 30 });
    await page.keyboard.type('@', { delay: 100 });
    await expect(editor.locator('.view-lines')).toContainText('mention @');
    await page.keyboard.press('Control+Space');
    await expect.poll(() => indexRequests, { timeout: 10000 }).toBeGreaterThan(0);

    const widget = page.locator('.suggest-widget');
    await expect(widget).toBeVisible({ timeout: 10000 });
    await expect(widget).toContainText('src/utils.ts');
    await expect(editor).toBeVisible();
  });

  test('Ctrl+Right partially accepts the ghost text word-by-word', async ({ page }) => {
    await page.route('**/api/axiom/editor/complete', async (route) => {
      await route.fulfill({ json: { ok: true, data: { ok: true, text: ' return 42;', source: 'local-model' } } });
    });

    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nfunction sq(n: number) {', { delay: 25 });
    await expect(editor.locator('.view-lines')).toContainText('return 42;', { timeout: 10000 });
    await expect(ghostText(editor).first()).toBeAttached();

    // Word-by-word accept (Cursor parity): the first word becomes real text.
    await page.keyboard.press('Control+ArrowRight');
    // Dismiss whatever ghost remainder Monaco still shows, then the accepted
    // word must survive as real buffer text while the rest is gone.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(editor.locator('.view-lines')).toContainText('return');
    await expect(editor.locator('.view-lines')).not.toContainText('42;');
  });

  test('Ctrl+I inline edit replaces the selection', async ({ page }) => {
    await page.route('**/api/axiom/editor/inline-edit', async (route) => {
      await route.fulfill({
        json: { ok: true, data: { ok: true, text: 'export const answer = 42;', source: 'local-model' } },
      });
    });

    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+A');

    // Ctrl+I opens an inline instruction widget (no blocking window.prompt).
    await page.keyboard.press('Control+I');
    const instruction = page.locator('.axiom-inline-instruction input');
    await expect(instruction).toBeVisible({ timeout: 5000 });
    await instruction.fill('set it to 42');
    await instruction.press('Enter');

    await expect(editor.locator('.view-lines')).toContainText('export const answer = 42;');
  });

  test('Ctrl+I inline edit can be rejected via undo (accept = keep, reject = undo)', async ({ page }) => {
    await page.route('**/api/axiom/editor/inline-edit', async (route) => {
      await route.fulfill({
        json: { ok: true, data: { ok: true, text: 'export const answer = 43;', source: 'local-model' } },
      });
    });

    const editor = await openEditor(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+A');

    await page.keyboard.press('Control+I');
    const instruction = page.locator('.axiom-inline-instruction input');
    await expect(instruction).toBeVisible({ timeout: 5000 });
    await instruction.fill('set it to 43');
    await instruction.press('Enter');

    await expect(editor.locator('.view-lines')).toContainText('export const answer = 43;');

    // Reject is one undo: the edit was bracketed by pushUndoStop, so a single
    // undo restores the exact pre-edit buffer (single-hunk accept/reject).
    await page.keyboard.press('Control+Z');
    await expect(editor.locator('.view-lines')).toContainText('export const answer = 1;');
  });
});
