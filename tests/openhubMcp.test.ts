import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest, withDeadline, ToolTimeout } from '../openhub-mcp';
import { runSonarQubeScorer } from '../src/services/auditSuite';
import * as auditModule from '../src/services/auditSuite';

type ToolCallResult = { content: Array<{ type: string; text: string }> };

describe('openhub-mcp', () => {
  it('advertises protocol + server info', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const result = res.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('openhub-audit');
  });

  it('lists the audit + review tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('openhub_audit_run');
    expect(names).toContain('openhub_audit_scorers');
    expect(names).toContain('openhub_reviewdog_rdjson');
    expect(names).toContain('openhub_pr_agent_review');
    expect(names).toContain('openhub_service_status');
    expect(names).toContain('openhub_ecosystem_state');
    expect(names).toContain('openhub_ecosystem_list');
    expect(names).toContain('openhub_ecosystem_refresh');
    expect(names).toContain('openhub_ecosystem_audit');
  });

  it('recalls ecosystem state without network calls', async () => {
    const res = await handleRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'openhub_ecosystem_state', arguments: {} },
    });
    const parsed = JSON.parse((res.result as ToolCallResult).content[0].text) as {
      summary: string;
      entities: Array<{ id: string; deployability: number; auditScore: number | null }>;
    };
    expect(parsed.summary).toContain('Ecosystem registry');
    expect(parsed.entities.length).toBeGreaterThan(0);
    expect(parsed.entities.find((e) => e.id === 'axiom')).toBeTruthy();
  });

  it('reports service configuration without fabricating availability', async () => {
    const res = await handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'openhub_service_status', arguments: {} },
    });
    const text = (res.result as ToolCallResult).content[0].text;
    const parsed = JSON.parse(text) as Record<string, { configured: boolean }>;
    expect(parsed).toHaveProperty('sonarqube.configured');
    expect(parsed).toHaveProperty('pr_agent.configured');
    expect(parsed).toHaveProperty('reviewdog.configured');
  });

  it('errors on an unknown tool instead of returning empty success', async () => {
    const res = await handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'definitely_not_a_tool', arguments: {} },
    });
    expect(res.error?.message).toContain('unknown tool');
  });
});

describe('tool deadlines', () => {
  // The defect: a run that exceeded the host's cap replied with nothing at all.
  // MCP -32001 with no payload — not even the scorers that had already
  // finished, which are precisely what says where the run got to. For the one
  // call whose whole job is to report on many tools, discarding completed work
  // is the worst available failure mode.
  //
  // These use openhub_core_config rather than openhub_audit_run: it reads the
  // repo's config from disk, so it does real work on a real path and can be
  // made to exceed a tiny budget, without depending on which external scorers
  // happen to be up.
  const repo = (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-deadline-'));
    fs.writeFileSync(path.join(d, 'openhub.yaml'), 'version: 1\nsensitivity: high\n');
    return d;
  })();

  // `requireTarget` rejects any path outside the configured repo roots, so the
  // fixture has to be inside one. Restoring the previous value matters: this
  // env var is read on every call in the rest of the file too.
  const prevRoots = process.env.OPENHUB_MCP_TARGET_ROOTS;
  process.env.OPENHUB_MCP_TARGET_ROOTS = os.tmpdir();
  afterAll(() => {
    if (prevRoots === undefined) delete process.env.OPENHUB_MCP_TARGET_ROOTS;
    else process.env.OPENHUB_MCP_TARGET_ROOTS = prevRoots;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const call = (args: Record<string, unknown>) => handleRequest({
    jsonrpc: '2.0',
    id: 90,
    method: 'tools/call',
    params: { name: 'openhub_core_config', arguments: args },
  });

  it('rejects a non-positive _timeoutMs rather than silently ignoring it', async () => {
    const res = await call({ target_dir: repo, _timeoutMs: 0 });
    expect(res.error?.message).toContain('_timeoutMs must be a positive number');
  });

  it('rejects a non-numeric _timeoutMs', async () => {
    const res = await call({ target_dir: repo, _timeoutMs: 'soon' });
    expect(res.error?.message).toContain('_timeoutMs must be a positive number');
  });

  it('completes normally when the deadline is generous', async () => {
    const res = await call({ target_dir: repo, _timeoutMs: 60_000 });
    // No deadline error, and the call really did run.
    expect(res.error).toBeUndefined();
    expect((res.result as ToolCallResult).content[0].text).toContain('config');
  });

  it('rejects with ToolTimeout when the budget is exceeded', async () => {
    // The mechanism, directly. Driven through withDeadline rather than a real
    // tool call because a 1ms budget against a config load is a race, and a
    // test that depends on winning a race is a test that will flake.
    await expect(withDeadline('demo', () => new Promise(() => {}), 20)).rejects.toBeInstanceOf(ToolTimeout);
  }, 10_000);

  it('lets work that finishes in time win the race', async () => {
    await expect(withDeadline('demo', async () => 'done', 5_000)).resolves.toBe('done');
  });

  it('names the tool and the budget in the timeout error', async () => {
    // "took too long" without naming which tool and how long is not actionable.
    const err = await withDeadline('openhub_audit_run', () => new Promise(() => {}), 15)
      .then(() => null, (e: unknown) => e as ToolTimeout);
    expect(err).toBeInstanceOf(ToolTimeout);
    expect(err?.tool).toBe('openhub_audit_run');
    expect(err?.timeoutMs).toBe(15);
    expect(err?.message).toContain('openhub_audit_run');
    expect(err?.message).toContain('15ms');
  }, 10_000);

  it('does not leave the timer holding the event loop open', async () => {
    // A per-call timer that is not unref'd keeps a short-lived process alive
    // after its work is done — the kind of thing that makes a stdio server look
    // hung when it has actually finished.
    const settled = await withDeadline('demo', async () => 'ok', 60_000);
    expect(settled).toBe('ok');
    // If the timer were live this handle would still be pending.
    expect((process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()
      .filter((h) => String((h as { constructor?: { name?: string } })?.constructor?.name) === 'Timeout')).toHaveLength(0);
  }, 10_000);

  it('reports a deadline through handleRequest as -32001 with partial:true', async () => {
    // The wire shape. Built through handleRequest so the -32603 catch arm is
    // exercised: an unrecognised error type would be reported as an internal
    // fault, telling the caller the server broke.
    const slow = vi.spyOn(auditModule, 'executeAuditSuite').mockImplementation(
      () => new Promise(() => {}) as never,
    );
    try {
      const res = await handleRequest({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: { name: 'openhub_audit_run', arguments: { target_dir: repo, preset: 'quick', _timeoutMs: 25 } },
      });
      expect(res.error).toBeDefined();
      expect(res.error?.code).toBe(-32001);
      const data = res.error?.data as Record<string, unknown>;
      expect(data.partial).toBe(true);
      expect(data.tool).toBe('openhub_audit_run');
      expect(data.timeoutMs).toBe(25);
      // And it says what to do about it.
      expect(String(data.note)).toMatch(/timeout|narrow/i);
    } finally {
      slow.mockRestore();
    }
  }, 30_000);

  it('strips _timeoutMs before the tool sees it', async () => {
    // Otherwise an underscore-prefixed control field could be mistaken for a
    // real argument, and `additionalProperties: false` schemas would reject it.
    const withOpt = await call({ target_dir: repo, _timeoutMs: 60_000 });
    const without = await call({ target_dir: repo });
    expect((withOpt.result as ToolCallResult).content[0].text)
      .toBe((without.result as ToolCallResult).content[0].text);
  }, 30_000);
});

describe('sonarqube scorer', () => {
  it('is an honest unavailable skip when SONAR_URL/SONAR_TOKEN are unset', async () => {
    const prevUrl = process.env.SONAR_URL;
    const prevToken = process.env.SONAR_TOKEN;
    delete process.env.SONAR_URL;
    delete process.env.SONAR_TOKEN;
    try {
      const result = await runSonarQubeScorer('/tmp');
      expect(result.score).toBeNull();
      expect(result.status).toBe('unavailable');
      expect(result.error ?? result.summary).toMatch(/SONAR_URL/);
    } finally {
      if (prevUrl !== undefined) process.env.SONAR_URL = prevUrl;
      if (prevToken !== undefined) process.env.SONAR_TOKEN = prevToken;
    }
  });
});

describe('sonarqube scorer scan path', () => {
  it('derives the project key from package.json and fails honestly without a server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sonar-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    const prevUrl = process.env.SONAR_URL;
    const prevToken = process.env.SONAR_TOKEN;
    const prevKey = process.env.SONAR_PROJECT_KEY;
    process.env.SONAR_URL = 'http://127.0.0.1:9';
    process.env.SONAR_TOKEN = 'test-token';
    delete process.env.SONAR_PROJECT_KEY;
    try {
      const result = await runSonarQubeScorer(dir);
      expect(result.score).toBeNull();
      const text = `${result.error ?? ''} ${result.summary}`;
      expect(text).toMatch(/quality gate|scan|my-app/);
      // The missing scanner must degrade to last-analysis mode, never to a score.
      expect(result.status).toBe('unavailable');
    } finally {
      if (prevUrl !== undefined) process.env.SONAR_URL = prevUrl;
      else delete process.env.SONAR_URL;
      if (prevToken !== undefined) process.env.SONAR_TOKEN = prevToken;
      else delete process.env.SONAR_TOKEN;
      if (prevKey !== undefined) process.env.SONAR_PROJECT_KEY = prevKey;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP input validation (pr_url / extra_args / target_dir)', () => {
  it('accepts only GitHub PR URLs and allowlisted PR-Agent command words', async () => {
    const { validatePrAgentArgs } = await import('../openhub-mcp');
    expect(validatePrAgentArgs('https://github.com/acme/app/pull/12', ['review'])).toEqual({
      prUrl: 'https://github.com/acme/app/pull/12',
      extra: ['review'],
    });
    expect(() => validatePrAgentArgs('--config=/etc/x', [])).toThrow(/pr_url/);
    expect(() => validatePrAgentArgs('https://github.com/acme/app/pull/12 --x', [])).toThrow(/pr_url/);
    expect(() => validatePrAgentArgs('file:///etc/passwd', [])).toThrow(/pr_url/);
    expect(() => validatePrAgentArgs('https://github.com/acme/app/pull/12', ['--config=/tmp/evil.toml'])).toThrow(/not allowed/);
    expect(() => validatePrAgentArgs('https://github.com/acme/app/pull/12', ['--pr_reviewer.extra=x'])).toThrow(/not allowed/);
    expect(() => validatePrAgentArgs('https://github.com/acme/app/pull/12', 'review')).toThrow(/array/);
  });

  it('confines target_dir to the configured roots (realpath based)', async () => {
    const { requireTarget } = await import('../openhub-mcp');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mcp-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mcp-out-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const env = { OPENHUB_REPOS_ROOT: root } as NodeJS.ProcessEnv;
    try {
      expect(requireTarget({ target_dir: repo }, env)).toBe(path.resolve(repo));
      expect(() => requireTarget({ target_dir: outside }, env)).toThrow(/outside/);
      expect(() => requireTarget({ target_dir: path.join(repo, '..', '..') }, env)).toThrow(/outside|does not exist/);
      let linked = false;
      try {
        fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
        linked = true;
      } catch {
        /* no symlink privilege */
      }
      if (linked) expect(() => requireTarget({ target_dir: path.join(root, 'link') }, env)).toThrow(/outside/);
      expect(requireTarget({ target_dir: outside }, { ...env, OPENHUB_MCP_TARGET_ROOTS: outside })).toBe(path.resolve(outside));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
