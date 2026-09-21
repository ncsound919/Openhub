import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../openhub-mcp';
import { runSonarQubeScorer } from '../src/services/auditSuite';

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
