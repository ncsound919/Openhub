/**
 * OpenHub fleet smoke test — end-to-end verification of the fleet capabilities
 * against a RUNNING server (no mocks; real HTTP, real DB, real pipeline).
 *
 * Usage: node smoke-fleet.mjs [draymondDir]
 *   - expects the server at $SMOKE_BASE_URL (default http://localhost:3355)
 *   - [draymondDir] optional: assert the pipeline lesson was appended there
 *   - exits non-zero when any check fails
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3355';
const DRAY = process.argv[2] || process.env.OPENHUB_DRAYMOND_DIR || null;

let cookies = {};
function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(headers) {
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const csrf = cookies['csrf-token'];
  if (csrf) h['X-CSRF-Token'] = csrf;
  return h;
}

async function req(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...authHeaders(), Cookie: cookieHeader() },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  storeCookies(res.headers);
  const text = await res.text().catch(() => '');
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = Date.now().toString(36);
  const email = `smoke-${stamp}@openhub.local`;
  const username = `smoketester${stamp}`;

  // 0. health (unauthenticated)
  const health = await req('GET', '/api/health');
  check('GET /api/health', health.status === 200 && health.data?.status === 'ok', `status=${health.status}`);

  // 1. C1: quick-access is gated off by default
  const qa = await req('POST', '/api/auth/quick-access', { email: 'x@y.com' });
  check('C1 quick-access → 403 (disabled by default)', qa.status === 403, `status=${qa.status}`);

  // 2. register + login (real cookie session)
  const reg = await req('POST', '/api/auth/register', { email, password: 'SmokeTest123!', username });
  check('register', reg.status === 200 || reg.status === 201, `status=${reg.status}`);
  const login = await req('POST', '/api/auth/login', { email, password: 'SmokeTest123!' });
  check('login (session + csrf cookies set)', login.status === 200 && Object.keys(cookies).length >= 3, `status=${login.status}, cookies=${Object.keys(cookies).join(',')}`);

  // 3. username claim is the real DB username (1.4 fix)
  const me = await req('GET', '/api/auth/me');
  check('auth/me username is the stored username (1.4 fix)', me.status === 200 && me.data?.username === username, `got=${me.data?.username}, want=${username}`);

  // 4. ecosystem layers (capability foundation)
  const ctx = await req('GET', '/api/ecosystem/context');
  check('ecosystem/context configured with 5 layers', ctx.status === 200 && ctx.data?.configured === true && ctx.data?.layers?.length === 5, `layers=${ctx.data?.layers?.filter((l) => l.content).length}`);

  // 5. fleet catalog (capability #3)
  const agents = await req('GET', '/api/ecosystem/agents?kind=agent');
  check('ecosystem/agents catalog live', agents.status === 200 && (agents.data?.assets?.length ?? 0) > 0, `assets=${agents.data?.assets?.length ?? 0}, source=${agents.data?.source}`);

  // 6. KPIs endpoint (capability #5) — structured, honest (may be degraded in smoke env)
  const kpis = await req('GET', '/api/ecosystem/kpis');
  check('ecosystem/kpis returns structured snapshot', kpis.status === 200 && typeof kpis.data === 'object', `source=${kpis.data?.source}`);

  // 7. server-side AI review (capability #4) — honest failure when no LLM seam
  const ai = await req('POST', '/api/ai/review', { repoName: 'smoke', title: 'test PR' });
  check('ai/review server-side (honest ok field)', ai.status === 200 && typeof ai.data?.ok === 'boolean', `ok=${ai.data?.ok}, error=${ai.data?.error ?? 'none'}`);

  // 8. create a real repo (user-scoped)
  const repo = await req('POST', '/api/repos', { name: 'smoke-test', description: 'smoke', isPrivate: false });
  check('create repo (scoped to user dir)', repo.status === 200 && !!repo.data?.id && repo.data?.owner_name === username, `id=${repo.data?.id}, owner=${repo.data?.owner_name}`);
  const repoId = repo.data?.id;
  const owner = repo.data?.owner_name;
  const repoName = repo.data?.name;

  // 9. write a real file via contents PUT + read it back (auth-gated)
  const put = await req('PUT', `/api/repos/${owner}/${repoName}/contents`, { path: 'index.js', content: 'export const x = 1;\n', message: 'smoke' });
  check('contents PUT (real write)', put.status === 200 && put.data?.success === true, `status=${put.status}`);
  const read = await req('GET', `/api/repos/${owner}/${repoName}/contents?path=index.js`);
  check('contents GET requires+honors auth (real read)', read.status === 200 && read.data?.type === 'file' && String(read.data?.content).includes('export const x'), `status=${read.status}`);

  // 10. real deterministic pipeline (capability: no timers)
  const run = await req('POST', '/api/pipeline/run', { repoId, commitMessage: 'smoke run' });
  check('pipeline/run started (real repo)', run.status === 200 && !!run.data?.runId, `status=${run.status}`);
  const runId = run.data?.runId;

  let status = null;
  let stageSummary = '';
  for (let i = 0; i < 30; i++) {
    const poll = await req('GET', `/api/pipeline/status/${runId}`);
    status = poll.data?.status;
    if (status && status !== 'running') {
      stageSummary = (poll.data?.stages ?? []).map((s) => `${s.name}:${s.status}`).join(', ');
      if (poll.data?.gates?.length) stageSummary += ` | gates: ${poll.data.gates.map((g) => `${g.name}:${g.status}`).join(', ')}`;
      break;
    }
    await sleep(1000);
  }
  check('pipeline finished (no timer theater)', status === 'success', `status=${status} — ${stageSummary}`);
  check('pipeline stages honest (skips when no ts/tests)', stageSummary.includes('Secret Scan:success') && stageSummary.includes('Typecheck:skipped') && stageSummary.includes('Tests:skipped'), stageSummary);

  // 11. dual-write fleet memory (capability #2) — appended to the draymond dir the server was pointed at
  if (DRAY) {
    const lessonsFile = path.join(DRAY, 'learning-lessons.json');
    const okFile = fs.existsSync(lessonsFile);
    let lessonOk = false;
    if (okFile) {
      const data = JSON.parse(fs.readFileSync(lessonsFile, 'utf-8'));
      const arr = Array.isArray(data) ? data : data.lessons;
      lessonOk = Array.isArray(arr) && arr.some((l) => l.agentId === 'openhub' && String(l.pattern).startsWith('pipeline.'));
    }
    check('dual-write memory: lesson appended to .draymond', okFile && lessonOk, `file=${lessonsFile}`);
  } else {
    check('dual-write memory (skipped — no draymond dir arg)', true);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`SMOKE ERROR: ${err.stack || err.message}\n`);
  process.exit(1);
});