import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { siteAudit, openSeoStatus, seoReadiness, auditFleetSites } from '../src/services/seo';
import { createSeoRouter } from '../src/routes/seo';
import { clearKeywireAuthCache, clearKeywireSecretCache } from '../src/services/keywire';

const KEYS_FILE = path.join(os.tmpdir(), `openhub-seo-keys-${process.pid}.json`);

function page(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

const HTML = `<!doctype html><html><head>
<title>Overlay365 Hub — Build, Ship and Grow Faster</title>
<meta name="description" content="A complete platform for launching products with hosting, billing and automation in one place.">
<link rel="canonical" href="https://overlay365.com/">
<meta property="og:title" content="Overlay365 Hub">
<meta property="og:description" content="Launch products faster.">
</head><body><h1>Ship it</h1><p>hi</p></body></html>`;

const SITES = {
  generatedAt: '2026-09-17T00:00:00.000Z',
  inventoryUpdatedAt: '2026-09-16',
  summary: { total: 1, up: 1, degraded: 0, down: 0, unknown: 0, allUp: true, criticalAttention: [] },
  sites: [{ id: 'overlay365', name: 'Overlay365 Hub', state: 'up', publicUrl: 'https://overlay365.com' }],
};

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/workload/fetch-secrets')) return new Response(JSON.stringify({ secrets: {} }), { status: 200 });
    if (url.includes('/api/v1/ecosystem/sites')) return new Response(JSON.stringify(SITES), { status: 200 });
    if (url.includes('/api/health')) return new Response('down', { status: 503 });
    if (url === 'https://example.com/robots.txt') return new Response('User-agent: *\nDisallow: /private/\nSitemap: https://example.com/sitemap.xml', { status: 200 });
    if (url === 'https://example.com/sitemap.xml') return new Response('<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>', { status: 200 });
    if (url === 'https://overlay365.com/robots.txt' || url === 'https://uplift-health.vercel.app/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200 });
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    if (url.endsWith('/sitemap.xml')) return new Response('not found', { status: 404 });
    if (url.startsWith('https://overlay365.com') || url.startsWith('https://uplift-health')) return page(HTML);
    if (url === 'https://example.com/') return page(HTML);
    return new Response('not found', { status: 404 });
  });
}

beforeEach(() => {
  fs.writeFileSync(KEYS_FILE, JSON.stringify({ jwtSecret: 'test-secret' }));
  vi.stubEnv('OPENHUB_KEYWIRE_KEYS_FILE', KEYS_FILE);
  vi.stubEnv('OPENHUB_KEYWIRE_URL', 'http://keywire.test');
  vi.stubEnv('OPENHUB_OPENSEO_URL', 'http://seo.test');
  clearKeywireAuthCache();
  clearKeywireSecretCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearKeywireAuthCache();
  clearKeywireSecretCache();
});

describe('siteAudit (deterministic, free)', () => {
  it('scores a well-formed page', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const a = await siteAudit('https://example.com/');
    expect(a.error).toBeUndefined();
    expect(a.status).toBe(200);
    expect(a.https).toBe(true);
    expect(a.titleLength).toBeGreaterThan(0);
    expect(a.metaDescriptionLength).toBeGreaterThan(0);
    expect(a.canonical).toBe('https://overlay365.com/');
    expect(a.robots?.present).toBe(true);
    expect(a.robots?.blocksAll).toBe(false);
    expect(a.sitemap.urlCount).toBe(2);
    expect(a.findings.some((f) => f.level === 'fail')).toBe(false);
    expect(a.score.pass).toBe(a.score.total);
  });

  it('flags missing title, blocked robots and slowness', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /', { status: 200 });
      if (url.endsWith('/sitemap.xml')) return new Response('x', { status: 404 });
      return new Response('<html><head></head><body>bare</body></html>', { status: 200 });
    }));
    const a = await siteAudit('https://example.com/');
    const fails = a.findings.filter((f) => f.level === 'fail').map((f) => f.check);
    expect(fails).toContain('title');
    expect(fails).toContain('robots');
  });

  it('rejects non-http URLs and unreachable hosts without throwing', async () => {
    expect((await siteAudit('ftp://x')).error).toBeTruthy();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    const a = await siteAudit('https://gone.example/');
    expect(a.error).toContain('ENOTFOUND');
    expect(a.findings.some((f) => f.check === 'fetch' && f.level === 'fail')).toBe(true);
  });
});

describe('open-seo service + readiness', () => {
  it('degrades honestly when the engine is down', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const s = await openSeoStatus();
    expect(s.available).toBe(false);
    const r = await seoReadiness();
    expect(r.service).toBe(false);
    expect(r.dataforseo).toBe(false);
    expect(r.notes.join(' ')).toMatch(/unreachable|absent/i);
  });

  it('audits the fleet inventory', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const { audits } = await auditFleetSites();
    expect(audits).toHaveLength(1);
    expect(audits[0].url).toBe('https://overlay365.com/');
    expect(audits[0].status).toBe(200);
  });
});

describe('seo routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createSeoRouter({ authMiddleware: (_req, _res, next) => next() }));

  it('exposes readiness and audit', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const ready = await request(app).get('/api/business/seo/readiness');
    expect(ready.status).toBe(200);
    expect(ready.body).toHaveProperty('dataforseo', false);

    const audit = await request(app).post('/api/business/seo/audit').send({ url: 'https://example.com/' });
    expect(audit.status).toBe(200);
    expect(audit.body.score.pass).toBe(audit.body.score.total);

    expect((await request(app).post('/api/business/seo/audit').send({})).status).toBe(400);
  });
});
