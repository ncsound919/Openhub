import crypto from 'node:crypto';
import type { Request } from 'express';

/** Path whose raw bytes must be preserved for HMAC verification. */
export const GITHUB_WEBHOOK_PATH = '/api/github/webhook';

/**
 * body-parser `verify` hook for the *global* `express.json()`.
 *
 * Why the global parser and not the route's: the global parser is mounted
 * first, and body-parser short-circuits on `req._body`, so a route-level
 * parser's `verify` never runs — the raw bytes would never be captured and the
 * webhook would reject every request. This hook stashes the raw buffer for the
 * webhook path only, so nothing else pays the memory cost.
 */
export function captureWebhookRawBody(req: Request, _res: unknown, buf: Buffer): void {
  const path = String(req.originalUrl || '').split('?')[0];
  if (path === GITHUB_WEBHOOK_PATH) {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
}

/** Constant-time compare of `x-hub-signature-256` against HMAC-SHA256(raw). */
export function verifyGitHubSignature(raw: Buffer | undefined, secret: string, header: string): boolean {
  if (!raw || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
