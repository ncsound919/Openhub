// OIDC single sign-on (Authorization Code + PKCE) for OpenHub.
//
// The gap it closed: the only identities OpenHub accepted were local passwords
// and GitHub repo OAuth. There was no way for an org to authenticate users
// against its own IdP, and no directory-driven role mapping — a procurement
// blocker. This module is a dependency-free OIDC relying party: discovery,
// authorize-URL construction with PKCE, code exchange, ID-token verification
// against the IdP's JWKS (RS256), and group→role mapping.
//
// Honesty / security contract:
//   - The ID token is verified: RS256 signature via JWKS, `iss`, `aud`, `exp`,
//     and the `nonce` we generated. A token that fails any check is rejected.
//   - PKCE (S256) is always used; the verifier never leaves the process.
//   - Client secret and tokens are never logged.
//   - Unconfigured ⇒ `oidcConfig` returns null and no SSO route is enabled.

import crypto from 'crypto';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  /** ID-token / userinfo claim carrying group membership. */
  groupClaim: string;
  /** group name → OpenHub role. */
  groupRoleMap: Record<string, string>;
  /** Role applied when no group maps. */
  defaultRole: string;
}

export interface OidcDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/** Read OIDC config from env. Null when unconfigured (SSO stays off). */
export function oidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = (env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const clientId = (env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = (env.OIDC_CLIENT_SECRET || '').trim();
  if (!issuer || !clientId || !clientSecret) return null;
  let groupRoleMap: Record<string, string> = {};
  const raw = (env.OIDC_GROUP_ROLE_MAP || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v) groupRoleMap[k] = v;
    } catch { /* malformed map ignored — defaultRole applies */ }
  }
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: (env.OIDC_REDIRECT_URI || '').trim() || `${(env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/auth/sso/callback`,
    scope: (env.OIDC_SCOPE || 'openid email profile').trim(),
    groupClaim: (env.OIDC_GROUP_CLAIM || 'groups').trim() || 'groups',
    groupRoleMap,
    defaultRole: (env.OIDC_DEFAULT_ROLE || 'member').trim() || 'member',
  };
}

const discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** Fetch and cache the IdP discovery document. Throws on a non-OK response. */
export async function discoverOidc(cfg: OidcConfig, deps: OidcDeps = {}): Promise<OidcDiscovery> {
  const now = deps.now?.() ?? Date.now();
  const hit = discoveryCache.get(cfg.issuer);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.value;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OIDC discovery HTTP ${r.status}`);
  const j = (await r.json()) as Partial<OidcDiscovery>;
  if (!j.authorization_endpoint || !j.token_endpoint || !j.jwks_uri) throw new Error('OIDC discovery document is incomplete');
  const value: OidcDiscovery = {
    issuer: j.issuer ?? cfg.issuer,
    authorization_endpoint: j.authorization_endpoint,
    token_endpoint: j.token_endpoint,
    jwks_uri: j.jwks_uri,
    userinfo_endpoint: j.userinfo_endpoint,
    end_session_endpoint: j.end_session_endpoint,
  };
  discoveryCache.set(cfg.issuer, { at: now, value });
  return value;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  cfg: OidcConfig,
  disc: OidcDiscovery,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(disc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface OidcTokens {
  id_token?: string;
  access_token?: string;
  token_type?: string;
}

export async function exchangeCode(
  cfg: OidcConfig,
  disc: OidcDiscovery,
  code: string,
  codeVerifier: string,
  deps: OidcDeps = {},
): Promise<OidcTokens> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  // Client secret is sent via HTTP Basic when present (confidential client).
  if (cfg.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  const r = await fetchImpl(disc.token_endpoint, { method: 'POST', headers, body: body.toString() });
  if (!r.ok) throw new Error(`OIDC token exchange HTTP ${r.status}`);
  return (await r.json()) as OidcTokens;
}

interface Jwk { kid?: string; kty?: string; use?: string; alg?: string; n?: string; e?: string; [k: string]: unknown }

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Fetch the IdP's JWKS, cached. Uncached, every login — and every request
 *  carrying a token with an unknown `kid` — was an outbound fetch, which makes
 *  an unauthenticated callback endpoint into a request amplifier aimed at the
 *  IdP. */
async function fetchJwks(uri: string, deps: OidcDeps): Promise<Jwk[]> {
  const now = deps.now?.() ?? Date.now();
  const hit = jwksCache.get(uri);
  if (hit && now - hit.at < JWKS_TTL_MS) return hit.keys;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const r = await fetchImpl(uri, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OIDC JWKS HTTP ${r.status}`);
  const j = (await r.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(j.keys) ? j.keys : [];
  jwksCache.set(uri, { at: now, keys });
  return keys;
}

/** Drop cached JWKS (test hook / key-rotation escape hatch). */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/** RSA signing keys that could have produced this token, most specific first.
 *  A `kid` selects exactly one; without one, every RSA signing key is a
 *  candidate. The old code took `keys[0]` unconditionally, so an IdP that lists
 *  an encryption key or an EC key first rejected valid tokens. */
function candidateKeys(keys: Jwk[], kid: string | undefined): Jwk[] {
  const usable = keys.filter((k) => (k.kty ?? 'RSA') === 'RSA' && (k.use ?? 'sig') === 'sig');
  if (kid) return usable.filter((k) => k.kid === kid);
  return usable;
}

/**
 * Verify an OIDC ID token: RS256 signature (JWKS), issuer, audience, expiry,
 * and nonce. Returns the claims. Throws on any failure — never returns an
 * unverified payload.
 */
export async function verifyIdToken(
  idToken: string,
  cfg: OidcConfig,
  disc: OidcDiscovery,
  expectedNonce: string,
  deps: OidcDeps = {},
): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [h, p, sig] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unsupported id_token alg: ${header.alg}`);
  const keys = await fetchJwks(disc.jwks_uri, deps);
  const candidates = candidateKeys(keys, header.kid);
  if (candidates.length === 0) throw new Error('no matching JWKS key for id_token');
  const signed = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(sig, 'base64url');
  const ok = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      return crypto.verify('RSA-SHA256', signed, key, signature);
    } catch {
      return false; // a malformed JWK entry is not a verification result
    }
  });
  if (!ok) throw new Error('id_token signature invalid');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  // `exp` is REQUIRED by OIDC. Treating a missing/mistyped `exp` as "no expiry
  // to check" made a token without one valid forever — the single worst way to
  // fail open, because it is invisible in a passing login.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new Error('id_token has no expiry');
  }
  if (claims.exp + 60 < nowS) throw new Error('id_token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - 60 > nowS) throw new Error('id_token not yet valid');
  if (claims.iss !== disc.issuer && claims.iss !== cfg.issuer) throw new Error('id_token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw new Error('id_token audience mismatch');
  // The nonce binds this token to the authorize request we started. An empty
  // expectedNonce used to skip the check entirely, so any caller that lost the
  // pending state silently downgraded to an unbound token.
  if (!expectedNonce) throw new Error('id_token nonce check requires a pending nonce');
  if (claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
  return claims;
}

export async function fetchUserInfo(disc: OidcDiscovery, accessToken: string, deps: OidcDeps = {}): Promise<Record<string, unknown>> {
  if (!disc.userinfo_endpoint) return {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  const r = await fetchImpl(disc.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!r.ok) return {};
  return (await r.json()) as Record<string, unknown>;
}

function groupsFromClaim(claims: Record<string, unknown>, claim: string): string[] {
  const raw = claims[claim];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw === 'string') return raw.split(/[,\s]+/).filter(Boolean);
  return [];
}

/** Map the configured group claim to an OpenHub role. Deterministic: the first
 *  mapped group in claim order wins; otherwise `defaultRole`. */
export function roleFromClaims(claims: Record<string, unknown>, cfg: OidcConfig): string {
  for (const g of groupsFromClaim(claims, cfg.groupClaim)) {
    if (cfg.groupRoleMap[g]) return cfg.groupRoleMap[g];
  }
  return cfg.defaultRole;
}

export interface SsoIdentity {
  sub: string;
  email: string;
  name?: string;
  role: string;
}

/** Normalize verified claims into the identity OpenHub stores. Throws when the
 *  subject or email is absent (an IdP must supply them). */
export function identityFromClaims(claims: Record<string, unknown>, cfg: OidcConfig): SsoIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = (typeof claims.email === 'string' ? claims.email : '').trim().toLowerCase();
  if (!sub) throw new Error('id_token missing sub');
  if (!email) throw new Error('id_token missing email');
  const name = (typeof claims.name === 'string' && claims.name)
    || (typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined);
  return { sub, email, name, role: roleFromClaims(claims, cfg) };
}

/** Short-lived store of in-flight login state (state → nonce/verifier). */
export interface PendingSso { nonce: string; verifier: string; returnTo?: string; createdAt: number }

export class PendingSsoStore {
  private readonly pending = new Map<string, PendingSso>();
  private readonly ttlMs: number;
  private lastSweep = 0;
  constructor(ttlMs = 10 * 60 * 1000) { this.ttlMs = ttlMs; }

  /** Largest number of in-flight logins retained. `/api/auth/sso/start` is
   *  unauthenticated, and an abandoned login is never consumed, so without a
   *  sweep and a cap this Map only ever grows. */
  static readonly MAX_PENDING = 10_000;

  put(state: string, value: Omit<PendingSso, 'createdAt'>, now = Date.now()): void {
    // Sweeping on EVERY put is O(n) per login, which turns the same unauthenticated
    // endpoint into a CPU amplifier instead of a memory one. Sweep on a timer
    // (or when the cap is in sight), so the cost is amortized O(1).
    if (now - this.lastSweep > this.ttlMs / 4 || this.pending.size >= PendingSsoStore.MAX_PENDING) {
      this.sweep(now);
    }
    if (this.pending.size >= PendingSsoStore.MAX_PENDING) {
      // Evict oldest-first (Map preserves insertion order) rather than refusing
      // the login: the cap exists to bound memory, not to lock users out.
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(state, { ...value, createdAt: now });
  }

  /** Drop entries past their TTL. Entries are inserted in time order, so the
   *  scan can stop at the first live one. */
  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [k, v] of this.pending) {
      if (now - v.createdAt <= this.ttlMs) break;
      this.pending.delete(k);
    }
  }

  /** Consume (one-time use) a pending state, or null if missing/expired. */
  take(state: string, now = Date.now()): PendingSso | null {
    const v = this.pending.get(state);
    if (!v) return null;
    this.pending.delete(state);
    if (now - v.createdAt > this.ttlMs) return null;
    return v;
  }

  size(): number { return this.pending.size; }
  clear(): void { this.pending.clear(); this.lastSweep = 0; }
}
