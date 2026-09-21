import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import {
  Files, Search, GitBranch, Package, Settings, Terminal as TerminalIcon,
  X, Play, Save, ChevronRight, RefreshCw, GitCommitHorizontal, Upload,
  Cpu, Loader2, CircleDot, Github, Check, Zap, Wrench, Square, Bot, Orbit, Activity, Plus,
  Server, FileDiff, GitBranchPlus, ChevronDown, CornerDownRight, AlertTriangle, ListTree, Wand2, FilePlus2, Layers, Rocket, ShieldCheck,
} from 'lucide-react';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import { useStore } from '../store';
import { driftTaskText, matchSkills, type Matchable } from '../lib/skillMatch';
import { useModelStore } from '../lib/modelStore';
import { DevAssistant } from '../components/DevAssistant';
import { AgentDock } from './AgentDock';
import { AxiomBar } from './AxiomBar';
import { usePipelineContext } from './PipelineProvider';
import { registerAxiomMonaco, setAxiomMonacoOptions, getAxiomTabStats, subscribeAxiomTabStats } from './monacoProviders';
import {
  axiomEditorModelCatalog,
  axiomEditorModels,
  axiomEditorSetModel,
  axiomEditorWarm,
  axiomEditorWarmStart,
  axiomEditorDiagnostics,
  type EditorModelCatalogResult,
  type EditorModelsResult,
} from './axiomEditorClient';
import { toMonacoMarkers, lspLanguageSupported, type LspDiagnostic } from './lspDiagnostics';
import { modelPickerOptions, parseModelCatalog } from './editorModelCatalog';
import { FileTree, type TreeNode } from './FileTree';
import { TerminalView } from './TerminalView';
import { ServicesDock } from './ServicesDock';
import { ExtensionsPanel } from './ExtensionsPanel';
import { ComposerPanel } from './ComposerPanel';
import { MultibufferReviewPanel } from './MultibufferReviewPanel';
import { ThreadsPanel } from './ThreadsPanel';
import { cn } from '../lib/utils';

const VisualizerPanel = lazy(() => import('./visualize/VisualizerPanel').then((m) => ({ default: m.VisualizerPanel })));

type Tab = { path: string; name: string; language: string; content: string; dirty: boolean };

type GitFile = { status: string; path: string };
type GitState = {
  branch: string | null;
  head: string | null;
  subject: string | null;
  changed: string[];
  remote: string | null;
};

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', json: 'json', md: 'markdown', css: 'css', html: 'html',
  yaml: 'yaml', yml: 'yaml', sql: 'sql', sh: 'shell', ps1: 'powershell',
  cpp: 'cpp', c: 'c', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  php: 'php', xml: 'xml', svg: 'xml', toml: 'ini', ini: 'ini', env: 'ini',
};

function parsePorcelain(lines: string[]): GitFile[] {
  return lines
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      if (l.startsWith('??')) return { status: '?', path: l.slice(2).trim() };
      if (l.startsWith('!!')) return { status: '!', path: l.slice(2).trim() };
      const status = l[0] !== ' ' ? l[0] : l[1] !== ' ' ? l[1] : ' ';
      return { status, path: l.slice(3).trim() };
    })
    .filter((f) => f.status !== '!');
}

const STATUS_TONE: Record<string, string> = {
  M: 'text-[var(--color-warning)]',
  A: 'text-[var(--color-success)]',
  D: 'text-[var(--color-danger)]',
  R: 'text-[var(--color-info)]',
  U: 'text-[var(--color-warning)]',
  '?': 'text-[var(--color-text-secondary)]',
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const safeInt = (value: string | null, fallback: number) => {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

// Code intelligence (D1/D2)
type TsProblem = { file: string; line: number; col: number; code: string; message: string };
type OutlineItem = { name: string; kind: string; line: number; depth: number };
type MonacoApi = Parameters<OnMount>[1];
type EditorApi = Parameters<OnMount>[0];

export function WorkspacePage() {
  const { activeProject, activeProjectLoading, activeProjectError, fetchActiveProject,
    drift, driftState, refreshDrift, registryItems, fetchRegistryItems, theme } = useStore();
  // One pipeline controller for the whole workspace: the command bar and the
  // empty-editor actions start the same job, and only one poller exists.
  const pipeline = usePipelineContext();
  const [activePanel, setActivePanel] = useState<'explorer' | 'search' | 'git' | 'agent' | 'extensions' | 'autonomy' | 'services' | 'visualize' | 'problems' | 'outline' | 'composer' | 'review' | 'threads'>('agent');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showCopilot, setShowCopilot] = useState(true);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [gitBusy, setGitBusy] = useState<'commit' | 'push' | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [copilotWidth, setCopilotWidth] = useState(() => safeInt(localStorage.getItem('openhub.ws.copilot'), 380));
  const [agents, setAgents] = useState<Matchable[]>([]);
  const [loopGoal, setLoopGoal] = useState('');
  const [loopBusy, setLoopBusy] = useState(false);
  const [loopId, setLoopId] = useState<string | null>(null);
  const [loopStatus, setLoopStatus] = useState<string | null>(null);
  const [axiomOnline, setAxiomOnline] = useState<boolean | null>(null);
  // Tab completion prefs (Cursor-style Tab status cluster, bottom-right).
  // Persisted per browser; applied live via setAxiomMonacoOptions so no
  // editor remount is needed (providers read liveOpts on every call).
  const [tabPrefs, setTabPrefs] = useState(() => {
    try {
      const raw = localStorage.getItem('openhub.tab.prefs');
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ enabled: boolean; delayMs: number; singleLine: boolean; model: string }>;
        return {
          enabled: p.enabled !== false,
          delayMs: [0, 150, 500].includes(p.delayMs ?? 0) ? (p.delayMs ?? 0) : 0,
          singleLine: p.singleLine === true,
          model: typeof p.model === 'string' ? p.model : '',
        };
      }
    } catch { /* corrupt — defaults */ }
    return { enabled: true, delayMs: 0, singleLine: false, model: '' };
  });
  const [tabOpen, setTabOpen] = useState(false);
  const [tabModelDetail, setTabModelDetail] = useState<string | null>(null);
  const [tabWarm, setTabWarm] = useState<string | null>(null);
  const [editorModels, setEditorModels] = useState<EditorModelsResult | null>(null);
  const [editorCatalog, setEditorCatalog] = useState<EditorModelCatalogResult | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSave, setModelSave] = useState<'saving' | 'saved' | 'error' | null>(null);
  // Last message from Axiom's editor lanes (Tab completion / Ctrl+I). Previously
  // went to console.warn only, so failed or offline completions vanished.
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const [, setTabTick] = useState(0);
  useEffect(() => {
    localStorage.setItem('openhub.tab.prefs', JSON.stringify(tabPrefs));
    setAxiomMonacoOptions({
      completionEnabled: tabPrefs.enabled,
      completionDelayMs: tabPrefs.delayMs,
      singleLine: tabPrefs.singleLine,
      model: tabPrefs.model || undefined,
    });
  }, [tabPrefs]);
  // Re-render the Tab status cluster only when stats actually change (was a
  // permanent 2s interval that re-rendered the whole page on a timer).
  useEffect(() => subscribeAxiomTabStats(() => setTabTick((n) => n + 1)), []);
  // Dismiss the editor-model menu on Escape or a click outside it.
  const modelMenuRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModelMenuOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [modelMenuOpen]);
  const openTabPopover = async () => {
    setTabOpen((v) => !v);
    void refreshWarm();
    if (tabModelDetail !== null) return;
    try {
      const res = await fetch('/api/axiom/capabilities', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      const caps = Array.isArray(json?.data) ? json.data : Array.isArray(json?.capabilities) ? json.capabilities : [];
      const entry = caps.find((c: { id?: string }) => c?.id === 'editor') as { detail?: string } | undefined;
      setTabModelDetail(typeof entry?.detail === 'string' ? entry.detail : 'model status unavailable');
    } catch {
      setTabModelDetail('model status unavailable');
    }
    await refreshEditorModels();
    await refreshEditorCatalog();
  };
  const refreshEditorModels = async () => {
    try {
      const res = await axiomEditorModels();
      setEditorModels(res.data ?? null);
    } catch {
      setEditorModels(null);
    }
  };
  const refreshEditorCatalog = async () => {
    try {
      const res = await axiomEditorModelCatalog();
      setEditorCatalog(res.data ?? null);
    } catch {
      setEditorCatalog(null);
    }
  };
  const refreshWarm = async () => {
    try {
      const w = await axiomEditorWarm();
      const t = w.data?.target;
      setTabWarm(t
        ? `${t.model ?? 'local'} · ${w.data?.keepalive ? 'keepalive on' : 'idle'}`
        : 'no local model configured');
    } catch {
      setTabWarm('warm status unavailable');
    }
  };
  // Pick an editor model: apply it to the next Tab/inline-edit request and
  // persist it as Axiom's default through the proxy (POST /axiom/editor/model).
  const chooseEditorModel = async (model: string) => {
    setTabPrefs((p) => ({ ...p, model }));
    setModelMenuOpen(false);
    if (!model) return;
    setModelSave('saving');
    try {
      await axiomEditorSetModel(model);
      setModelSave('saved');
    } catch {
      setModelSave('error');
    }
    setTimeout(() => setModelSave(null), 2500);
  };
  const editorModelOptions = React.useMemo(
    () => modelPickerOptions(parseModelCatalog(editorCatalog), {
      configured: editorModels?.configured ?? null,
      models: editorModels?.models ?? [],
    }),
    [editorCatalog, editorModels],
  );
  // Diff review (A2)
  const [viewMode, setViewMode] = useState<'edit' | 'diff'>('edit');
  const [diffData, setDiffData] = useState<{ path: string; original: string; modified: string } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  // Branches (A3)
  const [branchList, setBranchList] = useState<{ current: string | null; branches: string[] } | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  // Search (A4)
  const [searchResults, setSearchResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Code intelligence (D1/D2)
  const [problems, setProblems] = useState<TsProblem[]>([]);
  const [problemsBusy, setProblemsBusy] = useState(false);
  // Language-server diagnostics (Axiom LSP), keyed by repo-relative path.
  const [lspDiags, setLspDiags] = useState<Record<string, LspDiagnostic[]>>({});
  const [problemsNote, setProblemsNote] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const monacoRef = React.useRef<MonacoApi | null>(null);
  const editorRef = React.useRef<EditorApi | null>(null);

  const projectKey = activeProject?.repoId ?? 'default';
  const [sidebarWidth, setSidebarWidth] = useState(() => safeInt(localStorage.getItem(`openhub.ws.sidebar.${projectKey}`), 256));
  const wsBase = activeProject?.repositoryName || '';

  useEffect(() => {
    void fetchActiveProject();
  }, [fetchActiveProject]);

  // Zero-config warmth: warm the local transport once per project so the first
  // Tab does not pay a cold handshake. Fire-and-forget; failures are harmless.
  const warmedProjectRef = React.useRef<string | null>(null);
  useEffect(() => {
    const id = activeProject?.repoId;
    if (!id || !tabPrefs.enabled || warmedProjectRef.current === id) return;
    warmedProjectRef.current = id;
    void axiomEditorWarmStart().catch(() => { /* warmth is best-effort */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId, tabPrefs.enabled]);

  // ---- Quick Open (Ctrl+P) --------------------------------------------------
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [quickIndex, setQuickIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<string[]>([]);
  const quickInputRef = React.useRef<HTMLInputElement>(null);
  const openQuickOpen = React.useCallback(() => {
    setQuickOpen(true);
    setQuickQuery('');
    setQuickIndex(0);
    void (async () => {
      try {
        const res = await fetch('/api/project/active/files', { credentials: 'include', headers: getAuthHeaders() });
        const json = await res.json();
        if (json.ok && Array.isArray(json.files)) setFileIndex(json.files);
      } catch { /* keep the previous index */ }
    })();
  }, []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); openQuickOpen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openQuickOpen]);
  const quickResults = React.useMemo(() => {
    const needle = quickQuery.trim().toLowerCase();
    if (!needle) return fileIndex.slice(0, 60);
    const toks = needle.split(/\s+/).filter(Boolean);
    return fileIndex.filter((p) => { const h = p.toLowerCase(); return toks.every((t) => h.includes(t)); }).slice(0, 60);
  }, [fileIndex, quickQuery]);
  const openQuickResult = (path: string) => {
    setQuickOpen(false);
    void openTab({ name: path.split('/').pop() ?? path, type: 'file', path });
  };

  // Copilot deep-link: open the visualizer panel (the VisualizerPanel picks the view).
  useEffect(() => {
    const handler = () => setActivePanel('visualize');
    window.addEventListener('openhub:visualize', handler);
    return () => window.removeEventListener('openhub:visualize', handler);
  }, []);

  // Automation, not button pushing: drift scan + tool catalog load themselves.
  useEffect(() => {
    if (activeProject && driftState === 'idle') void refreshDrift();
  }, [activeProject, driftState, refreshDrift]);
  useEffect(() => {
    if (registryItems.length === 0) void fetchRegistryItems();
  }, [registryItems.length, fetchRegistryItems]);
  useEffect(() => {
    if (activeProject) void fetchGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/axiom/status', { credentials: 'include', headers: getAuthHeaders() });
        const json = await res.json();
        if (!cancelled) setAxiomOnline(json.ok && json.data?.status === 'ok');
      } catch {
        if (!cancelled) setAxiomOnline(false);
      }
      try {
        const res = await fetch('/api/ecosystem/agents', { credentials: 'include', headers: getAuthHeaders() });
        const json = await res.json();
        const list = Array.isArray(json) ? json : Array.isArray(json?.agents) ? json.agents : [];
        if (!cancelled) {
          setAgents(
            list
              .filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === 'object')
              .slice(0, 40)
              .map((a: Record<string, unknown>, i: number) => ({
                id: typeof a.id === 'string' ? a.id : `agent-${i}`,
                name: typeof a.name === 'string' ? a.name : `agent-${i}`,
                kind: typeof a.kind === 'string' ? a.kind : typeof a.type === 'string' ? a.type : 'agent',
              })),
          );
        }
      } catch {
        if (!cancelled) setAgents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Global ⌘S / Ctrl+S to save the active file, ⌘W / Ctrl+W to close the tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        if (activePath) {
          e.preventDefault();
          closeTab(activePath);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, tabs]);

  // Warn before a reload/navigation discards unsaved buffers.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (tabs.some((t) => t.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [tabs]);

  const suggestedSkills = React.useMemo(() => {
    const task = driftTaskText({
      repositoryName: activeProject?.repositoryName,
      ahead: drift?.ahead ?? 0,
      behind: drift?.behind ?? 0,
      uncommitted: drift?.uncommitted ?? 0,
      files: drift?.files ?? [],
      goal: loopGoal,
    });
    if (!task.trim()) return [];
    const tools: Matchable[] = registryItems.map((t) => ({
      id: t.id, name: t.name, description: t.description, kind: t.type,
    }));
    return matchSkills(task, [...tools, ...agents], 5);
  }, [activeProject?.repositoryName, drift, loopGoal, registryItems, agents]);

  const fetchGit = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/project/active/git', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.git) setGitState(json.git);
    } catch { /* offline */ }
  };

  const gitChanged = React.useMemo(() => {
    if (!gitState) return { files: [] as GitFile[], set: new Set<string>() };
    const files = parsePorcelain(gitState.changed);
    return { files, set: new Set(files.map((f) => f.path)) };
  }, [gitState]);

  // Per-project layout persistence (C1): restore the last open tabs for this repo.
  React.useEffect(() => {
    if (!activeProject) return;
    const saved = localStorage.getItem(`openhub.ws.tabs.${activeProject.repoId}`);
    if (!saved || tabs.length > 0) return;
    try {
      const paths = JSON.parse(saved) as string[];
      if (Array.isArray(paths) && paths.length) {
        void (async () => {
          const restored: Tab[] = [];
          for (const p of paths.slice(0, 8)) {
            try {
              const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(p)}`, { credentials: 'include', headers: getAuthHeaders() });
              const d = await res.json();
              if (d.type === 'file') {
                const name = p.split('/').pop() ?? p;
                const ext = name.split('.').pop() || 'txt';
                restored.push({ path: p, name, language: LANG_MAP[ext] ?? ext, content: d.content || '', dirty: false });
              }
            } catch { /* skip */ }
          }
          if (restored.length) {
            setTabs(restored);
            setActivePath(restored[0].path);
          }
        })();
      }
    } catch { /* corrupt */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId]);

  React.useEffect(() => {
    if (!activeProject) return;
    localStorage.setItem(`openhub.ws.tabs.${activeProject.repoId}`, JSON.stringify(tabs.map((t) => t.path)));
  }, [tabs, activeProject?.repoId]);

  const fetchBranches = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/project/active/git/branches', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.branches) setBranchList(json.branches);
    } catch { /* offline */ }
  };
  useEffect(() => {
    if (activeProject) void fetchBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId]);

  const handleBranch = async (action: 'create' | 'switch' | 'delete', name: string) => {
    if (!name.trim()) return;
    if (action === 'delete' && !window.confirm(`Delete branch "${name.trim()}"? This cannot be undone.`)) return;
    try {
      const res = await fetch('/api/project/active/git/branch', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ action, name: name.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setBranchList(json.branches);
        if (json.git) setGitState(json.git);
        setNewBranch('');
        setBranchOpen(false);
        void refreshDrift();
        void fetchGit();
      }
    } catch { /* surfaced via state */ }
  };

  // Debounced search: the server walk is bounded but a keystroke still walks
  // the tree, so wait for a pause and drop stale responses.
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = React.useRef(0);
  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      searchSeq.current += 1;
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(() => { void runSearch(q, seq); }, 250);
  };

  const runSearch = async (q: string, seq: number) => {
    try {
      const res = await fetch(`/api/project/active/search?q=${encodeURIComponent(q)}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (seq === searchSeq.current && json.ok) setSearchResults(json.hits ?? []);
    } catch {
      if (seq === searchSeq.current) setSearchResults([]);
    } finally {
      if (seq === searchSeq.current) setSearchBusy(false);
    }
  };
  React.useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  const openDiff = async (path: string, cached = false) => {
    setViewMode('diff');
    setDiffBusy(true);
    try {
      const res = await fetch(`/api/project/active/git/diff?path=${encodeURIComponent(path)}${cached ? '&cached=1' : ''}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok) setDiffData({ path: json.path, original: json.original ?? '', modified: json.modified ?? '' });
    } catch { /* ignore */ } finally {
      setDiffBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!commitMsg.trim() || gitBusy) return;
    const count = gitChanged.files.length;
    if (!window.confirm(`Commit ${count} change${count === 1 ? '' : 's'} to ${gitState?.branch ?? 'the current branch'}?`)) return;
    setGitBusy('commit');
    setGitError(null);
    try {
      const res = await fetch('/api/project/active/git/commit', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ message: commitMsg.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Commit failed');
      setGitState(json.git);
      setCommitMsg('');
      void refreshDrift();
    } catch (err) {
      setGitError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setGitBusy(null);
    }
  };

  const handlePush = async () => {
    if (gitBusy) return;
    const target = gitState?.remote ? ` to ${gitState.remote}` : '';
    if (!window.confirm(`Push ${gitState?.branch ?? 'the current branch'}${target}? This publishes commits to the remote.`)) return;
    setGitBusy('push');
    setGitError(null);
    try {
      const res = await fetch('/api/project/active/git/push', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'Push failed');
      setGitState(json.git);
      void refreshDrift();
    } catch (err) {
      setGitError(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setGitBusy(null);
    }
  };

  const openTab = async (node: TreeNode) => {
    if (node.type !== 'file') return;
    const existing = tabs.find((t) => t.path === node.path);
    if (existing) {
      setActivePath(node.path);
      setViewMode('edit');
      setDiffData(null);
      return;
    }
    try {
      const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(node.path)}`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const d = await res.json();
      if (d.type === 'file') {
        const ext = node.name.split('.').pop() || 'txt';
        const tab: Tab = {
          path: node.path,
          name: node.name,
          language: LANG_MAP[ext] ?? ext,
          content: d.content || '',
          dirty: false,
        };
        setTabs((ts) => [...ts, tab]);
        setActivePath(node.path);
        void loadLspDiagnostics(node.path);
      }
    } catch { /* offline */ }
  };

  const closeTab = (path: string) => {
    const tab = tabs.find((t) => t.path === path);
    if (tab?.dirty && !window.confirm(`"${tab.name}" has unsaved changes. Close without saving?`)) return;
    setTabs((ts) => {
      const next = ts.filter((t) => t.path !== path);
      if (activePath === path) {
        setActivePath(next.length ? next[next.length - 1].path : null);
        setViewMode('edit');
        setDiffData(null);
      }
      return next;
    });
  };

  // Composer wrote files to disk: reload any of them that are open in a tab so
  // the editor shows the new contents instead of a stale buffer.
  const reloadTabs = async (paths: string[]) => {
    const wanted = new Set(paths);
    const open = tabs.filter((t) => wanted.has(t.path));
    await Promise.all(open.map(async (t) => {
      try {
        const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(t.path)}`, { credentials: 'include', headers: getAuthHeaders() });
        const d = await res.json();
        if (d.type === 'file') {
          setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, content: d.content || '', dirty: false } : x)));
        }
      } catch { /* leave the buffer as-is */ }
    }));
  };

  // ---- File operations (create / rename / delete) --------------------------
  // The tree remounts on `treeKey` change so it reloads from disk after an op.
  const [treeKey, setTreeKey] = useState(0);
  const fileOp = async (label: string, path: string, init: RequestInit): Promise<any | null> => {
    try {
      const res = await fetch(path, { credentials: 'include', ...init });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) { setProblemsNote(`${label} failed${json?.error ? `: ${json.error}` : ''}`); return null; }
      setProblemsNote(null);
      return json;
    } catch {
      setProblemsNote(`${label} failed`);
      return null;
    }
  };
  const handleNewFile = async () => {
    if (!activeProject) return;
    const rel = window.prompt('New file path (relative to project root), e.g. src/new.ts:');
    if (!rel || !rel.trim()) return;
    const j = await fileOp('Create file', '/api/project/active/file', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
      body: JSON.stringify({ path: rel.trim() }),
    });
    if (j) { setTreeKey((k) => k + 1); void fetchGit(); }
  };
  const handleRenameFile = async (node: TreeNode) => {
    const to = window.prompt('Rename to (relative path):', node.path);
    if (!to || !to.trim() || to.trim() === node.path) return;
    const j = await fileOp('Rename file', '/api/project/active/file/rename', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
      body: JSON.stringify({ from: node.path, to: to.trim() }),
    });
    if (j) {
      setTabs((ts) => ts.map((t) => (t.path === node.path ? { ...t, path: j.to, name: String(j.to).split('/').pop() || t.name } : t)));
      setActivePath((p) => (p === node.path ? j.to : p));
      setTreeKey((k) => k + 1);
      void fetchGit();
    }
  };
  const handleDeleteFile = async (node: TreeNode) => {
    if (!window.confirm(`Delete "${node.path}"? This cannot be undone.`)) return;
    const j = await fileOp('Delete file', `/api/project/active/file?path=${encodeURIComponent(node.path)}`, {
      method: 'DELETE',
      headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
    });
    if (j) {
      setTabs((ts) => ts.filter((t) => t.path !== node.path));
      setActivePath((p) => (p === node.path ? null : p));
      setTreeKey((k) => k + 1);
      void fetchGit();
    }
  };

  // Proactive diagnostics: refresh tsc problems shortly after typing stops, so
  // markers (and Axiom quick-fixes) are current without a manual save/refresh.
  const typecheckTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateActiveContent = (content: string) => {
    if (!activePath) return;
    setTabs((ts) => ts.map((t) => (t.path === activePath ? { ...t, content, dirty: true } : t)));
    if (typecheckTimer.current) clearTimeout(typecheckTimer.current);
    typecheckTimer.current = setTimeout(() => { void runTypecheck(); }, 1500);
  };
  React.useEffect(() => () => { if (typecheckTimer.current) clearTimeout(typecheckTimer.current); }, []);

  const handleSave = async () => {
    const active = tabs.find((t) => t.path === activePath);
    if (!active || !activeProject) return;
    setSaveStatus('saving');
    try {
      const res = await fetch('/api/project/active/contents', {
        method: 'PUT',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ path: active.path, content: active.content }),
      });
      if (!res.ok) throw new Error('Unable to save active project file');
      setTabs((ts) => ts.map((t) => (t.path === active.path ? { ...t, dirty: false } : t)));
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 3000);
      void refreshDrift();
      void fetchGit();
      void runTypecheck();
      void loadLspDiagnostics(active.path);
    } catch {
      setSaveStatus(null);
    }
  };

  // D1 — apply tsc diagnostics to the active model as editor markers.
  const applyMarkers = (errs: TsProblem[]) => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const rel = activePath ? norm(activePath) : '';
    const mine = rel ? errs.filter((e) => { const f = norm(e.file); return f === rel || f.endsWith('/' + rel); }) : [];
    monaco.editor.setModelMarkers(
      model,
      'tsc',
      mine.map((e) => ({
        severity: monaco.MarkerSeverity.Error,
        message: `${e.code}: ${e.message}`,
        code: e.code,
        startLineNumber: e.line,
        startColumn: e.col,
        endLineNumber: e.line,
        endColumn: e.col + 1,
      })),
    );
  };

  // LSP diagnostics (Axiom runs typescript-language-server / pyright). Fetched
  // per file and painted with a distinct marker owner so real language-server
  // errors show for TS/JS/Python without disturbing the tsc markers.
  const loadLspDiagnostics = async (relPath: string) => {
    if (!activeProject || !lspLanguageSupported(relPath)) return;
    const abs = `${activeProject.path.replace(/[\\/]+$/, '')}/${relPath.replace(/\\/g, '/')}`;
    try {
      const r = await axiomEditorDiagnostics({ file: abs, rootDir: activeProject.path });
      const diags = r.available && Array.isArray(r.diagnostics) ? r.diagnostics : [];
      setLspDiags((prev) => ({ ...prev, [relPath]: diags }));
    } catch {
      setLspDiags((prev) => ({ ...prev, [relPath]: [] }));
    }
  };

  const applyLspMarkers = () => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    const diags = activePath ? (lspDiags[activePath] ?? []) : [];
    monaco.editor.setModelMarkers(
      model,
      'axiom-lsp',
      toMonacoMarkers(diags, {
        error: monaco.MarkerSeverity.Error,
        warning: monaco.MarkerSeverity.Warning,
        info: monaco.MarkerSeverity.Info,
        hint: monaco.MarkerSeverity.Hint,
      }),
    );
  };

  // Repaint LSP markers when the diagnostics or the active file change.
  React.useEffect(() => { applyLspMarkers(); }, [lspDiags, activePath]);

  const runTypecheck = async () => {
    if (!activeProject) return;
    setProblemsBusy(true);
    try {
      const res = await fetch('/api/project/active/typecheck', {
        method: 'POST', credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
      const json = await res.json();
      if (json.ok && json.available) {
        setProblems(json.errors ?? []);
        setProblemsNote(json.timedOut ? 'Typecheck timed out' : json.truncated ? 'Showing first 500 problems' : null);
      } else {
        setProblems([]);
        setProblemsNote(json.reason || 'Typecheck unavailable');
      }
    } catch {
      setProblemsNote('Typecheck request failed');
    } finally {
      setProblemsBusy(false);
    }
  };

  // D2 — document outline via Monaco's built-in TypeScript language service.
  const loadOutline = async () => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) { setOutline([]); return; }
    const lang = model.getLanguageId();
    if (lang !== 'typescript' && lang !== 'javascript') { setOutline([]); return; }
    setOutlineLoading(true);
    try {
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
      const client = await getWorker(model.uri);
      const tree = await client.getNavigationTree(model.uri.toString());
      const flat: OutlineItem[] = [];
      const walk = (node: { text?: string; kind?: string; spans?: Array<{ start?: number }>; childItems?: unknown[] }, depth: number) => {
        if (flat.length >= 200) return;
        const spans = Array.isArray(node.spans) ? node.spans : [];
        const start = spans[0]?.start ?? 0;
        flat.push({ name: String(node.text ?? ''), kind: String(node.kind ?? ''), line: model.getPositionAt(start).lineNumber, depth });
        const kids = Array.isArray(node.childItems) ? node.childItems : [];
        for (const k of kids) walk(k as typeof node, depth + 1);
      };
      walk(tree as never, 0);
      setOutline(flat.filter((o) => o.name));
    } catch {
      setOutline([]);
    } finally {
      setOutlineLoading(false);
    }
  };

  const openProblem = (p: TsProblem) => {
    void openTab({ name: p.file.split('/').pop() ?? p.file, type: 'file', path: p.file }).then(() => {
      setTimeout(() => {
        const editor = editorRef.current;
        if (editor) { editor.revealLineInCenter(p.line); editor.setPosition({ lineNumber: p.line, column: p.col }); editor.focus(); }
      }, 80);
    });
  };

  const gotoOutline = (line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };

  // Re-mark the active model whenever diagnostics or the active file change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { applyMarkers(problems); }, [problems, activePath]);
  // Refresh the outline when the active file or view mode changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { void loadOutline(); }, [activePath, viewMode]);

  const handleLoopToggle = async () => {
    if (loopId) {
      try {
        await fetch(`/api/axiom/project/stop/${loopId}`, {
          method: 'POST', credentials: 'include',
          headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
        });
      } catch { /* best effort */ }
      setLoopId(null);
      setLoopStatus('stopped');
      return;
    }
    if (!activeProject) return;
    setLoopBusy(true);
    try {
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ goal: loopGoal || `Advance ${activeProject.repositoryName}`, modelRoute: useModelStore.getState().routes.axiom || 'auto', maxIterations: 8 }),
      });
      const json = await res.json();
      if (json.ok && json.data?.id) {
        setLoopId(json.data.id);
        setLoopStatus('running');
      }
    } catch { /* surfaced via status */ } finally {
      setLoopBusy(false);
    }
  };

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const dirtyCount = tabs.filter((t) => t.dirty).length;

  const sidebarIcons = [
    { id: 'explorer' as const, icon: Files, label: 'Files' },
    { id: 'search' as const, icon: Search, label: 'Search' },
    { id: 'git' as const, icon: GitBranch, label: 'Source Control' },
    { id: 'agent' as const, icon: Activity, label: 'Axiom Agent' },
  ];
  // Everything else lives behind "More" so the rail stays readable. The
  // complexity is still there, just not competing for attention.
  const advancedIcons = [
    { id: 'composer' as const, icon: Wand2, label: 'Composer' },
    { id: 'outline' as const, icon: ListTree, label: 'Outline' },
    { id: 'problems' as const, icon: AlertTriangle, label: 'Problems' },
    { id: 'services' as const, icon: Server, label: 'Services' },
    { id: 'review' as const, icon: Layers, label: 'Multibuffer Review' },
    { id: 'threads' as const, icon: GitBranchPlus, label: 'Threads' },
    { id: 'autonomy' as const, icon: Cpu, label: 'Autonomy' },
    { id: 'visualize' as const, icon: Orbit, label: 'Visualize' },
    { id: 'extensions' as const, icon: Package, label: 'Extensions' },
  ];
  const allIcons = [...sidebarIcons, ...advancedIcons];
  // (allIcons retained for the settings/advanced surface; the rail is gone.)

  const startResize = (e: React.MouseEvent, side: 'sidebar' | 'copilot') => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === 'sidebar' ? sidebarWidth : copilotWidth;
    // Track the live width locally: `onUp` must persist the final value, not the
    // width captured in this render's closure at mousedown (always the start).
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = side === 'sidebar'
        ? clamp(startW + (ev.clientX - startX), 200, 480)
        : clamp(startW - (ev.clientX - startX), 300, 720);
      if (side === 'sidebar') setSidebarWidth(latest);
      else setCopilotWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const key = side === 'sidebar' ? `openhub.ws.sidebar.${projectKey}` : 'openhub.ws.copilot';
      localStorage.setItem(key, String(latest));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const panelContent = () => {
    if (activePanel === 'composer') {
      const tab = tabs.find((t) => t.path === activePath) ?? null;
      return (
        <ComposerPanel
          projectPath={activeProject?.path ?? ''}
          activeFilePath={tab?.path ?? null}
          activeFileContent={tab?.content}
          onApplied={(paths) => {
            void reloadTabs(paths);
            void runTypecheck();
            void fetchGit();
            void refreshDrift();
          }}
        />
      );
    }
    if (activePanel === 'explorer') {
      return (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            <span className="min-w-0 truncate">{wsBase || (activeProjectLoading ? 'Checking project…' : 'No project loaded')}</span>
            {activeProject && (
              <button
                type="button"
                onClick={() => void handleNewFile()}
                aria-label="New file"
                title="New file"
                className="ml-2 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 hover:text-[var(--color-text-primary)]"
              >
                <FilePlus2 className="w-3 h-3" /> New
              </button>
            )}
          </div>
          {activeProject ? (
            <FileTree
              key={treeKey}
              rootPath=""
              changedFiles={gitChanged.set}
              onOpenFile={(n) => void openTab(n)}
              activePath={activePath}
              onRenameFile={(n) => void handleRenameFile(n)}
              onDeleteFile={(n) => void handleDeleteFile(n)}
            />
          ) : (
            <div className="px-3 py-4 text-xs text-[var(--color-text-muted)]">
              {activeProjectLoading ? 'Reading project context…' : activeProjectError || 'Load a project to explore files.'}
            </div>
          )}
        </div>
      );
    }
    if (activePanel === 'search') {
      return (
        <div className="flex h-full flex-col">
          <div className="p-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => void handleSearch(e.target.value)}
              placeholder="Search files…"
              className="w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {searchBusy ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
              </div>
            ) : searchQuery && searchResults.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">No matches.</div>
            ) : (
              searchResults.map((r, i) => (
                <button
                  key={`${r.file}:${r.line}`}
                  onClick={() => void openTab({ name: r.file.split('/').pop() ?? r.file, type: 'file', path: r.file })}
                  className="flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-[var(--color-surface-hover)]"
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]">
                    <CornerDownRight className="w-3 h-3 shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{r.file}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{r.line}</span>
                  </span>
                  <span className="truncate pl-[18px] font-mono text-[10px] text-[var(--color-text-secondary)]">{r.text}</span>
                </button>
              ))
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="border-t border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
              {searchResults.length} results for “{searchQuery}”
            </div>
          )}
        </div>
      );
    }
    if (activePanel === 'git') {
      const count = gitChanged.files.length;
      return (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-1 border-b border-[var(--color-border-muted)] px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Source Control · {count}
            </span>
            <div className="relative ml-auto">
              <button
                onClick={() => setBranchOpen((v) => !v)}
                className="flex items-center gap-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                title="Switch branch"
              >
                <GitBranch className="w-3 h-3 text-[var(--color-accent-text)]" />
                <span className="max-w-[90px] truncate">{branchList?.current ?? gitState?.branch ?? '—'}</span>
                <ChevronDown className="w-3 h-3" />
              </button>
              {branchOpen && branchList && (
                <div className="absolute right-0 top-6 z-20 w-56 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] p-1.5 shadow-xl shadow-black/40">
                  <div className="max-h-40 overflow-y-auto">
                    {branchList.branches.map((b) => (
                      <div key={b} className="flex items-center gap-1.5">
                        <button
                          onClick={() => void handleBranch('switch', b)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                        >
                          <GitBranch className="w-3 h-3 shrink-0 text-[var(--color-text-muted)]" />
                          <span className="truncate">{b}</span>
                          {b === branchList.current && <span className="ml-auto text-[var(--color-accent-text)]">●</span>}
                        </button>
                        {b !== branchList.current && (
                          <button
                            onClick={() => void handleBranch('delete', b)}
                            className="shrink-0 rounded px-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                            title={`Delete ${b}`}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1 border-t border-[var(--color-border-muted)] pt-1.5">
                    <input
                      value={newBranch}
                      onChange={(e) => setNewBranch(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void handleBranch('create', newBranch)}
                      placeholder="New branch…"
                      className="min-w-0 flex-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
                    />
                    <button
                      onClick={() => void handleBranch('create', newBranch)}
                      disabled={!newBranch.trim()}
                      className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
                    >
                      <GitBranchPlus className="w-3 h-3" /> New
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {gitChanged.files.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">
                {gitState ? 'Working tree clean.' : gitBusy ? 'Reading repository…' : 'No Git repository at this path.'}
              </div>
            ) : (
              gitChanged.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => { void openTab({ name: f.path.split('/').pop() ?? f.path, type: 'file', path: f.path }); void openDiff(f.path); }}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                  title={f.path}
                >
                  <span className={cn('w-4 shrink-0 text-center font-mono text-[11px] font-bold', STATUS_TONE[f.status] ?? 'text-[var(--color-text-muted)]')}>
                    {f.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  {f.path === diffData?.path && viewMode === 'diff' && <FileDiff className="w-3 h-3 shrink-0 text-[var(--color-accent-text)]" />}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[var(--color-border-muted)] p-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
              <GitBranch className="w-3.5 h-3.5 text-[var(--color-accent-text)]" />
              <span className="truncate font-mono">{gitState?.branch ?? '—'}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-[var(--color-text-muted)]">{gitState?.subject ?? ''}</span>
            </div>
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message"
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCommit}
                disabled={!commitMsg.trim() || gitBusy !== null || !gitChanged.files.length}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                {gitBusy === 'commit' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommitHorizontal className="w-3.5 h-3.5" />}
                Commit
              </button>
              <button
                onClick={handlePush}
                disabled={gitBusy !== null || !gitState?.remote}
                title={gitState?.remote ? `Push to ${gitState.remote}` : 'No origin remote'}
                className="flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
              >
                {gitBusy === 'push' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Push
              </button>
            </div>
            {gitError && <p role="alert" className="text-[11px] text-[var(--color-danger)]">{gitError}</p>}
            {drift?.lastPush && (
              <p className="truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={drift.lastPush}>last push: {drift.lastPush}</p>
            )}
          </div>
        </div>
      );
    }
    if (activePanel === 'autonomy') {
      return (
        <div className="p-3 space-y-4 overflow-y-auto">
          <div>
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Drift vs last push</div>
              <button
                onClick={() => void refreshDrift()}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                title="Re-scan drift"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${driftState === 'scanning' ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {driftState === 'scanning' || driftState === 'idle' ? (
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">Scanning local vs origin…</div>
            ) : !drift?.available ? (
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">{drift?.reason || 'No remote to compare against.'}</div>
            ) : (
              <div className="mt-2 space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className={cn('w-1.5 h-1.5 rounded-full', !drift.hasUpstream ? 'bg-[var(--color-text-muted)]' : drift.ahead + drift.behind + drift.uncommitted === 0 ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]')} />
                  <span className="font-semibold text-[var(--color-text-primary)]">
                    {!drift.hasUpstream
                      ? 'No upstream branch tracked'
                      : drift.ahead + drift.behind + drift.uncommitted === 0
                        ? 'In sync with last push'
                        : `${drift.ahead} ahead · ${drift.behind} behind · ${drift.uncommitted} uncommitted`}
                  </span>
                </div>
                {drift.stat && <div className="font-mono text-[11px] text-[var(--color-text-muted)]">{drift.stat}</div>}
                {!drift.fetched && <div className="text-[11px] text-[var(--color-warning)]/80">Remote unreachable — showing cached upstream ref.</div>}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              <Zap className="w-3.5 h-3.5 text-[var(--color-success)]" /> Axiom loop
              <span className={cn('ml-auto text-[10px] font-mono', axiomOnline ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]')}>
                {axiomOnline === null ? '…' : axiomOnline ? '● online' : '○ offline'}
              </span>
            </div>
            <textarea
              value={loopGoal}
              onChange={(e) => setLoopGoal(e.target.value)}
              placeholder="Goal for the loop (optional)…"
              rows={2}
              className="mt-2 w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] p-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <button
              onClick={handleLoopToggle}
              disabled={loopBusy || !activeProject}
              className={cn(
                'mt-1.5 w-full flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-40',
                loopId ? 'bg-[var(--color-danger)] hover:brightness-110' : 'bg-[var(--color-success)] hover:brightness-110',
              )}
            >
              {loopBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : loopId ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {loopId ? `Stop loop (${loopStatus ?? 'running'})` : 'Run autonomous loop'}
            </button>
            <Link to="/axiom" className="mt-1.5 block text-center text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              Full loop console →
            </Link>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              <Wrench className="w-3.5 h-3.5 text-[var(--color-info)]" /> Suggested skills
            </div>
            {suggestedSkills.length === 0 ? (
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">No strong matches yet — type a loop goal to refine.</div>
            ) : (
              <div className="mt-2 space-y-1.5">
                {suggestedSkills.map((s) => (
                  <div key={s.id} className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5">
                    <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]" title={s.name}>{s.name}</div>
                    <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={s.reason}>{s.kind ?? 'tool'} · {s.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    if (activePanel === 'problems') {
      return (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-1 border-b border-[var(--color-border-muted)] px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Problems · {problems.length}
            </span>
            <button
              onClick={() => void runTypecheck()}
              disabled={problemsBusy || !activeProject}
              className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
              title="Run typecheck"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', problemsBusy && 'animate-spin')} />
            </button>
          </div>
          {problemsNote && <div className="px-3 py-1 text-[10px] text-[var(--color-text-muted)]">{problemsNote}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {problemsBusy ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Typechecking…</div>
            ) : problems.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">{activeProject ? 'No problems.' : 'Load a project to typecheck.'}</div>
            ) : (
              problems.map((p, i) => (
                <button
                  key={`${p.file}:${p.line}:${p.col}:${i}`}
                  onClick={() => openProblem(p)}
                  className="flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-[var(--color-surface-hover)]"
                  title={`${p.file}:${p.line}:${p.col}`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{p.message}</span>
                  </span>
                  <span className="truncate pl-[18px] font-mono text-[10px] text-[var(--color-text-muted)]">{p.file}:{p.line}:{p.col} · {p.code}</span>
                </button>
              ))
            )}
          </div>
        </div>
      );
    }
    if (activePanel === 'outline') {
      return (
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            Outline · {outline.length}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            {outlineLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading symbols…</div>
            ) : outline.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">No symbols. Open a TypeScript or JavaScript file.</div>
            ) : (
              outline.map((o, i) => (
                <button
                  key={`${o.name}:${o.line}:${i}`}
                  onClick={() => gotoOutline(o.line)}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                  style={{ paddingLeft: 6 + o.depth * 12 }}
                  title={`${o.kind} · line ${o.line}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{o.line}</span>
                </button>
              ))
            )}
          </div>
        </div>
      );
    }
    if (activePanel === 'services') {
      return <ServicesDock />;
    }
    if (activePanel === 'agent') {
      return (
        <AgentDock
          activeLoopId={loopId}
          onLoopStopped={() => { setLoopId(null); setLoopStatus('stopped'); }}
          onLoopStarted={(id) => { setLoopId(id); setLoopStatus('running'); }}
        />
      );
    }
    if (activePanel === 'review') {
      return <MultibufferReviewPanel />;
    }
    if (activePanel === 'threads') {
      return <ThreadsPanel projectPath={activeProject?.path ?? ''} />;
    }
    if (activePanel === 'visualize') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<div className="flex flex-1 items-center justify-center font-mono text-xs text-[var(--color-text-muted)]">Loading 3D…</div>}>
            <VisualizerPanel />
          </Suspense>
        </div>
      );
    }
    if (activePanel === 'extensions') {
      return <ExtensionsPanel />;
    }
    return <div className="p-3 text-xs text-[var(--color-text-muted)]">Extensions</div>;
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-base)]">
      {/* Menu Bar + Breadcrumb */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border-muted)] px-4 py-2 text-xs">
        <Link to="/" className="font-semibold tracking-tight text-sm text-[var(--color-text-primary)]">Workspace</Link>
        {activeProject && <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)]" />}
        {activeProject && <span className="truncate font-semibold text-[var(--color-text-secondary)]">{activeProject.repositoryName}</span>}
        {activeProject?.defaultBranch && <span className="count-pill hidden sm:inline-block">{activeProject.defaultBranch}</span>}
        <div className="flex-1" />
        <button
          onClick={() => void handleSave()}
          disabled={!activeTab || !activeTab.dirty}
          className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-30"
        >
          <Save className="w-3 h-3" /> Save
        </button>
        <button
          onClick={() => setShowTerminal(!showTerminal)}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          <TerminalIcon className="w-3 h-3" /> Terminal
        </button>
      </div>

      {/* Axiom command bar: one obvious place to direct the agent, plus the
          headline actions and live state lights. */}
      <AxiomBar
        projectName={activeProject?.repositoryName}
        hasProject={!!activeProject}
        axiomOnline={axiomOnline}
        onRequestChat={() => setShowCopilot(true)}
        onOpenPanel={(panel) => setActivePanel(panel)}
        pipeline={pipeline}
      />

      {/* Main IDE Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Panel */}
        <div className="flex shrink-0 flex-col border-r border-[var(--color-border-muted)] bg-[var(--color-surface-raised)]" style={{ width: sidebarWidth }}>
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border-muted)] px-2 py-1.5">
            <select
              value={activePanel}
              onChange={(e) => setActivePanel(e.target.value as typeof activePanel)}
              aria-label="Workspace panel"
              className="min-w-0 flex-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] outline-none focus:border-[var(--color-accent)]"
            >
              <optgroup label="Axiom">
                {sidebarIcons.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </optgroup>
              <optgroup label="Advanced">
                {advancedIcons.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </optgroup>
            </select>
            <button
              onClick={() => setShowCopilot(!showCopilot)}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--color-surface-hover)]',
                showCopilot ? 'text-[var(--color-accent-text)]' : 'text-[var(--color-text-muted)]',
              )}
              title="Ask Axiom — chat & commands"
              aria-label="Toggle Axiom chat"
            >
              <Bot className="w-4 h-4" />
            </button>
            <Link to="/settings" aria-label="Settings" title="Settings & configuration" className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]">
              <Settings className="w-4 h-4" />
            </Link>
          </div>
          <div className="min-h-0 flex-1">{panelContent()}</div>
        </div>
        <div className="w-1 shrink-0 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]" onMouseDown={(e) => startResize(e, 'sidebar')} />

        {/* Editor Area */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <>
              <div className="flex items-center border-b border-[var(--color-border-muted)] overflow-x-auto">
                {tabs.map((t) => (
                  <button
                    key={t.path}
                    onClick={() => setActivePath(t.path)}
                    onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
                    className={cn(
                      'group flex min-w-fit items-center gap-2 border-r border-[var(--color-border-muted)] px-3 py-2 text-xs',
                      activePath === t.path
                        ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]'
                        : 'bg-[var(--color-surface-base)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                    )}
                    title={t.path}
                  >
                    {t.dirty && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />}
                    <span className="max-w-[160px] truncate">{t.name}</span>
                    <X
                      className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-text-primary)]"
                      onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                    />
                  </button>
                ))}
                <button onClick={() => setActivePanel('explorer')} className="flex items-center gap-1 px-2 py-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" title="Open more files">
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {saveStatus === 'saved' && (
                  <span role="status" aria-live="polite" className="ml-2 flex items-center gap-1 font-mono text-[10px] text-[var(--color-success)]">
                    <Check className="w-3 h-3" /> Saved
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1 px-2">
                  <div className="relative" ref={modelMenuRef}>
                    <button
                      onClick={() => { setModelMenuOpen((v) => !v); void refreshEditorCatalog(); }}
                      aria-haspopup="menu"
                      aria-expanded={modelMenuOpen}
                      aria-label="Editor model"
                      className="flex items-center gap-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      title="Editor model — the model Axiom's Tab completion and Ctrl+I inline-edit lanes use"
                    >
                      <Cpu className="w-3 h-3" />
                      <span className="max-w-[120px] truncate">{tabPrefs.model || editorModels?.configured || 'Auto'}</span>
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {modelSave === 'saving' && <Loader2 className="ml-1 inline w-3 h-3 animate-spin text-[var(--color-text-muted)]" />}
                    {modelSave === 'saved' && <Check className="ml-1 inline w-3 h-3 text-[var(--color-success)]" />}
                    {modelMenuOpen && (
                      <div role="menu" aria-label="Editor model" className="absolute right-0 top-7 z-30 w-64 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] p-1.5 shadow-xl shadow-black/40">
                        <div className="px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Editor model</div>
                        <button
                          role="menuitemradio"
                          aria-checked={!tabPrefs.model}
                          onClick={() => void chooseEditorModel('')}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                        >
                          <span className="min-w-0 flex-1 truncate">Auto (configured default)</span>
                          {!tabPrefs.model && <Check className="w-3 h-3 shrink-0 text-[var(--color-accent-text)]" />}
                        </button>
                        {editorModelOptions.length === 0 ? (
                          <div className="px-1.5 py-2 text-[11px] text-[var(--color-text-muted)]">No models reported. Configure a local tier in Settings.</div>
                        ) : (
                          editorModelOptions.map((m) => (
                            <button
                              key={m}
                              role="menuitemradio"
                              aria-checked={m === tabPrefs.model}
                              onClick={() => void chooseEditorModel(m)}
                              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                              title={m}
                            >
                              <span className="min-w-0 flex-1 truncate">{m}</span>
                              {m === tabPrefs.model && <Check className="w-3 h-3 shrink-0 text-[var(--color-accent-text)]" />}
                            </button>
                          ))
                        )}
                        {modelSave === 'error' && <div className="px-1.5 pt-1 text-[10px] text-[var(--color-danger)]">Could not save the default model.</div>}
                      </div>
                    )}
                  </div>
                  {activeTab && gitChanged.set.has(activeTab.path) && (
                    <button
                      onClick={() => viewMode === 'diff' ? setViewMode('edit') : void openDiff(activeTab.path)}
                      className="flex items-center gap-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      title="Review changes vs HEAD"
                    >
                      {diffBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDiff className="w-3 h-3" />}
                      {viewMode === 'diff' ? 'Edit' : 'Diff'}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1">
                {viewMode === 'diff' && diffData && diffData.path === activeTab?.path ? (
                  <DiffEditor
                    height="100%"
                    language={activeTab?.language ?? 'plaintext'}
                    original={diffData.original}
                    modified={diffData.modified}
                    theme={theme === 'light' ? 'vs' : 'vs-dark'}
                    options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, renderSideBySide: true, readOnly: true }}
                  />
                ) : (
                  <Editor
                    height="100%"
                    language={activeTab?.language ?? 'plaintext'}
                    value={activeTab?.content ?? ''}
                    onChange={(v) => updateActiveContent(v || '')}
                    theme={theme === 'light' ? 'vs' : 'vs-dark'}
                    onMount={(editor, monaco) => {
                      editorRef.current = editor;
                      monacoRef.current = monaco;
                      applyMarkers(problems);
                      void loadOutline();
                      registerAxiomMonaco(monaco, editor, {
                        projectPath: activeProject?.path ?? '',
                        completionEnabled: tabPrefs.enabled,
                        completionDelayMs: tabPrefs.delayMs,
                        singleLine: tabPrefs.singleLine,
                        onStatus: (m) => setEditorStatus(m),
                      });
                      // Editor navigation/commands: Quick Open (our own), Go to
                      // Line, Go to Symbol, and the editor command palette —
                      // the VS Code bindings, backed by Monaco's built-in
                      // language-service commands where they exist.
                      editor.addAction({
                        id: 'axiom.quickOpen',
                        label: 'Axiom: Quick Open File',
                        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP],
                        run: () => openQuickOpen(),
                      });
                      editor.addAction({
                        id: 'axiom.goToLine',
                        label: 'Axiom: Go to Line',
                        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG],
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        run: (ed: any) => ed.trigger('axiom', 'editor.action.gotoLine', null),
                      });
                      editor.addAction({
                        id: 'axiom.goToSymbol',
                        label: 'Axiom: Go to Symbol in File',
                        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO],
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        run: (ed: any) => ed.trigger('axiom', 'editor.action.quickOutline', null),
                      });
                      editor.addAction({
                        id: 'axiom.commandPalette',
                        label: 'Axiom: Command Palette',
                        keybindings: [monaco.KeyCode.F1],
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        run: (ed: any) => ed.trigger('axiom', 'editor.action.quickCommand', null),
                      });
                    }}
                    options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2 }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[var(--color-text-muted)]">
              <div className="space-y-4 text-center">
                <div className="text-4xl">⌐◨-◨</div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[var(--color-text-secondary)]">OpenHub Workspace</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {activeProject
                      ? 'Select a file from the explorer to start editing'
                      : activeProjectLoading ? 'Checking the active project…' : 'Load a project to start working.'}
                  </div>
                </div>
                {activeProject && (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => void pipeline.start('autopilot')}
                      disabled={pipeline.running || pipeline.starting}
                      className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                      title="typecheck → audit → repair → agent loop → verify"
                    >
                      {pipeline.starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                      Run Autopilot
                    </button>
                    <button
                      type="button"
                      onClick={() => void pipeline.start('audit')}
                      disabled={pipeline.running || pipeline.starting}
                      className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
                      title="Audit the project and dispatch repair if it fails"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> Audit project
                    </button>
                  </div>
                )}
                {!activeProject && !activeProjectLoading && (
                  <Link to="/projects" className="inline-block rounded-md bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]">
                    Load a project
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Resizer + Co-Pilot */}
        {showCopilot && (
          <>
            <div className="w-1 shrink-0 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]" onMouseDown={(e) => startResize(e, 'copilot')} />
            <div className="shrink-0 border-l border-[var(--color-border-muted)] bg-[var(--color-surface-raised)]" style={{ width: copilotWidth }}>
              <DevAssistant embedded />
            </div>
          </>
        )}
      </div>

      {/* Terminal Panel (real shell bridge) */}
      {showTerminal && (
        <div className="h-52 border-t border-[var(--color-border-muted)]">
          <div className="flex items-center justify-between bg-[var(--color-surface-base)]">
            <div className="flex items-center gap-2">
              <TerminalIcon className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
              <span className="text-xs text-[var(--color-text-secondary)]">Terminal</span>
            </div>
            <button
              type="button"
              aria-label="Close terminal"
              title="Close terminal"
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              onClick={() => setShowTerminal(false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {activeProject ? (
            <TerminalView projectRepoId={activeProject.repoId} />
          ) : (
            <div className="p-3 text-xs text-[var(--color-text-muted)]">Load a project to open a shell here.</div>
          )}
        </div>
      )}

      {/* Quick Open (Ctrl+P) */}
      {quickOpen && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Quick open files">
          <div className="absolute inset-0 bg-black/60" onClick={() => setQuickOpen(false)} />
          <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] shadow-2xl shadow-black/50">
            <input
              ref={quickInputRef}
              autoFocus
              value={quickQuery}
              onChange={(e) => { setQuickQuery(e.target.value); setQuickIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setQuickOpen(false); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setQuickIndex((i) => Math.min(i + 1, Math.max(0, quickResults.length - 1))); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setQuickIndex((i) => Math.max(i - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const p = quickResults[quickIndex]; if (p) openQuickResult(p); }
              }}
              placeholder="Search files by name…"
              aria-label="Search files"
              className="w-full bg-transparent px-4 py-3 font-mono text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
            />
            <div className="max-h-[46vh] overflow-y-auto border-t border-[var(--color-border-muted)] py-1">
              {quickResults.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
                  {fileIndex.length === 0 ? 'Reading project files…' : 'No matching files.'}
                </p>
              ) : (
                quickResults.map((p, i) => (
                  <button
                    key={p}
                    onMouseEnter={() => setQuickIndex(i)}
                    onClick={() => openQuickResult(p)}
                    className={cn(
                      'flex w-full items-center px-4 py-1.5 text-left font-mono text-xs',
                      i === quickIndex ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{p}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Status Bar */}
      <div className="flex items-center justify-between border-t border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-1 text-[10px] text-[var(--color-text-muted)]">
        <div className="flex items-center gap-3">
          {axiomOnline === false ? (
            <span className="flex items-center gap-1 text-[var(--color-danger)]" title="Axiom backend unreachable — Tab completion and loops are unavailable">
              <CircleDot className="w-3 h-3" /> Axiom offline
            </span>
          ) : problems.length > 0 ? (
            <span className="flex items-center gap-1 text-[var(--color-danger)]" title={`${problems.length} TypeScript problem${problems.length === 1 ? '' : 's'} in the active project`}>
              <CircleDot className="w-3 h-3" /> {problems.length} error{problems.length === 1 ? '' : 's'}
            </span>
          ) : dirtyCount > 0 ? (
            <span className="flex items-center gap-1 text-[var(--color-warning)]" title="Unsaved editor buffers">
              <CircleDot className="w-3 h-3" /> Unsaved
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[var(--color-success)]">
              <CircleDot className="w-3 h-3" /> Ready
            </span>
          )}
          <span className="truncate font-mono">{gitState?.branch ?? 'no branch'}</span>
          {dirtyCount > 0 && <span className="text-[var(--color-warning)]">{dirtyCount} unsaved</span>}
          {gitChanged.files.length > 0 && <span className="text-[var(--color-text-muted)]">{gitChanged.files.length} changes</span>}
        </div>
        <div className="relative flex items-center gap-3">
          {editorStatus && (
            <span
              role="status"
              aria-live="polite"
              title={editorStatus}
              className="max-w-[26rem] truncate font-mono text-[var(--color-text-secondary)]"
            >
              {editorStatus}
            </span>
          )}
          {(() => {
            const s = getAxiomTabStats();
            const label = !tabPrefs.enabled
              ? 'Tab off'
              : s.lastTotalMs === null
                ? 'Tab on'
                : `Tab ${s.lastCached ? 'cache' : `${Math.round(s.lastTotalMs)}ms`}${s.lastLane ? ` · ${s.lastLane}` : ''}`;
            return (
              <button
                onClick={() => void openTabPopover()}
                title="Axiom Tab completion status — enable, delay, single-line, model"
                className="rounded px-1.5 py-0.5 font-mono hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
              >
                {label}
              </button>
            );
          })()}
          {tabOpen && (
            <div className="absolute bottom-6 right-0 z-30 w-64 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] p-3 shadow-xl shadow-black/40">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Axiom Tab</div>
              <label className="flex cursor-pointer items-center justify-between gap-2 py-1 text-xs text-[var(--color-text-secondary)]">
                <span>Enable completions</span>
                <input
                  type="checkbox"
                  checked={tabPrefs.enabled}
                  onChange={(e) => setTabPrefs((p) => ({ ...p, enabled: e.target.checked }))}
                />
              </label>
              <label className="flex items-center justify-between gap-2 py-1 text-xs text-[var(--color-text-secondary)]">
                <span title="Pause after typing before requesting (VS Code minShowDelay)">Show delay</span>
                <select
                  value={tabPrefs.delayMs}
                  onChange={(e) => setTabPrefs((p) => ({ ...p, delayMs: Number(e.target.value) }))}
                  className="rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1 py-0.5 font-mono text-[11px]"
                >
                  <option value={0}>instant</option>
                  <option value={150}>150ms</option>
                  <option value={500}>500ms</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2 py-1 text-xs text-[var(--color-text-secondary)]">
                <span title="Truncate ghost text at the first newline">Single-line mode</span>
                <input
                  type="checkbox"
                  checked={tabPrefs.singleLine}
                  onChange={(e) => setTabPrefs((p) => ({ ...p, singleLine: e.target.checked }))}
                />
              </label>
              <label className="flex items-center justify-between gap-2 py-1 text-xs text-[var(--color-text-secondary)]">
                <span title="Per-request local model override for Tab completion and Ctrl+I inline edit">Model</span>
                <select
                  value={tabPrefs.model}
                  onChange={(e) => setTabPrefs((p) => ({ ...p, model: e.target.value }))}
                  className="max-w-[10rem] rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1 py-0.5 font-mono text-[11px]"
                >
                  <option value="">Auto (env default)</option>
                  {(editorModels?.models ?? []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <div className="mt-2 border-t border-[var(--color-border-muted)] pt-2 font-mono text-[10px] text-[var(--color-text-muted)]">
                {tabModelDetail ?? 'reading model status…'}
              </div>
              <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                <span className="min-w-0 flex-1 truncate" title={tabWarm ?? undefined}>warm: {tabWarm ?? 'checking…'}</span>
                <button
                  type="button"
                  onClick={() => { void axiomEditorWarmStart().then(() => refreshWarm()).catch(() => setTabWarm('warm start failed')); }}
                  className="shrink-0 rounded border border-[var(--color-border-muted)] px-1.5 py-0.5 font-semibold hover:text-[var(--color-text-primary)]"
                >
                  Warm now
                </button>
              </div>
              <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
                {(() => {
                  const s = getAxiomTabStats();
                  return `shown ${s.shown} · partial ${s.partialAccepts} · Ctrl+I edit · Alt+J jump`;
                })()}
              </div>
            </div>
          )}
          <span className="font-mono">{activeTab?.language ?? 'plain text'}</span>
          <span>UTF-8</span>
          <span className="flex items-center gap-1">
            <Github className="w-3 h-3" /> OpenHub
          </span>
        </div>
      </div>
    </div>
  );
}