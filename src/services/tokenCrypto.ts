import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * At-rest encryption for stored third-party credentials (GitHub OAuth/PAT
 * tokens in `github_integrations.access_token`).
 *
 * AES-256-GCM. Stored form: `enc:v1:<iv>:<tag>:<ciphertext>` (base64url parts).
 *
 * Key resolution, in order:
 *   1. OPENHUB_TOKEN_KEY — 32 bytes, as 64 hex chars or base64.
 *   2. HKDF-SHA256 over a stable server secret: the value registered with
 *      `setTokenKeyFallbackSecret()` (server.ts passes the resolved access-token
 *      secret, which may come from the fallback key file), else
 *      ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET, else the persistent
 *      fallback key file the server generates. A one-time warning is logged:
 *      rotating that secret makes stored tokens unreadable.
 *   3. As a last resort, a random per-process key (tokens written this way do
 *      not survive a restart). Only reachable when no secret exists at all.
 *
 * Legacy plaintext values pass through `decryptToken` unchanged and are
 * re-encrypted the next time they are written.
 */

export const TOKEN_PREFIX = 'enc:v1:';

let fallbackSecret: string | null = null;
let cachedKey: Buffer | null = null;
let cachedFingerprint: string | null = null;
let warned = false;
let processKey: Buffer | null = null;

/** Register the server's resolved signing secret as the HKDF input. */
export function setTokenKeyFallbackSecret(secret: string | null | undefined): void {
  fallbackSecret = secret && secret.length > 0 ? secret : null;
  cachedKey = null;
  cachedFingerprint = null;
}

function parseExplicitKey(raw: string): Buffer {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  throw new Error('OPENHUB_TOKEN_KEY must be 32 bytes encoded as 64 hex characters or base64');
}

function fileFallbackSecret(env: NodeJS.ProcessEnv): string | null {
  try {
    const dir = env.OPENHUB_KEY_DIR || path.join(os.homedir(), '.openhub');
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'emergency-keys.json'), 'utf-8'));
    return typeof parsed?.access === 'string' && parsed.access.length >= 32 ? parsed.access : null;
  } catch {
    return null;
  }
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(message);
}

/** Resolve the 32-byte AES key. Exported for tests. */
export function resolveTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const explicit = env.OPENHUB_TOKEN_KEY;
  const fingerprint = `${explicit ?? ''}\u0000${fallbackSecret ?? ''}\u0000${env.ACCESS_TOKEN_SECRET ?? ''}\u0000${env.REFRESH_TOKEN_SECRET ?? ''}`;
  if (cachedKey && cachedFingerprint === fingerprint) return cachedKey;

  let key: Buffer;
  if (explicit && explicit.trim()) {
    key = parseExplicitKey(explicit);
  } else {
    const secret = fallbackSecret || env.ACCESS_TOKEN_SECRET || env.REFRESH_TOKEN_SECRET || fileFallbackSecret(env);
    if (secret) {
      warnOnce('[tokenCrypto] WARNING: OPENHUB_TOKEN_KEY is not set; deriving the token-encryption key from the server signing secret. '
        + 'Rotating that secret will make stored GitHub tokens unreadable. Set OPENHUB_TOKEN_KEY (32 bytes, hex or base64).');
      key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('openhub-token-key'), Buffer.from('github-token-v1'), 32));
    } else {
      warnOnce('[tokenCrypto] WARNING: no OPENHUB_TOKEN_KEY and no server secret; using a per-process key. Stored tokens will not survive a restart.');
      processKey ??= crypto.randomBytes(32);
      key = processKey;
    }
  }
  cachedKey = key;
  cachedFingerprint = fingerprint;
  return key;
}

export function isEncryptedToken(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

/** Encrypt a token for storage. Already-encrypted values are returned as-is. */
export function encryptToken(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isEncryptedToken(plain)) return plain;
  const key = resolveTokenKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Decrypt a stored token. Legacy plaintext (no `enc:v1:` prefix) is returned
 * unchanged. Throws when an encrypted value cannot be authenticated (wrong key
 * or tampered data).
 */
export function decryptToken(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isEncryptedToken(stored)) return stored;
  const parts = stored.slice(TOKEN_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed encrypted token');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ct = Buffer.from(ctB64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveTokenKey(env), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
