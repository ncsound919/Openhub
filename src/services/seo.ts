import { keywireSecrets, keywireSites } from './keywire.js';
import { assertOutboundUrlAllowed } from './webhooks.js';

/**
 * SEO provider — OpenHub's read-only window onto the fleet's SEO engine
 * (`agents/open-seo`, self-hosted) plus a free deterministic site audit that
 * needs no paid key.
 *
 * Honesty rules: keyword / backlink / rank / competitor / AI-visibility data
 * requires a DataForSEO key in the vault; this module returns explicit
 * "unconfigured" (never invented rankings) until both the service and the key
 * exist. The local site audit is pure HTTP + HTML inspection — deterministic.
 */

export type FindingLevel = 'pass' | 'warn' | 'fail';

export interface SeoFinding {
  check: string;
  level: FindingLevel;
  detail: string;
}

export interface RobotsInfo {
  present: boolean;
  status: number | null;
  blocksAll: boolean;
  sitemaps: string[];
}

export interface SiteAudit {
  url: string;
  finalUrl: string;
  status: number | null;
  ms: number | null;
  https: boolean;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  hasOgTitle: boolean;
  hasOgDescription: boolean;
  h1Count: number;
  robots: RobotsInfo | null;
  sitemap: { url: string | null; status: number | null; urlCount: number | null };
  serverHeader: string | null;
  findings: SeoFinding[];
  score: { pass: number; total: number };
  error?: string;
}

export interface OpenSeoStatus {
  available: boolean;
  status?: number;
  /** Passthrough of the service's own setup view (it never emits secrets). */
  data?: Record<string, unknown>;
  error?: string;
}

export interface SeoReadiness {
  service: boolean;
  serviceDetail: string;
  dataforseo: boolean;
  openrouter: boolean;
  googleSearchConsole: boolean;
  notes: string[];
}

const SEO_TIMEOUT_MS = 10_000;
const MAX_AUDIT_BYTES = 1_000_000;

export function openSeoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_OPENSEO_URL || env.OPENSEO_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
}

/** Read the self-hosted SEO engine's own setup truth. */
export async function openSeoStatus(env: NodeJS.ProcessEnv = process.env): Promise<OpenSeoStatus> {
  try {
    const res = await fetch(`${openSeoBaseUrl(env)}/api/health`, { signal: AbortSignal.timeout(SEO_TIMEOUT_MS) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return { available: false, status: res.status, error: `open-seo HTTP ${res.status}` };
    return { available: true, status: res.status, data: data ?? {} };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function present(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Which integration pieces exist (vault presence + live service). */
export async function seoReadiness(env: NodeJS.ProcessEnv = process.env): Promise<SeoReadiness> {
  const notes: string[] = [];
  const [status, secrets] = await Promise.all([openSeoStatus(env), keywireSecrets(env)]);
  const map = secrets.available && secrets.data ? secrets.data : {};
  const dataforseo = present(map.DATAFORSEO_API_KEY) && !/(value|placeholder|changeme)$/i.test(map.DATAFORSEO_API_KEY);
  const openrouter = present(map.OPENROUTER_API_KEY) && !/(value|placeholder|changeme)$/i.test(map.OPENROUTER_API_KEY);
  const gsc = present(map.GOOGLE_OAUTH_CLIENT_ID_UPLIFT) && present(map.GOOGLE_OAUTH_CLIENT_SECRET_UPLIFT);

  if (!status.available) notes.push(`open-seo service unreachable (${status.error || 'down'}) — run it from agents/open-seo (docker compose up -d)`);
  if (!secrets.available) notes.push(`vault unreachable (${secrets.error || 'unknown'}) — cannot confirm integration keys`);
  if (secrets.available && !dataforseo) notes.push('DATAFORSEO_API_KEY absent from the vault — keyword/backlink/rank/competitor/AI-visibility data is unavailable');
  if (secrets.available && !gsc) notes.push('Google Search Console OAuth not in the vault — query/impression data unavailable');

  return {
    service: status.available,
    serviceDetail: status.available
      ? `open-seo up (setup: ${String((status.data as Record<string, unknown>)?.status ?? 'ok')})`
      : (status.error || 'unreachable'),
    dataforseo,
    openrouter,
    googleSearchConsole: gsc,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Deterministic site audit — free, no paid key, no LLM.
// ---------------------------------------------------------------------------

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1].trim().slice(0, 500) : null;
}

function extractMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*content=["']([^"']{0,500})["'][^>]*>`, 'i');
  let m = re.exec(html);
  if (m) return m[1].trim();
  const re2 = new RegExp(`<meta\\s+[^>]*content=["']([^"']{0,500})["'][^>]*name=["']${name}["'][^>]*>`, 'i');
  m = re2.exec(html);
  return m ? m[1].trim() : null;
}

function extractMetaProperty(html: string, property: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*property=["']${property}["'][^>]*content=["']([^"']{0,500})["'][^>]*>`, 'i');
  const m = re.exec(html);
  return m ? m[1].trim() : null;
}

function extractCanonical(html: string): string | null {
  return firstMatch(html, /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']{1,500})["'][^>]*>/i)
    ?? firstMatch(html, /<link\s+[^>]*href=["']([^"']{1,500})["'][^>]*rel=["']canonical["'][^>]*>/i);
}

function countTag(html: string, tag: 'h1'): number {
  const m = html.match(new RegExp(`<${tag}(?:\\s|>)`, 'gi'));
  return m ? m.length : 0;
}

function crawlableBody(html: string): string {
  return html.slice(0, MAX_AUDIT_BYTES);
}

async function fetchText(url: string, timeoutMs: number): Promise<{ status: number | null; text: string; finalUrl: string; ms: number; headers: Headers | null; error?: string }> {
  const started = Date.now();
  try {
    // SSRF guard: audit targets are request-supplied. Refuse non-http(s) and,
    // by default, loopback/private targets so the audit cannot probe internal
    // services. (Redirect hops are followed by fetch; the initial target is
    // what the caller controls.)
    assertOutboundUrlAllowed(url, 'SEO audit URL');
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => '');
    return { status: res.status, text: text.slice(0, MAX_AUDIT_BYTES), finalUrl: res.url || url, ms: Date.now() - started, headers: res.headers };
  } catch (err) {
    return { status: null, text: '', finalUrl: url, ms: Date.now() - started, headers: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Audit one public URL. Never throws. */
export async function siteAudit(rawUrl: string, env?: NodeJS.ProcessEnv): Promise<SiteAudit> {
  void env;
  const findings: SeoFinding[] = [];
  const fail = (check: string, detail: string) => findings.push({ check, level: 'fail', detail });
  const warn = (check: string, detail: string) => findings.push({ check, level: 'warn', detail });
  const pass = (check: string, detail: string) => findings.push({ check, level: 'pass', detail });

  let normalized: URL;
  try {
    normalized = new URL(rawUrl);
    if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') throw new Error('only http(s) URLs');
  } catch {
    fail('fetch', `invalid URL "${rawUrl}"`);
    return emptyAudit(rawUrl, findings, 'invalid URL');
  }

  const https = normalized.protocol === 'https:';
  if (https) pass('https', 'served over TLS');
  else warn('https', 'not served over TLS');

  const page = await fetchText(normalized.toString(), SEO_TIMEOUT_MS);
  if (page.error || page.status === null) {
    fail('fetch', page.error || 'unreachable');
    return emptyAudit(normalized.toString(), findings, page.error || 'unreachable');
  }
  if (page.status >= 200 && page.status < 300) pass('fetch', `HTTP ${page.status} in ${page.ms}ms`);
  else if (page.status >= 300 && page.status < 400) warn('fetch', `HTTP ${page.status} (redirect chain to ${page.finalUrl})`);
  else fail('fetch', `HTTP ${page.status}`);

  if (page.ms > 3000) warn('performance', `slow first byte+body: ${page.ms}ms`);
  else pass('performance', `${page.ms}ms`);

  const html = crawlableBody(page.text);
  const title = firstMatch(html, /<title[^>]*>([\s\S]{0,300})<\/title>/i);
  const titleLength = title ? title.length : 0;
  if (!title) fail('title', 'missing <title>');
  else if (titleLength < 30 || titleLength > 60) warn('title', `${titleLength} chars (recommended 30–60)`);
  else pass('title', `${titleLength} chars`);

  const metaDescription = extractMeta(html, 'description');
  const metaDescriptionLength = metaDescription ? metaDescription.length : 0;
  if (!metaDescription) warn('meta-description', 'missing meta description');
  else if (metaDescriptionLength < 50 || metaDescriptionLength > 160) warn('meta-description', `${metaDescriptionLength} chars (recommended 50–160)`);
  else pass('meta-description', `${metaDescriptionLength} chars`);

  const canonical = extractCanonical(html);
  if (!canonical) warn('canonical', 'no canonical link');
  else pass('canonical', canonical);

  let robots: RobotsInfo | null = null;
  let sitemap = { url: null as string | null, status: null as number | null, urlCount: null as number | null };
  try {
    const origin = new URL(page.finalUrl).origin;
    const rb = await fetchText(`${origin}/robots.txt`, SEO_TIMEOUT_MS / 2);
    if (rb.status === 200) {
      const disallows = (rb.text.match(/^Disallow:\s*(\/?.*)$/gim) || []).map((l) => l.replace(/^Disallow:\s*/i, '').trim());
      const sitemaps = (rb.text.match(/^Sitemap:\s*(\S+)$/gim) || []).map((l) => l.replace(/^Sitemap:\s*/i, '').trim());
      const blocksAll = disallows.includes('/');
      robots = { present: true, status: 200, blocksAll, sitemaps };
      if (blocksAll) fail('robots', 'robots.txt disallows / (blocks all crawling)');
      else pass('robots', `${disallows.length} disallow rule(s)`);

      const smUrl = sitemaps.find((u) => u.startsWith('http')) ?? `${origin}/sitemap.xml`;
      const sm = await fetchText(smUrl, SEO_TIMEOUT_MS / 2);
      if (sm.status === 200) {
        const locs = sm.text.match(/<loc>([^<]{1,500})<\/loc>/gi) || [];
        sitemap = { url: smUrl, status: 200, urlCount: locs.length };
        pass('sitemap', `${locs.length} URLs at ${smUrl}`);
      } else {
        sitemap = { url: smUrl, status: sm.status, urlCount: null };
        warn('sitemap', `${smUrl} -> HTTP ${sm.status ?? 'unreachable'}`);
      }
    } else {
      robots = { present: false, status: rb.status, blocksAll: false, sitemaps: [] };
      warn('robots', `no robots.txt (HTTP ${rb.status ?? 'unreachable'})`);
      const sm = await fetchText(`${origin}/sitemap.xml`, SEO_TIMEOUT_MS / 2);
      if (sm.status === 200) {
        const locs = sm.text.match(/<loc>([^<]{1,500})<\/loc>/gi) || [];
        sitemap = { url: `${origin}/sitemap.xml`, status: 200, urlCount: locs.length };
        pass('sitemap', `${locs.length} URLs`);
      } else {
        sitemap = { url: `${origin}/sitemap.xml`, status: sm.status, urlCount: null };
        warn('sitemap', 'no sitemap.xml');
      }
    }
  } catch {
    warn('robots', 'robots/sitemap check failed');
  }

  const ogTitle = extractMetaProperty(html, 'og:title');
  const ogDescription = extractMetaProperty(html, 'og:description');
  if (!ogTitle) warn('open-graph', 'missing og:title');
  else if (!ogDescription) warn('open-graph', 'missing og:description');
  else pass('open-graph', 'og:title + og:description present');

  const h1Count = countTag(html, 'h1');
  if (h1Count === 0) warn('h1', 'no <h1> found');
  else if (h1Count > 1) warn('h1', `${h1Count} <h1> tags (recommended: one)`);
  else pass('h1', 'exactly one <h1>');

  const serverHeader = page.headers?.get('server') ?? null;
  pass('headers', serverHeader ? `server: ${serverHeader}` : 'headers read');

  const passed = findings.filter((f) => f.level === 'pass').length;
  return {
    url: normalized.toString(), finalUrl: page.finalUrl, status: page.status, ms: page.ms, https,
    title, titleLength, metaDescription, metaDescriptionLength, canonical,
    hasOgTitle: ogTitle !== null, hasOgDescription: ogDescription !== null, h1Count,
    robots, sitemap, serverHeader, findings, score: { pass: passed, total: findings.length },
  };
}

function emptyAudit(url: string, findings: SeoFinding[], error: string): SiteAudit {
  return {
    url, finalUrl: url, status: null, ms: null, https: url.startsWith('https:'),
    title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, canonical: null,
    hasOgTitle: false, hasOgDescription: false, h1Count: 0, robots: null,
    sitemap: { url: null, status: null, urlCount: null }, serverHeader: null,
    findings, score: { pass: findings.filter((f) => f.level === 'pass').length, total: findings.length }, error,
  };
}

/** Audit every public property in the Keywire inventory (bounded, best-effort). */
export async function auditFleetSites(env: NodeJS.ProcessEnv = process.env, perSiteTimeoutMs = 15_000): Promise<{ audits: SiteAudit[]; error?: string }> {
  const inv = await keywireSites(env);
  if (!inv.available || !inv.data) return { audits: [], error: inv.error || 'site inventory unavailable' };
  const targets = inv.data.sites
    .map((s) => ({ id: s.id, url: s.publicUrl }))
    .filter((t): t is { id: string; url: string } => typeof t.url === 'string' && t.url.length > 0)
    .slice(0, 12);
  const audits: SiteAudit[] = [];
  await Promise.all(targets.map(async (t) => {
    try {
      const audit = await Promise.race([
        siteAudit(t.url),
        new Promise<SiteAudit>((_, reject) => setTimeout(() => reject(new Error('per-site timeout')), perSiteTimeoutMs)),
      ]);
      audits.push(audit);
    } catch (err) {
      audits.push(emptyAudit(t.url, [{ check: 'fetch', level: 'fail', detail: err instanceof Error ? err.message : 'timeout' }], 'timeout'));
    }
  }));
  return { audits };
}

/** Data-gated SEO operations: honest 503 shape until the service + DataForSEO exist. */
export async function keywordOverview(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ available: boolean; error?: string }> {
  const readiness = await seoReadiness(env);
  if (!readiness.service) return { available: false, error: 'open-seo service unreachable — run agents/open-seo (docker compose up -d)' };
  if (!readiness.dataforseo) return { available: false, error: 'DATAFORSEO_API_KEY absent — keyword data unavailable' };
  return { available: false, error: 'keyword reads live in the open-seo app/MCP for now — no direct REST contract wired' };
}
