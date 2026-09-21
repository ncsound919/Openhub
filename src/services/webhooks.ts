import { createHmac } from 'crypto';
import { getDb } from '../auth/db.js';

export interface Webhook {
  id: string;
  user_id: string;
  url: string;
  secret: string | null;
  events: string[];
  active: boolean;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, any>;
}

export async function fireWebhook(userId: string, event: string, data: Record<string, any>): Promise<void> {
  const db = getDb();
  const webhooks = db.prepare(
    "SELECT * FROM webhooks WHERE user_id = ? AND active = 1 AND (events = '[]' OR events LIKE ?)"
  ).all(userId, `%${event}%`) as Webhook[];

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  for (const hook of webhooks) {
    const eventsStr = (hook as any).events || '[]';
    const allowedEvents = typeof eventsStr === 'string' ? JSON.parse(eventsStr) : eventsStr;

    // Skip if event not in allowed list (when events is not ['*'])
    if (allowedEvents.length > 0 && !allowedEvents.includes('*')) {
      if (!allowedEvents.includes(event)) continue;
    }

    sendWebhook(hook, payload).catch((err) => {
      console.warn(`[Webhook] Failed to send to ${hook.url}:`, err.message);
    });
  }
}

/** Fire exactly one webhook by id (owner-checked by the caller). Used by the
 *  "test webhook" endpoint so testing one hook does not blast every hook. */
export async function fireSingleWebhook(hook: Webhook, event: string, data: Record<string, any>): Promise<void> {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  await sendWebhook(hook, payload);
}

/** Outbound webhook targets are operator-supplied, so they are an SSRF sink
 *  unless constrained. Reject non-http(s) schemes and, by default, any address
 *  that resolves to loopback / private / link-local space. Set
 *  OPENHUB_WEBHOOK_ALLOW_PRIVATE=1 to deliberately target a local receiver. */
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|\[::1\]|fc[0-9a-f]{2}:|fe80:)/i;

/** Loopback/private outbound targets are refused unless the operator opts in.
 *  One switch for every server-initiated fetch driven by request input. */
function privateOutboundAllowed(): boolean {
  return process.env.OPENHUB_WEBHOOK_ALLOW_PRIVATE === '1' || process.env.OPENHUB_ALLOW_PRIVATE_FETCH === '1';
}

/** Guard for any server-initiated fetch whose target comes from request input
 *  (webhooks, API Studio, SEO audit). Rejects non-http(s) schemes and, by
 *  default, loopback / private / link-local addresses — the SSRF sink. */
export function assertOutboundUrlAllowed(rawUrl: string, label = 'outbound URL'): void {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error(`${label} is not a valid absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} scheme "${url.protocol}" is not allowed (http/https only)`);
  }
  if (privateOutboundAllowed()) return;
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    throw new Error(`${label} points at a loopback/private host (set OPENHUB_ALLOW_PRIVATE_FETCH=1 to allow)`);
  }
}

export function assertWebhookUrlAllowed(rawUrl: string): void {
  assertOutboundUrlAllowed(rawUrl, 'webhook URL');
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` that validates EVERY hop. Plain `fetch` with `redirect: 'follow'`
 * silently follows a 30x into loopback/private space, so a public URL the
 * caller controls (or a public site that redirects) can still reach internal
 * services — the initial-URL-only guard is trivially bypassed. This follows
 * redirects manually, re-running the SSRF guard on each Location before
 * requesting it, and preserves method semantics (303 and 301/302 on a
 * non-GET/HEAD become GET with the body dropped; 307/308 keep both).
 */
export async function fetchWithUrlGuard(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; label?: string } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const label = opts.label ?? 'outbound URL';
  let current = new URL(String(rawUrl)).toString();
  let method = String(init.method ?? 'GET').toUpperCase();
  let body = init.body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertOutboundUrlAllowed(current, label);
    const res = await fetch(current, { ...init, method, body, redirect: 'manual' });
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    current = new URL(location, current).toString();
  }
  throw new Error(`${label} exceeded ${maxRedirects} redirects`);
}

async function sendWebhook(hook: Webhook, payload: WebhookPayload): Promise<void> {
  assertWebhookUrlAllowed(hook.url);
  const body = JSON.stringify(payload);
  const signature = hook.secret
    ? createHmac('sha256', hook.secret).update(body).digest('hex')
    : undefined;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'OpenHub-Webhook/1.0',
    'X-Webhook-Event': payload.event,
  };

  if (signature) {
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  const res = await fetch(hook.url, {
    method: 'POST',
    headers,
    body,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
}
