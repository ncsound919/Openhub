import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fleetMcpServers,
  activeFleetMcp,
  mergeFleetMcp,
  type FleetMcpServer,
} from '../src/services/fleetMcp.js';
import { engineConfigOverlay } from '../src/services/opencodeEngine.js';

function byId(servers: FleetMcpServer[], id: string): FleetMcpServer {
  const found = servers.find((s) => s.id === id);
  if (!found) throw new Error(`no server ${id} (got: ${servers.map((s) => s.id).join(', ')})`);
  return found;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetmcp-'));
  tmpDirs.push(dir);
  return dir;
}
function tmpFile(dir: string, ...parts: string[]): string {
  const p = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '// stub\n');
  return p;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fleetMcpServers', () => {
  it('wires sequential-thinking by default with the official package', () => {
    const seq = byId(fleetMcpServers({}), 'sequential-thinking');
    expect(seq.enabled).toBe(true);
    expect(seq.config).toEqual({ type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'] });
  });

  it('reports sequential-thinking as explicitly disabled when turned off', () => {
    const seq = byId(fleetMcpServers({ OPENHUB_MCP_SEQTHINK: '0' }), 'sequential-thinking');
    expect(seq.enabled).toBe(false);
    expect(seq.config).toBeUndefined();
    expect(seq.reason).toContain('OPENHUB_MCP_SEQTHINK');
  });

  it('lists every fleet server, disabled ones with the env var to set', () => {
    const servers = fleetMcpServers({});
    expect(servers.map((s) => s.id)).toEqual([
      'sequential-thinking', 'og-glass', 'dev-brain', 'business-logic',
    ]);
    for (const s of servers.filter((x) => !x.enabled)) {
      expect(s.reason, `${s.id} must say why`).toBeTruthy();
      expect(s.config).toBeUndefined();
    }
    expect(byId(servers, 'og-glass').reason).toContain('OPENHUB_MCP_OG_GLASS_DIR');
    expect(byId(servers, 'business-logic').reason).toContain('OPENHUB_MCP_BUSINESS_LOGIC_DIR');
  });

  it('registers a built checkout as a local stdio server', () => {
    const dir = tmpDir();
    tmpFile(dir, 'dist', 'index.js');
    const og = byId(fleetMcpServers({ OPENHUB_MCP_OG_GLASS_DIR: dir }), 'og-glass');
    expect(og.enabled).toBe(true);
    expect(og.config).toEqual({ type: 'local', command: ['node', path.join(dir, 'dist', 'index.js')] });
  });

  it('refuses a checkout that was never built instead of spawning a dead command', () => {
    const dir = tmpDir();
    const og = byId(fleetMcpServers({ OPENHUB_MCP_OG_GLASS_DIR: dir }), 'og-glass');
    expect(og.enabled).toBe(false);
    expect(og.reason).toContain('npm run build');
  });

  it('refuses a configured path that does not exist', () => {
    const og = byId(fleetMcpServers({ OPENHUB_MCP_OG_GLASS_DIR: '/no/such/checkout' }), 'og-glass');
    expect(og.enabled).toBe(false);
    expect(og.reason).toContain('does not exist');
  });

  it('wires the Dev-Brain tsx bridge without a build step', () => {
    const dir = tmpDir();
    tmpFile(dir, 'dev-brain-mcp.ts');
    const db = byId(fleetMcpServers({ OPENHUB_MCP_DEVBRAIN_DIR: dir }), 'dev-brain');
    expect(db.enabled).toBe(true);
    expect(db.config).toEqual({ type: 'local', command: ['npx', '-y', 'tsx', path.join(dir, 'dev-brain-mcp.ts')] });
  });

  it('prefers a remote URL over a directory, validates it, and carries the auth header', () => {
    const remote = byId(
      fleetMcpServers({ OPENHUB_MCP_OG_GLASS_URL: 'http://127.0.0.1:3460/mcp', OPENHUB_MCP_OG_GLASS_DIR: '/no/such' }),
      'og-glass',
    );
    expect(remote.enabled).toBe(true);
    expect(remote.config).toEqual({ type: 'remote', url: 'http://127.0.0.1:3460/mcp' });

    // Behind Caddy basic auth: the Authorization header rides along.
    const gated = byId(
      fleetMcpServers({
        OPENHUB_MCP_OG_GLASS_URL: 'https://design.overlay365.online/mcp',
        OPENHUB_MCP_OG_GLASS_AUTH: 'Basic b3BlcmF0b3I6c2VjcmV0',
      }),
      'og-glass',
    );
    expect(gated.config).toEqual({
      type: 'remote',
      url: 'https://design.overlay365.online/mcp',
      headers: { Authorization: 'Basic b3BlcmF0b3I6c2VjcmV0' },
    });

    const bad = byId(
      fleetMcpServers({ OPENHUB_MCP_OG_GLASS_URL: 'ftp://nope', OPENHUB_MCP_OG_GLASS_DIR: '' }),
      'og-glass',
    );
    expect(bad.enabled).toBe(false);
    expect(bad.reason).toContain('http(s) URL');
  });

  it('activeFleetMcp returns only enabled entries with a config', () => {
    const active = activeFleetMcp({ OPENHUB_MCP_SEQTHINK: '0' });
    expect(active.find((s) => s.id === 'sequential-thinking')).toBeUndefined();
    for (const s of active) expect(s.config).toBeDefined();
  });
});

describe('mergeFleetMcp', () => {
  const local: FleetMcpServer = {
    id: 'og-glass', label: 'OG-Glass', enabled: true,
    config: { type: 'local', command: ['node', 'dist/index.js'] }, source: 'test',
  };

  it('adds fleet servers without touching the rest of the config', () => {
    const merged = mergeFleetMcp({ provider: { openrouter: {} } }, [local]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.added).toEqual(['og-glass']);
    expect(merged.config.provider).toEqual({ openrouter: {} });
    expect(merged.config.mcp).toEqual({ 'og-glass': local.config });
  });

  it("the operator's own MCP entry wins on an id clash", () => {
    const merged = mergeFleetMcp({ mcp: { 'og-glass': { type: 'remote', url: 'http://mine' } } }, [local]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.added).toEqual([]);
    expect(merged.config.mcp).toEqual({ 'og-glass': { type: 'remote', url: 'http://mine' } });
  });

  it('skips disabled servers and never invents a config for them', () => {
    const disabled: FleetMcpServer = { id: 'x', label: 'X', enabled: false, reason: 'not configured', source: 'test' };
    const merged = mergeFleetMcp({}, [disabled, local]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.added).toEqual(['og-glass']);
    expect(merged.config.mcp).not.toHaveProperty('x');
  });

  it('refuses a non-object base instead of overwriting the operator config', () => {
    expect(mergeFleetMcp('not json', [local])).toMatchObject({ ok: false });
    expect(mergeFleetMcp([1, 2, 3], [local])).toMatchObject({ ok: false });
    expect(mergeFleetMcp(null, [local])).toMatchObject({ ok: true });
  });
});

describe('engineConfigOverlay', () => {
  it('returns null when there is nothing to merge', async () => {
    const env = {
      OPENCODE_CONFIG: path.join(tmpDir(), 'missing.json'),
      OPENHUB_MCP_SEQTHINK: '0',
    } as NodeJS.ProcessEnv;
    expect(await engineConfigOverlay(env)).toBeNull();
  });

  it('merges fleet MCP into the operator config, preserving their own servers', async () => {
    const dir = tmpDir();
    tmpFile(dir, 'dist', 'index.js');
    const configPath = tmpFile(dir, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { 'aws-mcp': { type: 'local', command: ['npx', 'aws-mcp'] } },
      provider: { openrouter: { npm: '@ai-sdk/openrouter' } },
    }));
    const env = {
      OPENCODE_CONFIG: configPath,
      OPENHUB_MCP_OG_GLASS_DIR: dir,
      // No local-model vars: the overlay must not need a network probe.
    } as NodeJS.ProcessEnv;

    const overlay = await engineConfigOverlay(env);
    expect(overlay).toBeTruthy();
    const parsed = JSON.parse(overlay as string);
    expect(parsed.mcp['aws-mcp']).toEqual({ type: 'local', command: ['npx', 'aws-mcp'] });
    expect(parsed.mcp['og-glass']).toEqual({ type: 'local', command: ['node', path.join(dir, 'dist', 'index.js')] });
    expect(parsed.mcp['sequential-thinking']).toBeDefined();
    expect(parsed.provider.openrouter).toEqual({ npm: '@ai-sdk/openrouter' });
  });

  it('leaves the engine on the operator file when the config is unparseable', async () => {
    const dir = tmpDir();
    const configPath = tmpFile(dir, 'broken.json');
    fs.writeFileSync(configPath, '{ not json');
    const env = { OPENCODE_CONFIG: configPath } as NodeJS.ProcessEnv;
    expect(await engineConfigOverlay(env)).toBeNull();
  });
});
