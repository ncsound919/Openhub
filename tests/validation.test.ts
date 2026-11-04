import { describe, expect, it } from 'vitest';
import {
  SshKeySchema,
  GitHubImportSchema,
  PushSyncSchema,
  GenerateTestsSchema,
  parseBody,
} from '../src/services/validation';

describe('validation helpers', () => {
  it('accepts a valid SSH key', () => {
    const result = parseBody(SshKeySchema, { title: 'laptop', key: 'ssh-ed25519 AAAA' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe('laptop');
      expect(result.data.key).toBe('ssh-ed25519 AAAA');
    }
  });

  it('rejects a missing SSH key title', () => {
    const result = parseBody(SshKeySchema, { key: 'ssh-ed25519 AAAA' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expected string');
  });

  it('rejects an empty SSH key title with the field-specific message', () => {
    const result = parseBody(SshKeySchema, { title: '', key: 'ssh-ed25519 AAAA' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Title required');
  });

  it('rejects unsafe GitHub names', () => {
    expect(parseBody(GitHubImportSchema, { owner: '../etc', repo: 'repo' }).ok).toBe(false);
    expect(parseBody(GitHubImportSchema, { owner: 'owner', repo: 'a/b' }).ok).toBe(false);
    expect(parseBody(GitHubImportSchema, { owner: '.', repo: 'repo' }).ok).toBe(false);
  });

  it('accepts a safe GitHub import', () => {
    const result = parseBody(GitHubImportSchema, { owner: 'octocat', repo: 'hello-world' });
    expect(result.ok).toBe(true);
  });

  it('requires repoName and filePath for push sync', () => {
    expect(parseBody(PushSyncSchema, { repoName: 'r' }).ok).toBe(false);
    const result = parseBody(PushSyncSchema, { repoName: 'r', filePath: 'a.txt', content: 'hi' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.content).toBe('hi');
  });

  it('requires a non-empty file path for test generation', () => {
    expect(parseBody(GenerateTestsSchema, { file: '' }).ok).toBe(false);
    expect(parseBody(GenerateTestsSchema, { file: 'src/foo.ts' }).ok).toBe(true);
  });

  it('reports a readable error for a non-object body', () => {
    const result = parseBody(GenerateTestsSchema, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});
