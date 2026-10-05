import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { authenticatedMutationHeaders, sharedCredentials } from '../helpers/auth';

/**
 * Workspace button audit: click every primary control on /workspace and verify
 * an observable response. Soft assertions throughout so a single dead button
 * does not abort the audit — the report lists every failure at the end.
 *
 * Classification: a control that throws a page error or gives NO feedback is a
 * UI bug. A control that cleanly reports a backend failure (service offline,
 * no remote, no git repo) is working-as-designed and is asserted as such.
 */

const REPOS_ROOT = path.join(process.env.USERPROFILE || 'C:/Users/User', 'Documents', 'openhub', 'repos');
const repoName = 'workspace-audit';

const pageErrors: string[] = [];
const badRequests: string[] = [];

/** The sidebar shows the agent panel by default; files only render in explorer. */
async function showExplorer(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel('Workspace panel').selectOption('explorer');
}

test.describe.serial('Workspace button audit', () => {
  let username: string;
  let repoId: string;
  let repoDir: string;

  test.beforeAll(async ({ browser }) => {
    ({ username } = sharedCredentials());
    const ctx = await browser.newContext({ storageState: './playwright/.auth/user.json' });
    const api = await ctx.newPage();
    await api.goto('/');
    const headers = await authenticatedMutationHeaders(api);
    // Clean slate: delete a previous audit repo dir if present.
    repoDir = path.join(REPOS_ROOT, username, repoName);
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* fresh */ }
    const listRes = await api.context().request.get('/api/repos', { headers });
    const listBody = (await listRes.json().catch(() => ({}))) as { data?: Array<{ id: string; name: string }>; repos?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
    const existing = (Array.isArray(listBody) ? listBody : (listBody.data || listBody.repos || [])).find((r) => r.name === repoName);
    if (existing) {
      repoId = existing.id;
    } else {
      const res = await api.context().request.post('/api/repos', {
        data: { name: repoName, description: 'Workspace button audit repo', isPrivate: false },
        headers,
      });
      if (!res.ok()) throw new Error(`could not create the audit repo (HTTP ${res.status()})`);
      repoId = (await res.json()).id;
    }
    // Real files + a real git repo so git/typecheck/diff controls are exercisable.
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export function hello(): string {\n  return "Hello from audit!";\n}\n');
    fs.writeFileSync(path.join(repoDir, 'src', 'utils.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'audit', private: true, version: '1.0.0' }, null, 2));
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repoDir });
    const select = await api.context().request.post('/api/project/active', { data: { repoId }, headers });
    if (select.status() === 409) {
      await api.context().request.delete('/api/project/active', { headers });
      const retry = await api.context().request.post('/api/project/active', { data: { repoId }, headers });
      expect(retry.ok()).toBeTruthy();
    } else {
      expect(select.ok()).toBeTruthy();
    }
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err).slice(0, 300)));
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('/api/auth/')) {
        badRequests.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`.slice(0, 160));
      }
    });
    await page.goto('/workspace');
    await page.waitForURL('/workspace');
    await expect(page.getByText(repoName).first()).toBeVisible({ timeout: 15000 });
  });

  async function openFile(page: import('@playwright/test').Page, title: string): Promise<void> {
    await showExplorer(page);
    // FileTree rows carry title=<relative path>. Expand parent dirs first
    // (single click toggles a dir); files open on double-click.
    const parts = title.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      await page.getByTitle(prefix, { exact: true }).first().click({ timeout: 8000 });
    }
    await page.getByTitle(title, { exact: true }).first().dblclick({ timeout: 8000 });
    await expect.soft(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 12000 });
  }

  test('explorer opens a file into an editor tab', async ({ page }) => {
    await test.step('double-click index.ts from explorer', async () => {
      await openFile(page, 'index.ts');
      await expect.soft(page.locator('.monaco-editor .view-lines').first()).toContainText('Hello from audit!', { timeout: 8000 });
    });
  });

  test('edit + Save persists', async ({ page }) => {
    await openFile(page, 'index.ts');
    // Focus via the rendered lines (Monaco's hidden textarea isn't clickable),
    // then wait for the editor to actually take focus before typing. Retry the
    // keystrokes once if the first attempt missed focus.
    const lines = page.locator('.monaco-editor .view-lines').first();
    await lines.click({ timeout: 8000 });
    await expect.soft(page.locator('.monaco-editor.focused').first()).toBeVisible({ timeout: 8000 });
    await page.keyboard.press('End');
    await page.keyboard.type('\n// audit touch\n');
    if (!(await lines.innerText().then((t) => t.includes('audit touch')).catch(() => false))) {
      await lines.click({ timeout: 8000 });
      await page.keyboard.press('End');
      await page.keyboard.type('\n// audit touch\n');
    }
    await test.step('Save button writes the buffer', async () => {
      await page.getByRole('button', { name: 'Save' }).click();
      await expect.soft(page.getByText('Saved').first()).toBeVisible({ timeout: 10000 });
    });
    await test.step('content lands on disk', async () => {
      const onDisk = fs.readFileSync(path.join(repoDir, 'index.ts'), 'utf8');
      expect.soft(onDisk).toContain('audit touch');
    });
  });

  test('New file prompts for a path and creates it', async ({ page }) => {
    // Root-level path: visible in the tree without expanding folders. Clear any
    // leftover from a prior run first so a 409 cannot mask the result.
    try { fs.rmSync(path.join(repoDir, 'audit-new.ts'), { force: true }); } catch { /* fresh */ }
    try { fs.rmSync(path.join(repoDir, 'src', 'audit-new.ts'), { force: true }); } catch { /* fresh */ }
    await test.step('New file button (accept the path prompt)', async () => {
      await showExplorer(page);
      page.once('dialog', (d) => void d.accept('audit-new.ts'));
      await page.getByRole('button', { name: 'New file' }).click();
      await expect.soft(page.getByTitle('audit-new.ts', { exact: true }).first()).toBeVisible({ timeout: 10000 });
    });
    await test.step('file lands on disk', async () => {
      expect.soft(fs.existsSync(path.join(repoDir, 'audit-new.ts'))).toBe(true);
      fs.rmSync(path.join(repoDir, 'audit-new.ts'), { force: true });
    });
  });

  test('panel switcher reaches git, problems, autonomy, outline', async ({ page }) => {
    const panel = page.getByLabel('Workspace panel');
    await test.step('panel: git', async () => {
      await panel.selectOption('git');
      await expect.soft(page.getByPlaceholder('Commit message')).toBeVisible({ timeout: 8000 });
    });
    await test.step('panel: problems', async () => {
      await panel.selectOption('problems');
      // Header carries a count ("Problems · N") so the switcher <option> can't shadow it.
      await expect.soft(page.getByText(/Problems ·/).first()).toBeVisible({ timeout: 8000 });
    });
    await test.step('panel: autonomy', async () => {
      await panel.selectOption('autonomy');
      await expect.soft(page.getByText('Drift vs last push')).toBeVisible({ timeout: 8000 });
    });
    await test.step('panel: outline', async () => {
      await panel.selectOption('outline');
      // Header carries a count ("Outline · N") so the switcher <option> can't
      // shadow it; the body shows the empty state when no file is open.
      await expect.soft(page.getByText(/Outline ·/).first()).toBeVisible({ timeout: 8000 });
    });
    await panel.selectOption('explorer');
  });

  test('Terminal opens and closes', async ({ page }) => {
    await test.step('open terminal', async () => {
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect.soft(page.getByRole('button', { name: 'Close terminal' })).toBeVisible({ timeout: 10000 });
    });
    await test.step('close terminal', async () => {
      await page.getByRole('button', { name: 'Close terminal' }).click();
      await expect.soft(page.getByRole('button', { name: 'Close terminal' })).toBeHidden({ timeout: 8000 });
    });
  });

  test('Copilot toggles open', async ({ page }) => {
    await test.step('open copilot', async () => {
      await page.getByRole('button', { name: 'Toggle Axiom chat' }).click();
      await expect.soft(page.getByText(/Ask Axiom|Dev Co-Pilot|Copilot/i).first()).toBeVisible({ timeout: 8000 });
    });
  });

  test('Diff review opens for a changed file and returns to Edit', async ({ page }) => {
    // Make a tracked file dirty so the Diff control appears.
    fs.appendFileSync(path.join(repoDir, 'src', 'utils.ts'), '\n// dirty\n');
    await page.reload();
    await page.waitForURL('/workspace');
    await openFile(page, 'src/utils.ts');
    await test.step('open diff', async () => {
      await page.getByRole('button', { name: 'Diff' }).click({ timeout: 8000 });
      await expect.soft(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 10000 });
    });
    await test.step('back to edit', async () => {
      await page.getByRole('button', { name: 'Edit' }).click();
      await expect.soft(page.getByRole('button', { name: 'Diff' })).toBeVisible({ timeout: 8000 });
    });
    execSync('git checkout -- src/utils.ts', { cwd: repoDir });
  });

  test('Branch create + switch round-trips', async ({ page }) => {
    const orig = execSync('git branch --show-current', { cwd: repoDir }).toString().trim() || 'master';
    try { execSync('git branch -D audit-branch', { cwd: repoDir, stdio: 'ignore' }); } catch { /* fresh */ }
    await page.getByLabel('Workspace panel').selectOption('git');
    // The toggle's accessible name is the branch text itself; select by title.
    const menu = () => page.getByTitle('Switch branch');
    await test.step('branch menu opens', async () => {
      await menu().click();
      await expect.soft(page.getByPlaceholder('New branch…')).toBeVisible({ timeout: 8000 });
    });
    await test.step('create audit-branch (New button)', async () => {
      await page.getByPlaceholder('New branch…').fill('audit-branch');
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes('audit-branch'),
        { timeout: 12000 },
      ).catch(() => {});
      const listed = execSync('git branch --list audit-branch', { cwd: repoDir }).toString().trim();
      expect.soft(listed).toContain('audit-branch');
    });
    await test.step('switch branches via the menu', async () => {
      const current = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
      const target = current === 'audit-branch' ? orig : 'audit-branch';
      await menu().click();
      await page.getByRole('button', { name: target, exact: true }).first().click({ timeout: 8000 });
      await expect.soft(menu()).toContainText(target, { timeout: 12000 });
    });
    try {
      const cur = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
      if (cur === 'audit-branch') execSync(`git checkout -q ${orig}`, { cwd: repoDir });
      execSync('git branch -D audit-branch', { cwd: repoDir, stdio: 'ignore' });
    } catch { /* best-effort cleanup */ }
  });

  test('Commit records a change; Push reports no-remote cleanly', async ({ page }) => {
    fs.appendFileSync(path.join(repoDir, 'src', 'utils.ts'), '\n// commit me\n');
    await page.reload();
    await page.waitForURL('/workspace');
    await page.getByLabel('Workspace panel').selectOption('git');
    await test.step('commit with a message (accept the confirm)', async () => {
      await page.getByPlaceholder('Commit message').fill('audit commit');
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('button', { name: 'Commit' }).click();
      await expect.soft(page.getByPlaceholder('Commit message')).toHaveValue('', { timeout: 15000 });
    });
    await test.step('push without a remote is disabled with a reason', async () => {
      const push = page.getByRole('button', { name: 'Push' });
      await expect.soft(push).toBeDisabled();
      await expect.soft(push).toHaveAttribute('title', /No origin remote/);
    });
    execSync('git reset --hard -q HEAD', { cwd: repoDir });
  });

  test('Drift re-scan and typecheck complete', async ({ page }) => {
    await test.step('drift re-scan finishes', async () => {
      await page.getByLabel('Workspace panel').selectOption('autonomy');
      await page.getByRole('button', { name: 'Re-scan drift' }).click({ timeout: 8000 });
      await expect.soft(page.getByText(/Scanning local vs origin|No remote|in sync|uncommitted|ahead|behind/i).first()).toBeVisible({ timeout: 20000 });
    });
    await test.step('typecheck runs to a verdict', async () => {
      await page.getByLabel('Workspace panel').selectOption('problems');
      const runBtn = page.getByRole('button', { name: 'Run typecheck' });
      await runBtn.click({ timeout: 8000 });
      // The run finishes when the button re-enables (proves it didn't hang).
      await expect.soft(runBtn).toBeEnabled({ timeout: 90000 });
      // Clean fixture repo → an explicit clean verdict (exact text avoids the
      // switcher <option> shadow).
      await expect.soft(page.getByText('No problems.', { exact: true })).toBeVisible({ timeout: 10000 });
    });
  });

  test('Autopilot starts a job and cancels cleanly', async ({ page }) => {
    await test.step('Run Autopilot creates a running job', async () => {
      await page.getByRole('button', { name: 'Run Autopilot' }).click();
      await expect.soft(page.getByText(/Running|running|%|pending|typecheck/i).first()).toBeVisible({ timeout: 20000 });
    });
    await test.step('Cancel stops it', async () => {
      const cancel = page.getByRole('button', { name: /Cancel/ }).first();
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click();
        await expect.soft(page.getByText(/cancell/i).first()).toBeVisible({ timeout: 20000 });
      }
    });
  });

  test('Quick open finds and opens a file (Ctrl+P)', async ({ page }) => {
    await test.step('quick open dialog', async () => {
      await page.keyboard.press('Control+p');
      await expect.soft(page.getByRole('dialog', { name: 'Quick open files' })).toBeVisible({ timeout: 8000 });
    });
    await test.step('search + open index.ts', async () => {
      // Plain text input (textbox role), not searchbox.
      await page.getByLabel('Search files').fill('index.ts');
      await page.getByText('index.ts').first().click({ timeout: 8000 });
      await expect.soft(page.locator('.monaco-editor .view-lines').first()).toContainText('Hello from audit!', { timeout: 10000 });
    });
  });

  test.afterAll(() => {
    const uniqBad = [...new Set(badRequests)].slice(0, 30);
    // eslint-disable-next-line no-console
    console.log(`\n[workspace-audit] pageerrors(${pageErrors.length}): ${JSON.stringify([...new Set(pageErrors)].slice(0, 10))}`);
    // eslint-disable-next-line no-console
    console.log(`[workspace-audit] failing requests(${uniqBad.length}): ${JSON.stringify(uniqBad)}`);
  });
});
