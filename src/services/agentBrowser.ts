import { resolveSecret } from './keywire.js';

/**
 * AgentBrowser client — the fleet's authenticated browser (a real Comet profile
 * mirror), used to reach provider dashboards with the operator's live sessions.
 *
 * This is the credential-gate path from AGENTS.md: when a secret is not in
 * Keywire (or is a placeholder), authenticated provider access goes through
 * AgentBrowser instead of a guessed key.
 *
 * The vault is the source of truth for the *AgentBrowser* credential itself
 * (`AGENTBROWSER_API_KEY` / `AGENTBROWSER_URL`), resolved via Keywire with an env
 * fallback. The browser is ONE shared tab (architectural constraint), so every
 * call is serialized through a single promise chain.
 */

export interface AgentBrowserResult<T = unknown> {
  available: boolean;
  status?: number;
  data?: T;
  error?: string;
}

export type BrowserAction = 'launch' | 'navigate' | 'click' | 'fill' | 'screenshot' | 'get-content' | 'close' | 'execute';

/** Provider dashboard entry points used by the business command center. */
export const PROVIDER_URLS: Record<string, { url: string; label: string }> = {
  stripe: { url: 'https://dashboard.stripe.com/', label: 'Stripe' },
  github: { url: 'https://github.com/settings/profile', label: 'GitHub' },
  vercel: { url: 'https://vercel.com/dashboard', label: 'Vercel' },
  supabase: { url: 'https://supabase.com/dashboard/projects', label: 'Supabase' },
  google: { url: 'https://mail.google.com/mail/u/0/', label: 'Google Workspace' },
  cloudflare: { url: 'https://dash.cloudflare.com/', label: 'Cloudflare' },
};

const AB_TIMEOUT_MS = 120_000;

export function agentBrowserBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_AGENTBROWSER_URL || env.AGENTBROWSER_URL || 'http://127.0.0.1:3700').replace(/\/+$/, '');
}

/** Resolve the AgentBrowser API key from Keywire first, then env. Never invents one. */
export async function agentBrowserKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.AGENTBROWSER_API_KEY) return env.AGENTBROWSER_API_KEY;
  const { value } = await resolveSecret('AGENTBROWSER_API_KEY', env);
  return value || '';
}

// Serialize every call — the browser is a single shared tab.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function call<T>(
  path: string,
  body: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
): Promise<AgentBrowserResult<T>> {
  const key = await agentBrowserKey(env);
  if (!key) {
    return { available: false, error: 'no AGENTBROWSER_API_KEY (Keywire blank and env unset)' };
  }
  return serialize(async () => {
    try {
      const res = await fetch(`${agentBrowserBaseUrl(env)}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'X-Agent-Auth': key,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(AB_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => null)) as T;
      if (!res.ok) {
        const err = data && typeof data === 'object' && 'error' in data ? String((data as Record<string, unknown>).error) : `HTTP ${res.status}`;
        return { available: false, status: res.status, error: err };
      }
      return { available: true, status: res.status, data };
    } catch (err) {
      return { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Reachability + subsystem state (no auth required on this route). */
export async function agentBrowserStatus(env: NodeJS.ProcessEnv = process.env): Promise<AgentBrowserResult> {
  try {
    const res = await fetch(`${agentBrowserBaseUrl(env)}/api/system/health`, { signal: AbortSignal.timeout(4000) });
    const data = (await res.json().catch(() => null)) as unknown;
    return { available: res.ok, status: res.status, data };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function agentBrowserControl<T = unknown>(
  action: BrowserAction,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentBrowserResult<T>> {
  return call<T>('/api/browser-control', { action, ...extra }, env);
}

interface BrowserNavigateData {
  contentPreview?: string;
  visibleText?: string;
  html?: string;
}

function preview(data: BrowserNavigateData | null | undefined): string {
  const text = data?.contentPreview || data?.visibleText || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

/**
 * Open a URL in the live browser, launching it first if needed. Returns the
 * visible-text preview so a caller can read the authenticated page.
 */
export async function agentBrowserOpen(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentBrowserResult<{ url: string; preview: string; authenticated: boolean }>> {
  let nav = await agentBrowserControl<BrowserNavigateData>('navigate', { url }, env);
  if (!nav.available && /not launched/i.test(nav.error || '')) {
    const launch = await agentBrowserControl('launch', { config: { headless: false, useRealChrome: true } }, env);
    if (!launch.available) return { available: false, error: launch.error || 'browser launch failed' };
    nav = await agentBrowserControl<BrowserNavigateData>('navigate', { url }, env);
  }
  if (!nav.available) return { available: false, status: nav.status, error: nav.error };
  const text = preview(nav.data);
  const authenticated = !/sign in to your account|log in to|create account|welcome back|continue with (email|google|github)/i.test(text);
  return { available: true, status: nav.status, data: { url, preview: text, authenticated } };
}

/** Build a provider dashboard URL from its id. */
export function providerUrl(providerId: string): string | null {
  return PROVIDER_URLS[providerId]?.url ?? null;
}
