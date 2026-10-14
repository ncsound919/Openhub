import { createHmac } from 'crypto';
import { getDb } from '../auth/db.js';
import net from 'node:net';
import { guardedFetch, isBlockedAddress, isMetadataHost, privateUrlsAllowed } from './ssrfGuard.js';

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

/**
 * Fire an event to EVERY active webhook across all users. Used for system-wide
 * alerts (e.g. `alert.raised`) where there is no single owning user. Respects
 * each hook's event filter the same way `fireWebhook` does. Best-effort.
 */
export async function fireWebhookAll(event: string, data: Record<string, any>): Promise<void> {
  const db = getDb();
  let webhooks: Webhook[] = [];
  try {
    webhooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all() as Webhook[];
  } catch {
    return;
  }
  const payload: WebhookPayload = { event, timestamp: new Date().toISOString(), data };
  for (const hook of webhooks) {
    const eventsStr = (hook as any).events || '[]';
    let allowedEvents: string[] = [];
    try { allowedEvents = typeof eventsStr === 'string' ? JSON.parse(eventsStr) : eventsStr; } catch { allowedEvents = []; }
    if (allowedEvents.length > 0 && !allowedEvents.includes('*') && !allowedEvents.includes(event)) continue;
    sendWebhook(hook, payload).catch((err) => {
      console.warn(`[Webhook] alert fanout to ${hook.url} failed:`, err.message);
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
  return privateUrlsAllowed();
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
  // Metadata endpoints stay blocked even when private targets are allowed.
  if (isMetadataHost(url.hostname)) {
    throw new Error(`${label} points at a cloud metadata endpoint (private address)`);
  }
  if (privateOutboundAllowed()) return;
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RE.test(url.hostname) || (net.isIP(bare) && isBlockedAddress(bare))) {
    throw new Error(`${label} points at a loopback/private host (set OPENHUB_ALLOW_PRIVATE_URLS=1 to allow)`);
  }
}

export function assertWebhookUrlAllowed(rawUrl: string): void {
  assertOutboundUrlAllowed(rawUrl, 'webhook URL');
}

/**
 * `fetch` that validates EVERY hop and pins the connection. The synchronous
 * hostname check above cannot see what a name resolves to, so this resolves
 * DNS, rejects private/loopback/link-local/metadata answers, pins the socket to
 * the vetted address (no rebinding between check and connect), and follows
 * redirects manually with the same checks on each Location. Method semantics:
 * 303 (and 301/302 on a non-GET/HEAD) become GET with the body dropped;
 * 307/308 keep both. See ssrfGuard.ts.
 */
export async function fetchWithUrlGuard(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; label?: string } = {},
): Promise<Response> {
  const label = opts.label ?? 'outbound URL';
  // Keep the cheap synchronous check first so obviously bad URLs fail before
  // any DNS traffic, with the same error text as before.
  assertOutboundUrlAllowed(String(rawUrl), label);
  return guardedFetch(String(rawUrl), init, { maxRedirects: opts.maxRedirects, label });
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

  const res = await fetchWithUrlGuard(hook.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
}
