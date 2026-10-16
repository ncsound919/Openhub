import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveSecret, resolveSecrets } from '../src/services/vault';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeEmergencySecrets(dir: string, secrets: Record<string, string>) {
  fs.writeFileSync(path.join(dir, 'emergency-secrets.json'), JSON.stringify(secrets));
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

describe('resolveSecret — file fallback (Infisical disabled)', () => {
  const noVault = { OPENHUB_DISABLE_INFISICAL: '1' };

  it('reads emergency-secrets.json from OPENHUB_KEY_DIR', async () => {
    const dir = tempDir('vault-file-');
    try {
      writeEmergencySecrets(dir, { X: 'fileval' });
      await expect(resolveSecret('X', { ...noVault, OPENHUB_KEY_DIR: dir })).resolves.toEqual({
        value: 'fileval',
        source: 'file',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to ~/.openhub/emergency-secrets.json', async () => {
    const home = tempDir('vault-home-');
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      fs.mkdirSync(path.join(home, '.openhub'), { recursive: true });
      writeEmergencySecrets(path.join(home, '.openhub'), { X: 'homeval' });
      await expect(resolveSecret('X', noVault)).resolves.toEqual({
        value: 'homeval',
        source: 'file',
      });
    } finally {
      spy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets env beat the file fallback', async () => {
    const dir = tempDir('vault-file-');
    try {
      writeEmergencySecrets(dir, { X: 'fileval' });
      await expect(
        resolveSecret('X', { ...noVault, OPENHUB_SECRET_X: 'envval', OPENHUB_KEY_DIR: dir })
      ).resolves.toEqual({ value: 'envval', source: 'env' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveSecret — explicit null', () => {
  it('returns the documented error when nothing resolves', async () => {
    await expect(resolveSecret('X', { OPENHUB_DISABLE_INFISICAL: '1' })).resolves.toEqual({
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
    const result = await resolveSecrets(['A', 'MISSING'], { OPENHUB_SECRET_A: 'a', OPENHUB_DISABLE_INFISICAL: '1' });
    expect(result.A).toEqual({ value: 'a', source: 'env' });
    expect(result.MISSING).toEqual({ value: null, source: null, error: 'no secret source for MISSING' });
  });
});
