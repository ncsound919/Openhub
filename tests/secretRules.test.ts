import { describe, it, expect } from 'vitest';
import { findSecrets, looksLikeSecretValue, PROVIDER_SECRET_PATTERNS } from '../src/services/secretRules';

// Deterministic pseudo-random token body (no real credentials in the repo).
const R = (n: number) => Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(i * 7 + 3) % 62]).join('');

// The 14-case leak corpus from the 2026-09-23 audit. Before the shared rule
// set, codeReviewer caught 6/14 and secretScan 3/14.
const LEAKS: Record<string, string> = {
  'stripe live literal': `const stripeKey = "sk_live_${R(24)}";`,
  'env fallback default': `const key = process.env.STRIPE_KEY || "sk_live_${R(24)}";`,
  'openai sk-proj': `const client = new OpenAI({ apiKey: "sk-proj-${R(40)}" });`,
  'anthropic bare const': `const ANTHROPIC = "sk-ant-api03-${R(40)}";`,
  'github classic': `const gh = "ghp_${R(36)}";`,
  'github fine-grained': `const gh = "github_pat_${R(22)}_${R(59)}";`,
  'aws access key': `aws_access_key_id = "AKIAQWERTYUIOPASDFGH"`,
  'url basic-auth': `const db = "postgres://admin:${R(20)}@db.internal:5432/prod";`,
  'jwt secret w/ symbols': `const jwtSecret = "${R(20)}+/${R(10)}==";`,
  'slack bot': `const slack = "xoxb-${R(12)}-${R(24)}";`,
  'pem private key': `-----BEGIN RSA PRIVATE KEY-----`,
  '.env style line': `OPENROUTER_API_KEY=sk-or-v1-${R(64)}`,
  'google api key': `const g = "AIza${R(35)}";`,
  'password in yaml': `password: "${R(18)}"`,
};

const CLEAN: Record<string, string> = {
  'env read': `const key = process.env.STRIPE_KEY;`,
  'placeholder': `const apiKey = "YOUR_KEY_HERE_0000000000";`,
  'example key': `const apiKey = "EXAMPLE_0000000000000000";`,
  'hash constant': `const sha = "${R(40)}";`,
  'uuid': `const id = "550e8400-e29b-41d4-a716-446655440000";`,
  'token var name only': `const tokenCount = computeTokens(text);`,
  'env var name as value': `const tokenEnv = "OPENROUTER_API_KEY";`,
  'config word': `const tokenType = "access_token_bearer";`,
  'path value': `const tokenizerPath = "./models/tokenizer.json";`,
  'template url': 'const db = `postgres://${user}:${pass}@host/db`;',
  'url no creds': `const url = "https://api.example.com/v1/tokens";`,
  'dotenv reference': `API_TOKEN=\${VAULT_API_TOKEN}`,
};

describe('shared secret rules — audit corpus', () => {
  for (const [name, line] of Object.entries(LEAKS)) {
    it(`catches: ${name}`, () => {
      expect(findSecrets(line, { strictPlaceholders: true }).length).toBeGreaterThan(0);
    });
  }
  for (const [name, line] of Object.entries(CLEAN)) {
    it(`ignores: ${name}`, () => {
      expect(findSecrets(line, { strictPlaceholders: true })).toEqual([]);
    });
  }

  it('reports one hit per span (most specific rule wins)', () => {
    const hits = findSecrets(`const apiKey = "sk_live_${R(24)}";`);
    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('stripe-secret');
  });

  it('value filter rejects single-class low-signal words', () => {
    expect(looksLikeSecretValue('access_token_bearer')).toBe(false);
    expect(looksLikeSecretValue('Zq8#vN2!pL5@kR9$')).toBe(true);
  });

  it('exports provider patterns as global regexes for redaction', () => {
    expect(PROVIDER_SECRET_PATTERNS.every((p) => p.regex.global)).toBe(true);
  });
});
