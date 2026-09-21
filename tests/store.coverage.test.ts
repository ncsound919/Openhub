import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStore, apiHeaders, applyTheme } from '../src/store';
import type { ActiveProject } from '../src/store';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textRes(body: string, status = 200): Response {
  return new Response(body, { status });
}

const project: ActiveProject = {
  repoId: 'repo_1',
  path: 'C:/work/app',
  selectedAt: '2026-01-01T00:00:00.000Z',
  repositoryName: 'acme/app',
  githubFullName: 'acme/app',
  defaultBranch: 'main',
};

function resetState() {
  useStore.setState({
    currentUser: { id: '', username: '', avatarUrl: '' },
    sshKeys: [],
    repositories: [],
    issues: [],
    pullRequests: [],
    actionRuns: [],
    wikiPages: [],
    auditLogs: [],
    branchProtection: [],
    registryItems: [],
    activeProject: null,
    activeProjectLoading: true,
    activeProjectError: null,
    drift: null,
    driftState: 'idle',
    beginnerMode: false,
    theme: 'dark',
  });
}

beforeEach(() => {
  resetState();
  vi.stubGlobal('localStorage', {
    getItem: () => 'test-token',
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal('document', {
    cookie: '__Host-csrf-token=csrf123',
    documentElement: { dataset: {} },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('store — theme helpers', () => {
  it('applyTheme writes the data-theme attribute and survives a hostile DOM', () => {
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { documentElement: { dataset } });
    applyTheme('light');
    expect(dataset.theme).toBe('light');

    vi.stubGlobal('document', {
      documentElement: {
        dataset: {
          set theme(_v: string) {
            throw new Error('read only');
          },
        },
      },
    });
    expect(() => applyTheme('dark')).not.toThrow();
  });

  it('setTheme persists, applies and stores the mode', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn() });
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { documentElement: { dataset } });

    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
    expect(setItem).toHaveBeenCalledWith('openhub.theme', 'light');
    expect(dataset.theme).toBe('light');

    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('dark');
    useStore.getState().toggleTheme();
    expect(useStore.getState().theme).toBe('light');
  });

  it('setTheme tolerates a throwing localStorage (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: vi.fn(),
    });
    expect(() => useStore.getState().setTheme('dark')).not.toThrow();
    expect(useStore.getState().theme).toBe('dark');
  });

  it('toggleBeginnerMode flips the flag', () => {
    expect(useStore.getState().beginnerMode).toBe(false);
    useStore.getState().toggleBeginnerMode();
    expect(useStore.getState().beginnerMode).toBe(true);
    useStore.getState().toggleBeginnerMode();
    expect(useStore.getState().beginnerMode).toBe(false);
  });

  it('setCurrentUser replaces the profile', () => {
    useStore.getState().setCurrentUser({ id: 'u1', username: 'dev', avatarUrl: 'x' });
    expect(useStore.getState().currentUser.username).toBe('dev');
  });
});

describe('store — module init reads persisted theme', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('honours a persisted light theme at import time', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => 'light', setItem: vi.fn(), removeItem: vi.fn() });
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', { documentElement: { dataset } });
    const mod = await import('../src/store');
    expect(mod.useStore.getState().theme).toBe('light');
    expect(dataset.theme).toBe('light');
  });

  it('falls back to dark when storage throws at import time', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const mod = await import('../src/store');
    expect(mod.useStore.getState().theme).toBe('dark');
  });
});

describe('store — apiHeaders', () => {
  it('adds CSRF for mutations and merges extra headers (cookie auth, no bearer)', () => {
    const headers = apiHeaders('POST', { 'X-Extra': '1' });
    // Cookie-first auth: no Authorization header, CSRF double-submit instead.
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-CSRF-Token']).toBe('csrf123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Extra']).toBe('1');
  });

  it('omits CSRF for safe methods and tolerates a broken localStorage', () => {
    expect(apiHeaders('GET')['X-CSRF-Token']).toBeUndefined();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const headers = apiHeaders('DELETE');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-CSRF-Token']).toBe('csrf123');
  });
});

describe('store — refreshDrift', () => {
  it('does nothing without an active project', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await useStore.getState().refreshDrift();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useStore.getState().driftState).toBe('idle');
  });

  it('does nothing while already scanning', async () => {
    useStore.setState({ activeProject: project, driftState: 'scanning' });
    const fetchMock = vi.fn(async () => jsonRes({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await useStore.getState().refreshDrift();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores drift when available', async () => {
    useStore.setState({ activeProject: project });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, drift: { available: true, ahead: 2 } })));
    await useStore.getState().refreshDrift();
    expect(useStore.getState().driftState).toBe('ok');
    expect(useStore.getState().drift?.ahead).toBe(2);
  });

  it('marks drift unavailable when the payload says so', async () => {
    useStore.setState({ activeProject: project });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, drift: { available: false } })));
    await useStore.getState().refreshDrift();
    expect(useStore.getState().drift).toEqual({ available: false });
    expect(useStore.getState().driftState).toBe('unavailable');
  });

  it('marks drift unavailable on a non-ok response and on a thrown fetch', async () => {
    useStore.setState({ activeProject: project });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 500)));
    await useStore.getState().refreshDrift();
    expect(useStore.getState().driftState).toBe('unavailable');

    useStore.setState({ drift: { available: true } as any, driftState: 'idle' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useStore.getState().refreshDrift();
    expect(useStore.getState().drift).toBeNull();
    expect(useStore.getState().driftState).toBe('unavailable');
  });
});

describe('store — fetchActiveProject', () => {
  it('clears context on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 404)));
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProject).toBeNull();
    expect(useStore.getState().activeProjectLoading).toBe(false);
  });

  it('records the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false, error: 'no project' }, 500)));
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProjectError).toBe('no project');
  });

  it('uses a default message when no error is provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false }, 200)));
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProjectError).toContain('Project context request failed (200)');
  });

  it('loads the project and kicks off a drift scan', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/drift')) return jsonRes({ ok: true, drift: { available: true } });
      return jsonRes({ ok: true, project });
    });
    vi.stubGlobal('fetch', fetchMock);
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProject?.repoId).toBe('repo_1');
    expect(useStore.getState().activeProjectLoading).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().driftState).toBe('ok');
  });

  it('reports a thrown request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProjectError).toBe('ECONNREFUSED');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'weird';
    }));
    await useStore.getState().fetchActiveProject();
    expect(useStore.getState().activeProjectError).toBe('Project context unavailable');
  });
});

describe('store — select/unload project', () => {
  it('selects a project and starts a drift scan', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/drift')) return jsonRes({ ok: true, drift: { available: true } });
      return jsonRes({ ok: true, project });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await useStore.getState().selectActiveProject('repo_1');
    expect(result).toEqual({ ok: true });
    expect(useStore.getState().activeProject?.repoId).toBe('repo_1');
    expect(useStore.getState().activeProjectError).toBeNull();
  });

  it('returns the failure from selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false, error: 'nope' })));
    const result = await useStore.getState().selectActiveProject('repo_1');
    expect(result).toEqual({ ok: false, error: 'nope' });
    expect(useStore.getState().activeProjectError).toBe('nope');
  });

  it('uses a default selection error and handles exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false }, 200)));
    expect((await useStore.getState().selectActiveProject('r')).error).toContain('Project selection failed (200)');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('boom');
    }));
    expect(await useStore.getState().selectActiveProject('r')).toEqual({ ok: false, error: 'boom' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'odd';
    }));
    expect((await useStore.getState().selectActiveProject('r')).error).toBe('Project selection unavailable');
  });

  it('unloads on 404 and on success', async () => {
    useStore.setState({ activeProject: project, drift: { available: true } as any, driftState: 'ok' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 404)));
    expect(await useStore.getState().unloadActiveProject()).toEqual({ ok: true });
    expect(useStore.getState().activeProject).toBeNull();
    expect(useStore.getState().driftState).toBe('idle');

    useStore.setState({ activeProject: project });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true })));
    expect(await useStore.getState().unloadActiveProject()).toEqual({ ok: true });
    expect(useStore.getState().activeProject).toBeNull();
  });

  it('reports unload failures and exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false, error: 'locked' })));
    expect(await useStore.getState().unloadActiveProject()).toEqual({ ok: false, error: 'locked' });
    expect(useStore.getState().activeProjectError).toBe('locked');

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: false }, 500)));
    expect((await useStore.getState().unloadActiveProject()).error).toContain('Project unload failed (500)');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('down');
    }));
    expect(await useStore.getState().unloadActiveProject()).toEqual({ ok: false, error: 'down' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'odd';
    }));
    expect((await useStore.getState().unloadActiveProject()).error).toBe('Project unload unavailable');
  });
});

describe('store — scanFile / pipeline', () => {
  it('returns findings or an empty array on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ findings: [{ id: 'f1' }] })));
    expect(await useStore.getState().scanFile('code', 'a.ts')).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await useStore.getState().scanFile('code', 'a.ts')).toEqual([]);
  });

  it('creates a running action on triggerPipeline', async () => {
    useStore.setState({ currentUser: { id: 'u1', username: 'dev', avatarUrl: '' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, data: { id: 'run_9' } })));
    const runId = await useStore.getState().triggerPipeline('repo_1', 'ship');
    expect(runId).toBe('run_9');
    const run = useStore.getState().actionRuns[0];
    expect(run.id).toBe('run_9');
    expect(run.status).toBe('running');
    expect(run.author.id).toBe('u1');
    expect(run.workflowName).toBe('Axiom Project Loop');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await useStore.getState().triggerPipeline('repo_1', 'ship')).toBe('');
  });

  it('updates a run from pipeline status and returns null on failure', async () => {
    useStore.setState({
      actionRuns: [
        {
          id: 'run_9',
          repoId: 'repo_1',
          workflowName: 'CI',
          status: 'running',
          commitMessage: 'x',
          author: { id: '', username: '', avatarUrl: '' },
          createdAt: '',
          duration: '0s',
          stages: [],
          findings: [],
          gates: [],
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({
      ok: true,
      data: {
        status: 'done',
        iteration: 1,
        maxIterations: 8,
        startedAt: 0,
        endedAt: 2000,
        iterations: [{ stages: [{ key: 'typecheck', label: 'Typecheck', status: 'done', ms: 1200 }] }],
      },
    })));
    const data = await useStore.getState().getPipelineStatus('run_9');
    expect(data.status).toBe('done');
    expect(useStore.getState().actionRuns[0].status).toBe('success');
    expect(useStore.getState().actionRuns[0].stages).toHaveLength(1);
    expect(useStore.getState().actionRuns[0].stages[0].name).toBe('Typecheck');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await useStore.getState().getPipelineStatus('run_9')).toBeNull();
  });
});

describe('store — audit logs', () => {
  it('prepends an audit entry', async () => {
    useStore.setState({ currentUser: { id: 'u1', username: 'dev', avatarUrl: '' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ id: 'log_1', created_at: '2026-01-01' })));
    await useStore.getState().logAuditAction('push', 'details', 'repo_1');
    const log = useStore.getState().auditLogs[0];
    expect(log.id).toBe('log_1');
    expect(log.timestamp).toBe('2026-01-01');
    expect(log.ip).toBe('');
  });

  it('silently ignores failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(useStore.getState().logAuditAction('push', 'd', 'r')).resolves.toBeUndefined();
    expect(useStore.getState().auditLogs).toEqual([]);
  });
});

describe('store — fetch collections', () => {
  it('maps repositories from a data envelope or a bare array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ data: [{ id: 'r1', name: 'app', owner_name: 'acme', is_private: 1, updated_at: 't', default_branch: 'dev' }] })));
    await useStore.getState().fetchRepositories();
    expect(useStore.getState().repositories[0].owner).toBe('acme');
    expect(useStore.getState().repositories[0].isPrivate).toBe(true);
    expect(useStore.getState().repositories[0].defaultBranch).toBe('dev');

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes([{ id: 'r2', name: 'bare', updated_at: 't' }])));
    await useStore.getState().fetchRepositories();
    expect(useStore.getState().repositories[0].owner).toBe('unknown');
    expect(useStore.getState().repositories[0].defaultBranch).toBe('main');
  });

  it('ignores non-ok and rejected repository fetches', async () => {
    useStore.setState({ repositories: [] });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 500)));
    await useStore.getState().fetchRepositories();
    expect(useStore.getState().repositories).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useStore.getState().fetchRepositories();
    expect(useStore.getState().repositories).toEqual([]);
  });

  it('fetches registry items (envelope, bare array, non-ok, rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ data: [{ id: 'i1' }] })));
    await useStore.getState().fetchRegistryItems();
    expect(useStore.getState().registryItems).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes([{ id: 'i2' }])));
    await useStore.getState().fetchRegistryItems();
    expect(useStore.getState().registryItems[0].id).toBe('i2');

    useStore.setState({ registryItems: [] });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 503)));
    await useStore.getState().fetchRegistryItems();
    expect(useStore.getState().registryItems).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useStore.getState().fetchRegistryItems();
    expect(useStore.getState().registryItems).toEqual([]);
  });

  it('fetches SSH keys (mapping, non-ok, rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes([{ id: 'k1', title: 'laptop', public_key: 'ssh-x', created_at: 't' }])));
    await useStore.getState().fetchSSHKeys();
    expect(useStore.getState().sshKeys[0]).toEqual({ id: 'k1', title: 'laptop', key: 'ssh-x', createdAt: 't' });

    useStore.setState({ sshKeys: [] });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 500)));
    await useStore.getState().fetchSSHKeys();
    expect(useStore.getState().sshKeys).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useStore.getState().fetchSSHKeys();
    expect(useStore.getState().sshKeys).toEqual([]);
  });
});

describe('store — SSH key mutations', () => {
  it('adds and deletes a key, ignoring failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ id: 'k1', title: 'laptop', public_key: 'ssh-x', created_at: 't' })));
    await useStore.getState().addSSHKey('laptop', 'ssh-x');
    expect(useStore.getState().sshKeys[0].key).toBe('ssh-x');

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({})));
    await useStore.getState().deleteSSHKey('k1');
    expect(useStore.getState().sshKeys).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(useStore.getState().addSSHKey('x', 'y')).resolves.toBeUndefined();
    await expect(useStore.getState().deleteSSHKey('k1')).resolves.toBeUndefined();
  });
});

describe('store — createRepo', () => {
  it('creates a repository', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ id: 'r9', owner_name: 'acme', name: 'new', description: 'd', is_private: 0, created_at: 't' })));
    const repo = await useStore.getState().createRepo('new', 'd', false);
    expect(repo?.id).toBe('r9');
    expect(useStore.getState().repositories[0].id).toBe('r9');
  });

  it('returns null on failure and on exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 500)));
    expect(await useStore.getState().createRepo('a', 'b', false)).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await useStore.getState().createRepo('a', 'b', false)).toBeNull();
  });
});

describe('store — importLocalFolder', () => {
  it('imports, refreshes, unloads the old project and selects the new one', async () => {
    useStore.setState({ activeProject: { ...project, repoId: 'old' } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/repos/import-local') return jsonRes({ id: 'new1' });
      if (u === '/api/repos') return jsonRes({ data: [] });
      if (u === '/api/project/active' && method === 'DELETE') return jsonRes({ ok: true });
      if (u === '/api/project/active' && method === 'POST') return jsonRes({ ok: true, project });
      if (u.includes('/drift')) return jsonRes({ ok: true, drift: { available: true } });
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await useStore.getState().importLocalFolder('C:/work/app', 'app');
    expect(result).toEqual({ ok: true });
    expect(useStore.getState().activeProject?.repoId).toBe('repo_1');
    const calls = fetchMock.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`);
    expect(calls).toContain('DELETE /api/project/active');
    expect(calls).toContain('POST /api/project/active');
  });

  it('keeps the active project when it is already the imported one', async () => {
    useStore.setState({ activeProject: { ...project, repoId: 'new1' } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/repos/import-local') return jsonRes({ id: 'new1' });
      if (u === '/api/repos') return jsonRes({ data: [] });
      if (u === '/api/project/active' && method === 'POST') return jsonRes({ ok: true, project });
      return jsonRes({});
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await useStore.getState().importLocalFolder('C:/work/app')).toEqual({ ok: true });
    const calls = fetchMock.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`);
    expect(calls).not.toContain('DELETE /api/project/active');
  });

  it('reports import failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'bad path' })));
    expect(await useStore.getState().importLocalFolder('x')).toEqual({ ok: false, error: 'bad path' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({}, 500)));
    expect((await useStore.getState().importLocalFolder('x')).error).toContain('Import failed (500)');
  });

  it('reports a failed selection and exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/repos/import-local') return jsonRes({ id: 'new1' });
      if (u === '/api/repos') return jsonRes({ data: [] });
      if (u === '/api/project/active' && method === 'POST') return jsonRes({ ok: false, error: 'denied' });
      return jsonRes({});
    }));
    expect(await useStore.getState().importLocalFolder('x')).toEqual({ ok: false, error: 'denied' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('kaboom');
    }));
    expect(await useStore.getState().importLocalFolder('x')).toEqual({ ok: false, error: 'kaboom' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'odd';
    }));
    expect((await useStore.getState().importLocalFolder('x')).error).toBe('Import unavailable');
  });
});

describe('store — registry mutations', () => {
  it('adds a registry item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ id: 'i9', name: 'tool' })));
    await useStore.getState().addRegistryItem({ name: 'tool', type: 'cli', description: 'd', author: 'me', version: '1' });
    expect(useStore.getState().registryItems[0].id).toBe('i9');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(useStore.getState().addRegistryItem({ name: 'x', type: 'cli', description: '', author: '', version: '' })).resolves.toBeUndefined();
  });

  it('updates a registry item status and ignores failures', async () => {
    useStore.setState({ registryItems: [{ id: 'i1', name: 'tool', type: 'cli', description: '', status: 'active', author: '', version: '1' }] });
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({})));
    await useStore.getState().updateRegistryItemStatus('i1', 'inactive');
    expect(useStore.getState().registryItems[0].status).toBe('inactive');

    useStore.setState({ registryItems: [{ id: 'i1', name: 'tool', type: 'cli', description: '', status: 'active', author: '', version: '1' }] });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await useStore.getState().updateRegistryItemStatus('i1', 'error');
    expect(useStore.getState().registryItems[0].status).toBe('active');
  });
});
