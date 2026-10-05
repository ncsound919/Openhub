/**
 * One secret-detection rule set for every OpenHub scanner.
 *
 * There used to be three independent lists (codeReviewer's line rule,
 * secretScan's SECRET_PATTERNS, p2Scorers' git-history list) that disagreed
 * with each other. Measured on a 14-case corpus of realistic leaks, the best of
 * them caught 6. The common real-world leaks all slipped through:
 *   - `process.env.X || "sk_live_…"` (lines mentioning process.env were exempt)
 *   - `.env`-style `OPENROUTER_API_KEY=sk-or-v1-…`
 *   - Anthropic / OpenAI `sk-…` keys assigned to a non-credential-looking name
 *   - credentials in URLs (`postgres://user:pass@host`)
 *   - fixed-length keys (AWS `AKIA…`, Google `AIza…`) — the old value regex
 *     demanded 8 more characters after the fixed-length body, so it could
 *     never match them
 *   - secrets containing `+ / = .` (base64, JWT)
 *
 * Two kinds of rule:
 *   - `provider`: the value's own shape identifies it (prefix + charset). High
 *     precision; also used to redact retained command output.
 *   - `assignment`: a credential-named identifier (or `.env` key) bound to a
 *     literal. Filtered by `looksLikeSecretValue` to avoid flagging config
 *     strings, paths and env-var names.
 * `gitleaks` remains the authoritative scanner where it is installed; this is
 * the in-process fallback and the per-line reviewer signal.
 */

export interface SecretRule {
  id: string;
  name: string;
  kind: 'provider' | 'assignment';
  /** Global regex. For assignment rules, capture group `v` is the value. */
  regex: RegExp;
}

export const SECRET_RULES: SecretRule[] = [
  { id: 'private-key', name: 'Private Key', kind: 'provider', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', name: 'AWS Key', kind: 'provider', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-fine-grained', name: 'GitHub Token', kind: 'provider', regex: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { id: 'github-token', name: 'GitHub Token', kind: 'provider', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'gitlab-token', name: 'GitLab Token', kind: 'provider', regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'anthropic-key', name: 'Anthropic API Key', kind: 'provider', regex: /\bsk-ant-(?:api|admin|sid)\d{2}-[A-Za-z0-9_-]{20,}/g },
  { id: 'openrouter-key', name: 'OpenRouter API Key', kind: 'provider', regex: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { id: 'openai-key', name: 'OpenAI API Key', kind: 'provider', regex: /\bsk-(?!ant-|or-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'stripe-secret', name: 'Stripe Secret Key', kind: 'provider', regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'google-api-key', name: 'Google API Key', kind: 'provider', regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'slack-token', name: 'Slack Token', kind: 'provider', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'npm-token', name: 'npm Token', kind: 'provider', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'digitalocean-token', name: 'DigitalOcean Token', kind: 'provider', regex: /\bdop_v1_[a-f0-9]{64}\b/g },
  { id: 'shopify-token', name: 'Shopify Token', kind: 'provider', regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { id: 'jwt', name: 'JSON Web Token', kind: 'provider', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g },
  {
    id: 'url-credentials',
    name: 'Credentials in URL',
    kind: 'assignment',
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:(?<v>[^\s@/'"`]{4,})@[^\s'"`]+/gi,
  },
  {
    id: 'dotenv-assignment',
    name: 'Secret in env file',
    kind: 'assignment',
    regex: /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?(?<v>[^\s#'"]{12,})["']?\s*(?:#.*)?$/gm,
  },
  {
    id: 'named-assignment',
    name: 'Hardcoded Credential',
    kind: 'assignment',
    regex: /(?<![A-Za-z0-9])[A-Za-z0-9_$]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_$]*["']?\s*[:=]\s*(?<q>["'`])(?<v>[^"'`\s]{12,})\k<q>/gi,
  },
];

const PLACEHOLDER_RE = /(example|placeholder|redacted|changeme|change[_-]?me|dummy|fixture|sample|(?:^|[^a-z])your[_-]|insert[_-]?(?:key|token)|not[_-]?a[_-]?real|x{6,}|\*{4,}|<[^>]*>|\$\{|\{\{)/i;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when `value` is an obvious placeholder, not a credential. */
export function isPlaceholderValue(value: string): boolean {
  if (PLACEHOLDER_RE.test(value)) return true;
  // One repeated character (`0000000000000000`, `aaaaaaaaaaaa`).
  return /^(.)\1+$/.test(value.replace(/[-_]/g, ''));
}

/**
 * Filter for assignment-rule values. Rejects env-var NAMES, paths, URLs without
 * credentials, placeholders and low-entropy / single-class words
 * (`access_token_bearer`), so config strings do not read as secrets.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (!value || value.length < 4) return false;
  if (isPlaceholderValue(value)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return false; // an env var name / constant
  if (/^(?:\.{0,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(value)) return false; // path or URL
  if (/\.(?:json|ya?ml|toml|ts|js|mjs|cjs|md|txt|pem|key|crt|env|lock)$/i.test(value)) return false;
  if (/^(?:true|false|null|undefined|none)$/i.test(value)) return false;
  if (/^[a-z./_-]+$/.test(value)) return false; // lowercase word list / slug
  if (/[[\]]/.test(value)) return false; // doc syntax like `[:password]`
  const hasDigit = /\d/.test(value);
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasSymbol = /[^A-Za-z0-9_-]/.test(value);
  if (!hasDigit && !mixedCase && !hasSymbol) return false;
  return shannonEntropy(value) >= 3.0;
}

export interface SecretHit {
  ruleId: string;
  name: string;
  /** Offset of the match within the text that was scanned. */
  index: number;
  /** The matched text (full match). */
  match: string;
}

function valueOf(m: RegExpExecArray, rule: SecretRule): string {
  return rule.kind === 'assignment' ? (m.groups?.v ?? m[0]) : m[0];
}

/**
 * All secret hits in `text`. Overlapping hits on the same span are reported
 * once (the most specific rule wins: provider rules run first).
 * `strictPlaceholders` also drops provider-shaped hits whose value reads as a
 * placeholder (`AKIA…EXAMPLE`) — reviewers want that; the repo scanner does not.
 */
export function findSecrets(text: string, opts: { strictPlaceholders?: boolean } = {}): SecretHit[] {
  const hits: SecretHit[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      const start = m.index;
      const end = start + m[0].length;
      const value = valueOf(m, rule);
      const accept = rule.kind === 'assignment'
        ? (rule.id === 'url-credentials'
          ? !isPlaceholderValue(value) && !/[[\]]/.test(value) && !/^(?:pass(?:word)?|pwd|secret|user)$/i.test(value)
          : looksLikeSecretValue(value))
        : !(opts.strictPlaceholders && isPlaceholderValue(value));
      if (!accept || overlaps(start, end)) continue;
      taken.push([start, end]);
      hits.push({ ruleId: rule.id, name: rule.name, index: start, match: m[0] });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Global regexes for REDACTION of retained output (provider shapes only). */
export const PROVIDER_SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = SECRET_RULES
  .filter((r) => r.kind === 'provider')
  .map((r) => ({ name: r.name, regex: new RegExp(r.regex.source, r.regex.flags) }));
