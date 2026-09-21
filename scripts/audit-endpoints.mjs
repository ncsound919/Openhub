#!/usr/bin/env node
// Endpoint coverage audit.
//
// The unit tests mock `fetch` generically, so a frontend call to a route that
// does not exist (or is mounted under a different prefix) passes every test and
// then 404s in the browser. This script extracts every `/api/...` path the
// frontend calls and every route the server mounts, then reports the calls with
// no backend match — the "nothing works" class of bug.
//
// Usage: node scripts/audit-endpoints.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const routesDir = path.join(srcDir, 'routes');
const serverFile = path.join(root, 'server.ts');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.vitest') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ---- Backend route extraction -------------------------------------------

/** file basename (no ext) -> set of exported router identifiers/factories. */
function routerIdentifiers(routesDir) {
  const map = new Map();
  for (const f of fs.readdirSync(routesDir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    const ids = new Set();
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)\s*[:=]/g)) ids.add(m[1]);
    for (const m of src.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)) ids.add(m[1]);
    map.set(f.replace(/\.ts$/, ''), ids);
  }
  return map;
}

function mountsFromServer() {
  const src = fs.readFileSync(serverFile, 'utf8');
  // import { createXRouter } from './src/routes/y.js'
  const importToFile = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](?:\.\/)?src\/routes\/([A-Za-z0-9_.-]+?)(?:\.js)?['"]/g)) {
    for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())) importToFile.set(name, m[2]);
  }
  // app.use('/api', someRouter)  /  app.use('/api', createXRouter({...}))
  const mounts = [];
  for (const m of src.matchAll(/app\.use\(\s*(['"])(\/[^'"]*)?\1\s*,\s*([A-Za-z0-9_]+)/g)) {
    mounts.push({ prefix: (m[2] ?? '').replace(/\/$/, ''), id: m[3] });
  }
  for (const m of src.matchAll(/app\.use\(\s*([A-Za-z0-9_]+)\s*\(/g)) {
    mounts.push({ prefix: '', id: m[1] });
  }
  return { importToFile, mounts };
}

function backendRoutes() {
  const idMap = routerIdentifiers(routesDir);
  const { importToFile, mounts } = mountsFromServer();
  // id -> file (routes dir) for both factories and named routers.
  const idToFile = new Map(importToFile);
  for (const [file, ids] of idMap) for (const id of ids) if (!idToFile.has(id)) idToFile.set(id, file);

  const routes = [];
  const addFromFile = (file, prefix) => {
    const full = path.join(routesDir, file + '.ts');
    if (!fs.existsSync(full)) return;
    const src = fs.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete|all|use)\(\s*(['"])(\/[^'"]*)\2/g)) {
      routes.push({ method: m[1], pattern: (prefix + m[3]).replace(/\/+/g, '/') });
    }
  };
  for (const { prefix, id } of mounts) {
    const file = idToFile.get(id);
    if (file) addFromFile(file, prefix);
  }
  // Direct routes declared in server.ts.
  const src = fs.readFileSync(serverFile, 'utf8');
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*(['"])(\/[^'"]*)\2/g)) {
    routes.push({ method: m[1], pattern: m[3] });
  }
  return routes;
}

// ---- Frontend call extraction -------------------------------------------

function frontendCalls() {
  const calls = [];
  for (const f of walk(srcDir)) {
    if (f.includes(`${path.sep}routes${path.sep}`)) continue; // server-side proxies
    // src/services/** are SERVER-side clients that call other services (Axiom,
    // Recourse, …); their /api paths are not OpenHub routes.
    if (f.includes(`${path.sep}services${path.sep}`)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f).replace(/\\/g, '/');
    for (const m of src.matchAll(/(?:fetch|axiomFetch)\(\s*(['"`])(\/api\/[^'"`]*)\1/g)) {
      calls.push({ file: rel, raw: m[2] });
    }
  }
  return calls;
}

// ---- Matching ------------------------------------------------------------

function normalize(p) {
  return p.split('?')[0].replace(/\$\{[^}]*\}/g, '*').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function segments(p) {
  return normalize(p).split('/').filter(Boolean);
}

function matches(front, back) {
  const a = segments(front);
  const b = segments(back);
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    const bs = b[i];
    if (bs === '*' || bs.startsWith(':')) continue;
    if (bs !== a[i]) return false;
  }
  return true;
}

// Paths proxied to other services (Axiom/Recourse/…) — OpenHub has a catch-all
// proxy for these, so a missing local route is expected.
const PROXY_PREFIXES = ['/api/axiom', '/api/recourse', '/api/fleet', '/api/services', '/api/ecosystem', '/api/intelligence', '/api/incidents', '/api/supervise', '/api/repair', '/api/audit-core', '/api/vulns', '/api/review', '/api/studio', '/api/ai', '/api/business', '/api/crm', '/api/seo', '/api/auth'];

const back = backendRoutes();
const calls = frontendCalls();
const unique = new Map();
for (const c of calls) unique.set(c.raw + '::' + c.file, c);

const unmatched = [];
for (const c of unique.values()) {
  const n = normalize(c.raw);
  if (back.some((r) => matches(n, r.pattern))) continue;
  unmatched.push(c);
}

const byFile = new Map();
for (const u of unmatched) {
  if (!byFile.has(u.file)) byFile.set(u.file, []);
  byFile.get(u.file).push(normalize(u.raw));
}

const proxied = [...byFile.entries()].map(([file, paths]) => [file, paths.filter((p) => !PROXY_PREFIXES.some((pre) => p.startsWith(pre)))]);
const real = proxied.filter(([, paths]) => paths.length > 0);

// Calls whose dynamic segment resolves to a known literal route at runtime
// (e.g. `${action}` is always start|stop). Verified by hand, not ignored blindly.
const ALLOWLIST = new Set([
  '/api/lifecycle/services/*/*',
  '/api/project/active/git/*',
  '/api/browse*',
  // `${action}` is always approve|reject (both mounted as literal routes).
  '/api/pipeline/*/*',
]);

const allowed = (p) => ALLOWLIST.has(p) || p.startsWith('/api/browse');

const actionable = real
  .map(([file, paths]) => [file, paths.filter((p) => !allowed(p))])
  .filter(([, paths]) => paths.length > 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ routes: back.length, calls: unique.size, unmatched: actionable }, null, 2));
} else {
  console.log(`backend routes: ${back.length}   frontend /api calls: ${unique.size}`);
  console.log(`unmatched (excluding known proxy prefixes + allowlist): ${actionable.reduce((n, [, p]) => n + p.length, 0)}`);
  for (const [file, paths] of actionable.sort()) {
    console.log(`\n${file}`);
    for (const p of [...new Set(paths)].sort()) console.log(`  - ${p}`);
  }
}

// --check: fail (non-zero) when a frontend call has no backend route.
if (process.argv.includes('--check') && actionable.length > 0) process.exit(1);
