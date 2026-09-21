import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'openhub.theme';

function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Reflect the theme on <html data-theme> so the CSS token set switches. */
export function applyTheme(theme: ThemeMode): void {
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    /* non-DOM environment */
  }
}

const INITIAL_THEME = readStoredTheme();
applyTheme(INITIAL_THEME);

export type User = {
  id: string;
  username: string;
  avatarUrl: string;
};

export type FileNode = {
  name: string;
  type: 'file' | 'dir';
  content?: string;
  size?: number;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  children?: FileNode[];
};

export type Repository = {
  id: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  stars: number;
  forks: number;
  language: string;
  updatedAt: string;
  defaultBranch: string;
  branches: string[];
  files: FileNode[];
};

export type Issue = {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: User;
  createdAt: string;
  comments: number;
  labels: { name: string; color: string }[];
};

export type PullRequest = {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: User;
  createdAt: string;
  sourceBranch: string;
  targetBranch: string;
  comments: number;
};

export type SecurityFinding = {
  id: string;
  type: 'SAST' | 'SCA' | 'Secret' | 'DAST' | 'IaC';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  file?: string;
  line?: number;
  description: string;
  status: 'open' | 'resolved' | 'ignored';
};

export type QualityGate = {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'warning';
  value: string;
  threshold: string;
};

export type PipelineStage = {
  id: string;
  name: string;
  status: 'success' | 'failure' | 'running' | 'pending' | 'skipped';
  duration?: string;
  logs?: string[];
};

export type ActionRun = {
  id: string;
  repoId: string;
  workflowName: string;
  status: 'success' | 'failure' | 'running' | 'queued';
  commitMessage: string;
  author: User;
  createdAt: string;
  duration: string;
  stages: PipelineStage[];
  findings: SecurityFinding[];
  gates: QualityGate[];
  sbomUrl?: string;
  signatureVerified?: boolean;
};

export type AuditLogEntry = {
  id: string;
  repoId: string;
  action: string;
  user: User;
  timestamp: string;
  ip: string;
  details: string;
};

export type BranchProtectionRule = {
  id: string;
  repoId: string;
  pattern: string;
  requireReviews: boolean;
  requireCI: boolean;
  enforceAdmins: boolean;
  signedCommits: boolean;
};

export type WikiPage = {
  id: string;
  repoId: string;
  title: string;
  content: string;
  updatedAt: string;
};

export type RegistryItemType = 'cli' | 'mcp' | 'cron' | 'agent';

export type RegistryItem = {
  id: string;
  name: string;
  type: RegistryItemType;
  description: string;
  status: 'active' | 'inactive' | 'error';
  lastRun?: string;
  config?: any;
  author: string;
  version: string;
};

export type SSHKey = {
  id: string;
  title: string;
  key: string;
  createdAt: string;
};

/** The one persisted project context shared by Workspace, Axiom, audit, repair, and GitHub. */
export type ActiveProject = {
  repoId: string;
  path: string;
  selectedAt: string;
  repositoryName: string;
  githubFullName: string | null;
  defaultBranch: string | null;
};

/** Local working tree vs last pushed state. Refreshed automatically on project load. */
export type ProjectDrift = {
  available: boolean;
  fetched: boolean;
  hasUpstream: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  uncommitted: number;
  files: string[];
  stat: string | null;
  lastPush: string | null;
  reason?: string;
};

interface OpenHubStore {
  currentUser: User;
  sshKeys: SSHKey[];
  repositories: Repository[];
  issues: Issue[];
  pullRequests: PullRequest[];
  actionRuns: ActionRun[];
  wikiPages: WikiPage[];
  auditLogs: AuditLogEntry[];
  branchProtection: BranchProtectionRule[];
  registryItems: RegistryItem[];
  activeProject: ActiveProject | null;
  activeProjectLoading: boolean;
  activeProjectError: string | null;
  fetchActiveProject: () => Promise<void>;
  selectActiveProject: (repoId: string) => Promise<{ ok: boolean; error?: string }>;
  unloadActiveProject: () => Promise<{ ok: boolean; error?: string }>;
  drift: ProjectDrift | null;
  driftState: 'idle' | 'scanning' | 'ok' | 'unavailable';
  /** Fire-and-forget drift scan; never blocks the caller. */
  refreshDrift: () => Promise<void>;
  beginnerMode: boolean;
  toggleBeginnerMode: () => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setCurrentUser: (user: User) => void;
  scanFile: (content: string, fileName: string) => Promise<SecurityFinding[]>;
  triggerPipeline: (repoId: string, commitMessage: string) => Promise<string>;
  getPipelineStatus: (runId: string) => Promise<any>;
  logAuditAction: (action: string, details: string, repoId: string) => Promise<void>;
  fetchRepositories: () => Promise<void>;
  fetchRegistryItems: () => Promise<void>;
  fetchSSHKeys: () => Promise<void>;
  addSSHKey: (title: string, key: string) => Promise<void>;
  deleteSSHKey: (id: string) => Promise<void>;
  createRepo: (name: string, description: string, isPrivate: boolean) => Promise<Repository | null>;
  /** Register a local folder and make it the active project (unloads any current one). */
  importLocalFolder: (path: string, name?: string) => Promise<{ ok: boolean; error?: string }>;
  addRegistryItem: (item: Omit<RegistryItem, 'id' | 'status'>) => Promise<void>;
  updateRegistryItemStatus: (id: string, status: RegistryItem['status']) => Promise<void>;
}

import { getCsrfToken } from './auth/AuthProvider';

export const apiHeaders = (method?: string, extra?: Record<string, string>) => {
  // Cookie-first auth: no Authorization header. Mutations carry the CSRF
  // double-submit token the server requires for the cookie strategy.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return headers;
};

export const useStore = create<OpenHubStore>((set, get) => ({
  beginnerMode: false,
  toggleBeginnerMode: () => set((state) => ({ beginnerMode: !state.beginnerMode })),
  theme: INITIAL_THEME,
  setTheme: (theme) => {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
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

  refreshDrift: async () => {
    const { activeProject, driftState } = get();
    if (!activeProject || driftState === 'scanning') return;
    set({ driftState: 'scanning' });
    try {
      const res = await fetch('/api/project/active/drift', { credentials: 'include', headers: apiHeaders() });
      const data = await res.json();
      if (res.ok && data.ok && data.drift) {
        set({ drift: data.drift as ProjectDrift, driftState: data.drift.available ? 'ok' : 'unavailable' });
      } else {
        set({ drift: null, driftState: 'unavailable' });
      }
    } catch {
      set({ drift: null, driftState: 'unavailable' });
    }
  },

  fetchActiveProject: async () => {
    set({ activeProjectLoading: true, activeProjectError: null });
    try {
      const res = await fetch('/api/project/active', { credentials: 'include', headers: apiHeaders() });
      if (res.status === 404) {
        set({ activeProject: null, activeProjectLoading: false });
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.ok) {
        set({ activeProject: null, activeProjectLoading: false, activeProjectError: data.error || `Project context request failed (${res.status})` });
        return;
      }
      set({ activeProject: data.project as ActiveProject, activeProjectLoading: false });
      // Automatic: scan local vs last push the moment a project context exists.
      void get().refreshDrift();
    } catch (err) {
      set({ activeProject: null, activeProjectLoading: false, activeProjectError: err instanceof Error ? err.message : 'Project context unavailable' });
    }
  },

  selectActiveProject: async (repoId) => {
    try {
      const res = await fetch('/api/project/active', {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders('POST'),
        body: JSON.stringify({ repoId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const error = data.error || `Project selection failed (${res.status})`;
        set({ activeProjectError: error });
        return { ok: false, error };
      }
      set({ activeProject: data.project as ActiveProject, activeProjectError: null });
      // Automatic: scan local vs last push right after selection — no button required.
      void get().refreshDrift();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Project selection unavailable';
      set({ activeProjectError: error });
      return { ok: false, error };
    }
  },

  unloadActiveProject: async () => {
    try {
      const res = await fetch('/api/project/active', { method: 'DELETE', credentials: 'include', headers: apiHeaders('DELETE') });
      if (res.status === 404) {
        set({ activeProject: null, activeProjectError: null, drift: null, driftState: 'idle' });
        return { ok: true };
      }
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const error = data.error || `Project unload failed (${res.status})`;
        set({ activeProjectError: error });
        return { ok: false, error };
      }
      set({ activeProject: null, activeProjectError: null, drift: null, driftState: 'idle' });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Project unload unavailable';
      set({ activeProjectError: error });
      return { ok: false, error };
    }
  },

  setCurrentUser: (user) => set({ currentUser: user }),

  scanFile: async (content: string, fileName: string) => {
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ content, fileName }),
      });
      const data = await res.json();
      return data.findings;
    } catch {
      return [];
    }
  },

  triggerPipeline: async (repoId: string, commitMessage: string) => {
    try {
      // Axiom is the single execution engine. A "pipeline run" is an Axiom
      // project loop against the active project; verification stages and gate
      // decisions come from Axiom's executed checks, never from the client.
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ goal: commitMessage || 'Run the project verification loop' }),
      });
      const body = await res.json();
      const runId: string | undefined = body?.data?.id;
      if (!runId) return '';
      const newRun: ActionRun = {
        id: runId,
        repoId,
        workflowName: 'Axiom Project Loop',
        status: 'running',
        commitMessage,
        author: get().currentUser,
        createdAt: new Date().toISOString(),
        duration: '0s',
        stages: [],
        findings: [],
        gates: [],
      };
      set((s) => ({ actionRuns: [newRun, ...s.actionRuns] }));
      return runId;
    } catch {
      return '';
    }
  },

  getPipelineStatus: async (runId: string) => {
    try {
      const res = await fetch(`/api/axiom/project/status/${encodeURIComponent(runId)}`, { headers: apiHeaders() });
      const body = await res.json();
      const data = body?.data;
      if (!data) return null;
      const mapStage = (st: any, index: number): PipelineStage => {
        const status: PipelineStage['status'] =
          st?.status === 'done' ? 'success'
          : st?.status === 'failed' ? 'failure'
          : st?.status === 'running' ? 'running'
          : st?.status === 'skipped' ? 'skipped'
          : 'pending';
        return {
          id: String(st?.key ?? st?.name ?? `stage-${index}`),
          name: String(st?.label ?? st?.name ?? 'stage'),
          status,
          ...(typeof st?.ms === 'number' ? { duration: `${(st.ms / 1000).toFixed(1)}s` } : {}),
          ...(st?.summary ? { logs: [String(st.summary)] } : {}),
        };
      };
      const iterations = Array.isArray(data.iterations) ? data.iterations : [];
      const latest = iterations.length ? iterations[iterations.length - 1] : null;
      const stages: PipelineStage[] = Array.isArray(latest?.stages) ? latest.stages.map(mapStage) : [];
      const status: ActionRun['status'] =
        data.status === 'running' ? 'running' : data.status === 'done' ? 'success' : 'failure';
      const duration =
        typeof data.endedAt === 'number' && typeof data.startedAt === 'number'
          ? `${((data.endedAt - data.startedAt) / 1000).toFixed(1)}s`
          : undefined;
      set((s) => ({
        actionRuns: s.actionRuns.map((r) =>
          r.id === runId ? { ...r, status, stages, ...(duration ? { duration } : {}) } : r
        ),
      }));
      return { ...data, stages };
    } catch {
      return null;
    }
  },

  logAuditAction: async (action: string, details: string, repoId: string) => {
    try {
      const res = await fetch('/api/audit-logs', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ action, details, repoId }),
      });
      const log = await res.json();
      set((s) => ({
        auditLogs: [{ ...log, user: get().currentUser, timestamp: log.created_at, ip: '' }, ...s.auditLogs],
      }));
    } catch {
      // silently fail
    }
  },

  fetchRepositories: async () => {
    try {
      const res = await fetch('/api/repos', { headers: apiHeaders() });
      if (!res.ok) return;
      const payload = await res.json();
      const repos = payload.data || payload;
      set({
        repositories: repos.map((r: any) => ({
          id: r.id,
          owner: r.owner_name || 'unknown',
          name: r.name,
          description: r.description || '',
          isPrivate: !!r.is_private,
          stars: 0,
          forks: 0,
          language: r.language || '',
          updatedAt: r.updated_at,
          defaultBranch: r.default_branch || 'main',
          branches: [r.default_branch || 'main'],
          files: [],
        })),
      });
    } catch {
      // offline
    }
  },

  fetchRegistryItems: async () => {
    try {
      const res = await fetch('/api/registry', { headers: apiHeaders() });
      if (!res.ok) return;
      const payload = await res.json();
      const items = payload.data || payload;
      set({ registryItems: items });
    } catch {
      // offline
    }
  },

  fetchSSHKeys: async () => {
    try {
      const res = await fetch('/api/settings/ssh-keys', { headers: apiHeaders() });
      if (!res.ok) return;
      const keys = await res.json();
      set({ sshKeys: keys.map((k: any) => ({ id: k.id, title: k.title, key: k.public_key, createdAt: k.created_at })) });
    } catch {
      // offline
    }
  },

  addSSHKey: async (title, key) => {
    try {
      const res = await fetch('/api/settings/ssh-keys', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ title, key }),
      });
      if (!res.ok) return;
      const newKey = await res.json();
      if (!newKey?.id) return;
      set((s) => ({ sshKeys: [{ id: newKey.id, title: newKey.title, key: newKey.public_key, createdAt: newKey.created_at }, ...s.sshKeys] }));
    } catch {
      // offline
    }
  },

  deleteSSHKey: async (id) => {
    try {
      const res = await fetch(`/api/settings/ssh-keys/${id}`, { method: 'DELETE', credentials: 'include', headers: apiHeaders('DELETE') });
      if (!res.ok) return;
      set((s) => ({ sshKeys: s.sshKeys.filter((k) => k.id !== id) }));
    } catch {
      // offline
    }
  },

  createRepo: async (name, description, isPrivate) => {
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ name, description, isPrivate }),
      });
      if (!res.ok) return null;
      const r = await res.json();
      const newRepo: Repository = {
        id: r.id,
        owner: r.owner_name,
        name: r.name,
        description: r.description,
        isPrivate: !!r.is_private,
        stars: 0,
        forks: 0,
        language: '',
        updatedAt: r.created_at,
        defaultBranch: 'main',
        branches: ['main'],
        files: [],
      };
      set((s) => ({ repositories: [newRepo, ...s.repositories] }));
      return newRepo;
    } catch {
      return null;
    }
  },

  importLocalFolder: async (folderPath, name) => {
    try {
      const res = await fetch('/api/repos/import-local', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify({ path: folderPath, name }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) {
        return { ok: false, error: data.error || `Import failed (${res.status})` };
      }
      await get().fetchRepositories();
      // One project context at a time: unload first, then select the folder.
      if (get().activeProject && get().activeProject?.repoId !== data.id) {
        await get().unloadActiveProject();
      }
      const selected = await get().selectActiveProject(data.id);
      if (!selected.ok) return { ok: false, error: selected.error };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Import unavailable' };
    }
  },

  addRegistryItem: async (item) => {
    try {
      const res = await fetch('/api/registry', {
        method: 'POST',
        credentials: 'include', headers: apiHeaders('POST'),
        body: JSON.stringify(item),
      });
      if (!res.ok) return;
      const newItem = await res.json();
      if (!newItem?.id) return;
      set((s) => ({ registryItems: [newItem, ...s.registryItems] }));
    } catch {
      // offline
    }
  },

  updateRegistryItemStatus: async (id, status) => {
    try {
      const res = await fetch(`/api/registry/${id}`, {
        method: 'PATCH',
        credentials: 'include', headers: apiHeaders('PATCH'),
        body: JSON.stringify({ status }),
      });
      if (!res.ok) return;
      set((s) => ({
        registryItems: s.registryItems.map((item) =>
          item.id === id ? { ...item, status } : item
        ),
      }));
    } catch {
      // offline
    }
  },
}));
