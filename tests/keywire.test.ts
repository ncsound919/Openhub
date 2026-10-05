import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { resolveSecret, resolveSecrets } from '../src/services/keywire';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeEmergencySecrets(dir: string, secrets: Record<string, string>) {
  fs.writeFileSync(path.join(dir, 'emergency-secrets.json'), JSON.stringify(secrets));
}

async function startTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a port');
  }
  const url = `http://127.0.0.1:${address.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  return { url, close };
}

describe('resolveSecret — env source', () => {
  it('returns the OPENHUB_SECRET_<NAME> value first', async () => {
    await expect(resolveSecret('X', { OPENHUB_SECRET_X: 'v' })).resolves.toEqual({
      value: 'v',
      source: 'env',
    });
  });

  it('falls back to the unprefixed env name', async () => {
    await expect(
      resolveSecret('GITHUB_CLIENT_SECRET', { GITHUB_CLIENT_SECRET: 'plain' })
    ).resolves.toEqual({ value: 'plain', source: 'env' });
  });
});

describe('resolveSecret — file fallback', () => {
  const unreachableVault = { OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1' };

  it('reads emergency-secrets.json from OPENHUB_KEY_DIR', async () => {
    const dir = tempDir('keywire-file-');
    try {
      writeEmergencySecrets(dir, { X: 'fileval' });
      await expect(resolveSecret('X', { ...unreachableVault, OPENHUB_KEY_DIR: dir })).resolves.toEqual({
        value: 'fileval',
        source: 'file',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to ~/.openhub/emergency-secrets.json', async () => {
    const home = tempDir('keywire-home-');
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      fs.mkdirSync(path.join(home, '.openhub'), { recursive: true });
      writeEmergencySecrets(path.join(home, '.openhub'), { X: 'homeval' });
      await expect(resolveSecret('X', unreachableVault)).resolves.toEqual({
        value: 'homeval',
        source: 'file',
      });
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets env beat the file fallback', async () => {
    const dir = tempDir('keywire-file-');
    try {
      writeEmergencySecrets(dir, { X: 'fileval' });
      await expect(
        resolveSecret('X', { ...unreachableVault, OPENHUB_SECRET_X: 'envval', OPENHUB_KEY_DIR: dir })
      ).resolves.toEqual({ value: 'envval', source: 'env' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveSecret — keywire source', () => {
  it('reads the workload secret map with a bearer token', async () => {
    const seen: { path?: string; authorization?: string } = {};
    const { url, close } = await startTestServer((req, res) => {
      seen.path = req.url;
      seen.authorization = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secrets: { X: 'kv' } }));
    });
    try {
      await expect(
        resolveSecret('X', { OPENHUB_KEYWIRE_URL: url, OPENHUB_KEYWIRE_TOKEN: 'tok' })
      ).resolves.toEqual({ value: 'kv', source: 'keywire' });
      expect(seen.path).toBe('/api/v1/workload/fetch-secrets');
      expect(seen.authorization).toBe('Bearer tok');
    } finally {
      await close();
    }
  });

  it('resolves every name from the vault record shape', async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secrets: { S1: 'sv', S2: 'scv' } }));
    });
    try {
      await expect(resolveSecret('S1', { OPENHUB_KEYWIRE_URL: url, OPENHUB_KEYWIRE_TOKEN: 'tok' })).resolves.toEqual({
        value: 'sv',
        source: 'keywire',
      });
      await expect(resolveSecret('S2', { OPENHUB_KEYWIRE_URL: url, OPENHUB_KEYWIRE_TOKEN: 'tok' })).resolves.toEqual({
        value: 'scv',
        source: 'keywire',
      });
    } finally {
      await close();
    }
  });

  it('falls through to the file fallback when the vault fails', async () => {
    const dir = tempDir('keywire-file-');
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    try {
      writeEmergencySecrets(dir, { X: 'fileval' });
      await expect(
        resolveSecret('X', { OPENHUB_KEYWIRE_URL: url, OPENHUB_KEYWIRE_TOKEN: 'tok', OPENHUB_KEY_DIR: dir })
      ).resolves.toEqual({ value: 'fileval', source: 'file' });
    } finally {
      await close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns explicit null when the vault fails and there is no fallback', async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    try {
      const result = await resolveSecret('X', { OPENHUB_KEYWIRE_URL: url, OPENHUB_KEYWIRE_TOKEN: 'tok' });
      expect(result.value).toBeNull();
      expect(result.source).toBeNull();
      expect(result.error).toContain('no secret source for X');
    } finally {
      await close();
    }
  });

  it('continues to fallback on network failure', async () => {
    await expect(
      resolveSecret('X', { OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1' })
    ).resolves.toMatchObject({ value: null, source: null });
  });
});

describe('resolveSecret — explicit null', () => {
  it('returns the documented error when nothing resolves', async () => {
    await expect(resolveSecret('X', { OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1' })).resolves.toEqual({
      value: null,
      source: null,
      error: 'no secret source for X',
    });
  });
});

describe('resolveSecrets', () => {
  it('resolves multiple names', async () => {
    const result = await resolveSecrets(['A', 'B'], {
      OPENHUB_SECRET_A: 'a',
      OPENHUB_SECRET_B: 'b',
    });
    expect(result.A).toEqual({ value: 'a', source: 'env' });
    expect(result.B).toEqual({ value: 'b', source: 'env' });
  });

  it('keeps explicit nulls for unresolved names', async () => {
    const result = await resolveSecrets(['A', 'MISSING'], { OPENHUB_SECRET_A: 'a', OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1' });
    expect(result.A).toEqual({ value: 'a', source: 'env' });
    expect(result.MISSING).toEqual({ value: null, source: null, error: 'no secret source for MISSING' });
  });
});