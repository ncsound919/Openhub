// OIDC SSO tests (Phase 1.3). A locally generated RSA key signs the id_token and
// a stubbed fetch serves discovery/JWKS/token/userinfo — no network, no live IdP.
import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "crypto";
import {
  oidcConfig, discoverOidc, pkcePair, buildAuthorizeUrl, exchangeCode,
  verifyIdToken, roleFromClaims, identityFromClaims, PendingSsoStore, clearJwksCache,
} from "../src/auth/oidc";

const ISSUER = "https://idp.example.test";
const KID = "key-1";
let privateKey: crypto.KeyObject;
let jwk: Record<string, unknown>;

const cfg = oidcConfig({
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "openhub",
  OIDC_CLIENT_SECRET: "shh",
  OIDC_REDIRECT_URI: "http://localhost:3000/api/auth/sso/callback",
  OIDC_GROUP_ROLE_MAP: JSON.stringify({ admins: "admin", devs: "developer" }),
  OIDC_DEFAULT_ROLE: "member",
} as NodeJS.ProcessEnv)!;

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

function b64(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

function signIdToken(claims: Record<string, unknown>): string {
  const header = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function stubFetch(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes(".well-known/openid-configuration")) return { ok: true, async json() { return DISCOVERY; } };
    if (u.endsWith("/jwks")) return { ok: true, async json() { return { keys: [jwk] }; } };
    if (u.endsWith("/userinfo")) return { ok: true, async json() { return { groups: ["admins"] }; } };
    if (u.endsWith("/token")) return { ok: true, async json() { return overrides.token ?? { id_token: "x", access_token: "at" }; } };
    return { ok: false, status: 404, async json() { return {}; } };
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwk.use = "sig";
});

describe("oidcConfig", () => {
  it("is null without issuer/client credentials", () => {
    expect(oidcConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });
  it("parses the group→role map and defaults", () => {
    expect(cfg.groupRoleMap).toEqual({ admins: "admin", devs: "developer" });
    expect(cfg.defaultRole).toBe("member");
    expect(cfg.scope).toBe("openid email profile");
  });
});

describe("discovery + authorize url", () => {
  it("discovers endpoints and builds a PKCE authorize URL", async () => {
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    expect(disc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThan(20);
    const url = new URL(buildAuthorizeUrl(cfg, disc, { state: "st", nonce: "no", codeChallenge: challenge }));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("openhub");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("nonce")).toBe("no");
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier with basic auth", async () => {
    const f = stubFetch({ token: { id_token: "tok", access_token: "at" } });
    const disc = await discoverOidc(cfg, { fetchImpl: f });
    const tokens = await exchangeCode(cfg, disc, "the-code", "the-verifier", { fetchImpl: f });
    expect(tokens.id_token).toBe("tok");
    const call = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find((c) => String(c[0]).endsWith("/token"))!;
    expect(call[1].method).toBe("POST");
    expect(String(call[1].body)).toContain("code_verifier=the-verifier");
    expect(String((call[1].headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
  });
});

describe("verifyIdToken", () => {
  const now = 1_700_000_000_000;
  const base = { iss: ISSUER, aud: "openhub", exp: Math.floor(now / 1000) + 300, sub: "u1", email: "a@b.co", nonce: "n1" };

  it("accepts a correctly signed token and returns claims", async () => {
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const claims = await verifyIdToken(signIdToken(base), cfg, disc, "n1", { fetchImpl: stubFetch(), now: () => now });
    expect(claims.sub).toBe("u1");
  });

  it("rejects a wrong nonce, audience, issuer, or an expired token", async () => {
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const deps = { fetchImpl: stubFetch(), now: () => now };
    await expect(verifyIdToken(signIdToken({ ...base, nonce: "other" }), cfg, disc, "n1", deps)).rejects.toThrow(/nonce/);
    await expect(verifyIdToken(signIdToken({ ...base, aud: "someone-else" }), cfg, disc, "n1", deps)).rejects.toThrow(/audience/);
    await expect(verifyIdToken(signIdToken({ ...base, iss: "https://evil.test" }), cfg, disc, "n1", deps)).rejects.toThrow(/issuer/);
    await expect(verifyIdToken(signIdToken({ ...base, exp: Math.floor(now / 1000) - 9999 }), cfg, disc, "n1", deps)).rejects.toThrow(/expired/);
  });

  it("rejects a tampered signature", async () => {
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const tok = signIdToken(base);
    const tampered = `${tok.slice(0, -4)}AAAA`;
    await expect(verifyIdToken(tampered, cfg, disc, "n1", { fetchImpl: stubFetch(), now: () => now })).rejects.toThrow();
  });
});

describe("claim mapping", () => {
  it("maps groups to roles, first match wins, else default", () => {
    expect(roleFromClaims({ groups: ["other", "devs"] }, cfg)).toBe("developer");
    expect(roleFromClaims({ groups: ["nobody"] }, cfg)).toBe("member");
    expect(roleFromClaims({}, cfg)).toBe("member");
  });

  it("builds an identity and rejects missing sub/email", () => {
    const id = identityFromClaims({ sub: "s", email: "User@Example.com", name: "U", groups: ["admins"] }, cfg);
    expect(id).toEqual({ sub: "s", email: "user@example.com", name: "U", role: "admin" });
    expect(() => identityFromClaims({ email: "x@y.z" }, cfg)).toThrow(/sub/);
    expect(() => identityFromClaims({ sub: "s" }, cfg)).toThrow(/email/);
  });
});

describe("PendingSsoStore", () => {
  it("is one-time use and expires", () => {
    const store = new PendingSsoStore(1000);
    store.put("st", { nonce: "n", verifier: "v" }, 0);
    expect(store.take("st", 0)?.nonce).toBe("n");
    expect(store.take("st", 0)).toBeNull();
    store.put("st2", { nonce: "n2", verifier: "v2" }, 0);
    expect(store.take("st2", 5000)).toBeNull();
  });
});

describe("verifyIdToken — fail-closed regressions", () => {
  const now = 1_700_000_000_000;
  const base = { iss: ISSUER, aud: "openhub", exp: Math.floor(now / 1000) + 300, sub: "u1", email: "a@b.co", nonce: "n1" };

  it("rejects a token with no exp (it used to be valid forever)", async () => {
    clearJwksCache();
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const deps = { fetchImpl: stubFetch(), now: () => now };
    const { exp, ...noExp } = base;
    await expect(verifyIdToken(signIdToken(noExp), cfg, disc, "n1", deps)).rejects.toThrow(/no expiry/);
    await expect(verifyIdToken(signIdToken({ ...base, exp: "later" }), cfg, disc, "n1", deps)).rejects.toThrow(/no expiry/);
  });

  it("rejects a not-yet-valid token", async () => {
    clearJwksCache();
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const deps = { fetchImpl: stubFetch(), now: () => now };
    await expect(
      verifyIdToken(signIdToken({ ...base, nbf: Math.floor(now / 1000) + 9999 }), cfg, disc, "n1", deps),
    ).rejects.toThrow(/not yet valid/);
  });

  it("refuses to verify without a pending nonce instead of skipping the check", async () => {
    clearJwksCache();
    const disc = await discoverOidc(cfg, { fetchImpl: stubFetch() });
    const deps = { fetchImpl: stubFetch(), now: () => now };
    await expect(verifyIdToken(signIdToken(base), cfg, disc, "", deps)).rejects.toThrow(/nonce/);
  });

  it("finds the right RSA signing key when the IdP lists others first", async () => {
    clearJwksCache();
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const decoyJwk = { ...(other.publicKey.export({ format: "jwk" }) as Record<string, unknown>), use: "enc" };
    const multiKeyFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes(".well-known/openid-configuration")) return { ok: true, async json() { return DISCOVERY; } };
      // decoy first, and the real key carries no matching position advantage
      if (u.endsWith("/jwks")) return { ok: true, async json() { return { keys: [decoyJwk, { ...jwk, kid: undefined }] }; } };
      return { ok: false, status: 404, async json() { return {}; } };
    }) as unknown as typeof fetch;
    const disc = await discoverOidc(cfg, { fetchImpl: multiKeyFetch });
    // A token whose header carries no kid must still verify against the right key.
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(base)).toString("base64url");
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const claims = await verifyIdToken(`${header}.${payload}.${sig}`, cfg, disc, "n1", { fetchImpl: multiKeyFetch, now: () => now });
    expect(claims.sub).toBe("u1");
    clearJwksCache();
  });

  it("caches JWKS instead of refetching per verification", async () => {
    clearJwksCache();
    const f = stubFetch();
    const disc = await discoverOidc(cfg, { fetchImpl: f });
    const deps = { fetchImpl: f, now: () => now };
    await verifyIdToken(signIdToken(base), cfg, disc, "n1", deps);
    await verifyIdToken(signIdToken(base), cfg, disc, "n1", deps);
    const jwksCalls = (f as unknown as { mock: { calls: Array<[string]> } }).mock.calls
      .filter((c) => String(c[0]).endsWith("/jwks"));
    expect(jwksCalls.length).toBe(1);
    clearJwksCache();
  });
});

describe("PendingSsoStore bounds", () => {
  it("drops expired entries on put instead of growing forever", () => {
    const store = new PendingSsoStore(1000);
    store.put("a", { nonce: "n", verifier: "v" }, 0);
    store.put("b", { nonce: "n", verifier: "v" }, 0);
    expect(store.size()).toBe(2);
    store.put("c", { nonce: "n", verifier: "v" }, 5000);
    expect(store.size()).toBe(1); // a + b swept (TTL-ordered scan), c retained
    expect(store.take("a", 5000)).toBeNull();
    expect(store.take("c", 5000)).not.toBeNull();
  });

  it("caps live entries so an unauthenticated flood cannot exhaust memory", () => {
    const store = new PendingSsoStore(60_000);
    for (let i = 0; i < PendingSsoStore.MAX_PENDING + 50; i += 1) {
      store.put(`s${i}`, { nonce: "n", verifier: "v" }, 0);
    }
    expect(store.size()).toBeLessThanOrEqual(PendingSsoStore.MAX_PENDING);
  });
});
