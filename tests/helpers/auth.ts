import { type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const credsFile = path.join(process.cwd(), 'playwright', '.auth', 'credentials.json');

export async function getCsrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(c => c.name.includes('csrf-token'));
  return csrf?.value ?? '';
}

export function mutationHeaders(csrfToken: string, _accessToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
  };
}

/**
 * Session auth is carried by HttpOnly cookies in the page context (the browser
 * no longer keeps tokens in JS), and `page.context().request` shares those
 * cookies automatically. Navigate first so the context is primed before the
 * first API call, then return no auth headers of our own.
 */
export async function authenticatedHeaders(page: Page): Promise<Record<string, string>> {
  if (page.url() === 'about:blank') await page.goto('/');
  return {};
}

/** Build the same mutation credentials used by the browser application. */
export async function authenticatedMutationHeaders(page: Page): Promise<Record<string, string>> {
  await page.goto('/');
  return mutationHeaders(await getCsrfToken(page));
}

/** Navigate to login and authenticate. Handles already-authenticated state gracefully. */
export async function ensureLoggedIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');

  // Wait for auth state to settle: either redirected to dashboard, or login form is stable
  try {
    await page.waitForFunction(
      () => window.location.pathname === '/' || document.querySelector('form'),
      { timeout: 5000 }
    );
  } catch {
    // still loading — shouldn't happen, but proceed
  }

  if (page.url().endsWith('/')) return;

  await page.getByPlaceholder('dev@localhost').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.locator('form').getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('/');
}

export interface SharedCredentials {
  email: string;
  password: string;
  username: string;
}

export function sharedCredentials(): SharedCredentials {
  if (!fs.existsSync(credsFile)) {
    throw new Error('Shared credentials not found. Run auth.setup.ts first.');
  }
  return JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
}
