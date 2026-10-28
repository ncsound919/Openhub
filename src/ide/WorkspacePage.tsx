import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import {
  Files, Search, GitBranch, AlertTriangle, Server, Menu, Bot, Save,
  Terminal as TerminalIcon, X, ChevronRight, RefreshCw, Loader2, CircleDot,
  CornerDownRight, FilePlus2, GitCommitHorizontal, Upload, FileDiff, Check,
  GitBranchPlus, ChevronDown, Plus, MessageSquarePlus,
} from 'lucide-react';
import { useStore } from '../store';
import { FileTree, type TreeNode } from './FileTree';
import { TerminalView } from './TerminalView';
import { ServicesDock } from './ServicesDock';
import { EditorAgentPanel } from './EditorAgentPanel';
import { buildSelectionPrompt } from './selectionContext';
import { useIsMobile } from '../lib/useIsMobile';
import { cn } from '../lib/utils';

type Tab = { path: string; name: string; language: string; content: string; dirty: boolean; repoId: string };
type PanelId = 'files' | 'search' | 'git' | 'problems' | 'services';

type GitFile = { status: string; path: string };
type GitState = {
  branch: string | null;
  head: string | null;
  subject: string | null;
  changed: string[];
  remote: string | null;
};

type TsProblem = { file: string; line: number; col: number; code: string; message: string };

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', json: 'json', md: 'markdown', css: 'css', html: 'html',
  yaml: 'yaml', yml: 'yaml', sql: 'sql', sh: 'shell', ps1: 'powershell',
  cpp: 'cpp', c: 'c', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  php: 'php', xml: 'xml', svg: 'xml', toml: 'ini', ini: 'ini', env: 'ini',
};

const PANELS: Array<{ id: PanelId; label: string; icon: typeof Files }> = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'git', label: 'Source Control', icon: GitBranch },
  { id: 'problems', label: 'Problems', icon: AlertTriangle },
  { id: 'services', label: 'Services', icon: Server },
];

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

/** A plain monospace textarea with a synced line-number gutter. */
function CodeEditor({
  value,
  onChange,
  onSelectionChange,
  textareaRef,
  gutterRef,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (range: { start: number; end: number } | null) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  gutterRef: React.RefObject<HTMLDivElement | null>;
  ariaLabel: string;
}) {
  const lineCount = Math.min(value.split('\n').length, 50000);

  // A textarea fires `select` for a mouse drag, but a phone's selection handles
  // report through `selectionchange` and `pointerup`. Listen to all three so the
  // "Ask agent" affordance appears however the text was selected.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const report = () => {
      if (document.activeElement !== el) return;
      onSelectionChange?.(el.selectionStart === el.selectionEnd
        ? null
        : { start: el.selectionStart, end: el.selectionEnd });
    };
    document.addEventListener('selectionchange', report);
    el.addEventListener('pointerup', report);
    el.addEventListener('keyup', report);
    return () => {
      document.removeEventListener('selectionchange', report);
      el.removeEventListener('pointerup', report);
      el.removeEventListener('keyup', report);
    };
  }, [onSelectionChange, textareaRef]);

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[var(--color-surface-base)]">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="w-10 shrink-0 overflow-hidden border-r border-[var(--color-border-muted)] bg-[var(--color-bg-base)] py-3 text-right font-mono text-[11px] leading-5 text-[var(--color-text-muted)]"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="pr-2">{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onSelect={(e) => {
          const el = e.currentTarget;
          onSelectionChange?.(el.selectionStart === el.selectionEnd
            ? null
            : { start: el.selectionStart, end: el.selectionEnd });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const next = `${value.slice(0, start)}  ${value.slice(end)}`;
            onChange(next);
            requestAnimationFrame(() => {
              el.selectionStart = start + 2;
              el.selectionEnd = start + 2;
            });
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={ariaLabel}
        className="min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-3 font-mono text-[13px] leading-5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
        wrap="off"
        placeholder="Start typing…"
      />
    </div>
  );
}

function DiffPane({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-[var(--color-border-muted)] not-last:border-b lg:not-last:border-b-0 lg:not-last:border-r">
      <div className="shrink-0 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        {label}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {text || '(empty)'}
      </pre>
    </div>
  );
}

export function WorkspacePage() {
  const {
    activeProject, activeProjectLoading, activeProjectError, fetchActiveProject,
    drift, refreshDrift,
  } = useStore();
  const isMobile = useIsMobile();
  // Desktop opens the agent beside the code; a phone starts on the file view
  // and reaches the same mounted panel with the header toggle, so a turn is
  // never lost when the sheet closes.
  const [agentOpen, setAgentOpen] = useState(!isMobile);
  const [activePanel, setActivePanel] = useState<PanelId>('files');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [gitBusy, setGitBusy] = useState<'commit' | 'push' | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'edit' | 'diff'>('edit');
  const [diffData, setDiffData] = useState<{ path: string; original: string; modified: string } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [branchList, setBranchList] = useState<{ current: string | null; branches: string[] } | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [searchResults, setSearchResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [problems, setProblems] = useState<TsProblem[]>([]);
  const [problemsBusy, setProblemsBusy] = useState(false);
  const [problemsNote, setProblemsNote] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [agentSeed, setAgentSeed] = useState<{ id: number; text: string } | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const pendingReveal = React.useRef<{ path: string; line: number; col: number } | null>(null);

  const projectKey = activeProject?.repoId ?? 'default';
  const [sidebarWidth, setSidebarWidth] = useState(() => safeInt(localStorage.getItem(`openhub.ws.sidebar.${projectKey}`), 240));

  useEffect(() => {
    void fetchActiveProject();
  }, [fetchActiveProject]);

  // ---- Quick Open (Ctrl+P, or the search button on a phone) ----------------
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

  // Project switch: tabs belong to the project they were opened for.
  const tabsRepoRef = React.useRef<string | null>(null);
  const restoredForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = activeProject?.repoId;
    if (!id) return;
    const prev = tabsRepoRef.current;
    tabsRepoRef.current = id;
    if (prev === null || prev === id) return;
    const dirty = tabs.filter((t) => t.dirty);
    if (dirty.length && !window.confirm(
      `The active project changed. Discard ${dirty.length} unsaved tab${dirty.length === 1 ? '' : 's'} from the previous project?`,
    )) {
      return;
    }
    setTabs([]);
    setActivePath(null);
    setViewMode('edit');
    setDiffData(null);
    setDrawerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId]);

  // Per-project layout persistence: restore the last open tabs for this repo.
  React.useEffect(() => {
    if (!activeProject) return;
    const repoId = activeProject.repoId;
    let saved: string | null = null;
    try { saved = localStorage.getItem(`openhub.ws.tabs.${repoId}`); } catch { /* storage unavailable */ }
    if (!saved) { restoredForRef.current = repoId; return; }
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
                restored.push({ path: p, name, language: LANG_MAP[ext] ?? ext, content: d.content || '', dirty: false, repoId });
              }
            } catch { /* skip */ }
          }
          if (tabsRepoRef.current !== repoId) return;
          restoredForRef.current = repoId;
          if (restored.length) {
            setTabs((ts) => {
              const have = new Set(ts.filter((t) => t.repoId === repoId).map((t) => t.path));
              const add = restored.filter((t) => !have.has(t.path));
              return add.length ? [...ts, ...add] : ts;
            });
            setActivePath((cur) => cur ?? restored[0].path);
          }
        })();
      } else {
        restoredForRef.current = repoId;
      }
    } catch { restoredForRef.current = repoId; /* corrupt */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.repoId]);

  React.useEffect(() => {
    if (!activeProject) return;
    const repoId = activeProject.repoId;
    if (restoredForRef.current !== repoId) return;
    const paths = tabs.filter((t) => t.repoId === repoId).map((t) => t.path);
    try { localStorage.setItem(`openhub.ws.tabs.${repoId}`, JSON.stringify(paths)); } catch { /* storage unavailable */ }
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
    if (activeProject) {
      void fetchGit();
      void fetchBranches();
    }
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
    if (node.type !== 'file' || !activeProject) return;
    const repoId = activeProject.repoId;
    const existing = tabs.find((t) => t.path === node.path && t.repoId === repoId);
    if (existing) {
      setActivePath(node.path);
      setViewMode('edit');
      setDiffData(null);
      setDrawerOpen(false);
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
          repoId,
        };
        if (tabsRepoRef.current !== repoId) return;
        setTabs((ts) => (ts.some((t) => t.path === tab.path && t.repoId === repoId) ? ts : [...ts, tab]));
        setActivePath(node.path);
        setDrawerOpen(false);
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

  // ---- File operations (create / rename / delete) --------------------------
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

  const updateActiveContent = (content: string) => {
    if (!activePath) return;
    setTabs((ts) => ts.map((t) => (t.path === activePath ? { ...t, content, dirty: true } : t)));
  };

  const handleSave = async () => {
    const active = tabs.find((t) => t.path === activePath);
    if (!active || !activeProject) return;
    if (active.repoId !== activeProject.repoId) {
      setSaveError(`Not saved: "${active.name}" belongs to a different project than the active one.`);
      setTimeout(() => setSaveError(null), 6000);
      return;
    }
    setSaveError(null);
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
    } catch {
      setSaveStatus(null);
      setSaveError('Unable to save this file.');
    }
  };

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

  const revealPosition = (line: number, col: number) => {
    const el = textareaRef.current;
    if (!el) return;
    const lines = el.value.split('\n');
    const before = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
    const offset = before + Math.max(0, col - 1);
    el.focus();
    el.setSelectionRange(offset, offset);
    el.scrollTop = Math.max(0, (line - 3) * 20);
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  const openProblem = (p: TsProblem) => {
    pendingReveal.current = { path: p.file, line: p.line, col: p.col };
    void openTab({ name: p.file.split('/').pop() ?? p.file, type: 'file', path: p.file });
  };

  // Reveal a problem's line once its tab has rendered.
  React.useEffect(() => {
    const pending = pendingReveal.current;
    if (!pending || pending.path !== activePath) return;
    pendingReveal.current = null;
    requestAnimationFrame(() => revealPosition(pending.line, pending.col));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, tabs]);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const dirtyCount = tabs.filter((t) => t.dirty).length;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = clamp(startW + (ev.clientX - startX), 200, 420);
      setSidebarWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem(`openhub.ws.sidebar.${projectKey}`, String(latest));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const panelContent = () => {
    if (activePanel === 'files') {
      return (
        <div className="flex h-full flex-col">
          <div className="flex min-h-11 items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            <span className="min-w-0 truncate">{activeProject?.repositoryName || (activeProjectLoading ? 'Checking project…' : 'No project loaded')}</span>
            {activeProject && (
              <button
                type="button"
                onClick={() => void handleNewFile()}
                aria-label="New file"
                title="New file"
                className="ml-2 flex min-h-9 shrink-0 items-center gap-1 rounded px-1.5 hover:text-[var(--color-text-primary)]"
              >
                <FilePlus2 className="h-3.5 w-3.5" /> New
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
              type="search"
              value={searchQuery}
              onChange={(e) => void handleSearch(e.target.value)}
              placeholder="Search files…"
              aria-label="Search files"
              className="min-h-11 w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {searchBusy ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </div>
            ) : searchQuery && searchResults.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">No matches.</div>
            ) : (
              searchResults.map((r) => (
                <button
                  key={`${r.file}:${r.line}`}
                  onClick={() => void openTab({ name: r.file.split('/').pop() ?? r.file, type: 'file', path: r.file })}
                  className="flex w-full flex-col gap-0.5 rounded px-2 py-2 text-left hover:bg-[var(--color-surface-hover)]"
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]">
                    <CornerDownRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
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
          <div className="flex min-h-11 items-center gap-1 border-b border-[var(--color-border-muted)] px-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Source Control · {count}
            </span>
            <div className="relative ml-auto">
              <button
                onClick={() => setBranchOpen((v) => !v)}
                className="flex min-h-9 items-center gap-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                title="Switch branch"
              >
                <GitBranch className="h-3 w-3 text-[var(--color-accent-text)]" />
                <span className="max-w-[90px] truncate">{branchList?.current ?? gitState?.branch ?? '—'}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {branchOpen && branchList && (
                <div className="absolute right-0 top-9 z-20 w-56 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] p-1.5 shadow-xl shadow-black/40">
                  <div className="max-h-40 overflow-y-auto">
                    {branchList.branches.map((b) => (
                      <div key={b} className="flex items-center gap-1.5">
                        <button
                          onClick={() => void handleBranch('switch', b)}
                          className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                        >
                          <GitBranch className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                          <span className="truncate">{b}</span>
                          {b === branchList.current && <span className="ml-auto text-[var(--color-accent-text)]">●</span>}
                        </button>
                        {b !== branchList.current && (
                          <button
                            onClick={() => void handleBranch('delete', b)}
                            className="shrink-0 rounded px-1.5 py-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
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
                      className="min-h-9 min-w-0 flex-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 font-mono text-[10px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
                    />
                    <button
                      onClick={() => void handleBranch('create', newBranch)}
                      disabled={!newBranch.trim()}
                      className="flex min-h-9 shrink-0 items-center gap-1 rounded bg-[var(--color-accent)] px-2 text-[10px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
                    >
                      <GitBranchPlus className="h-3 w-3" /> New
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {gitChanged.files.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">
                {gitState ? 'Working tree clean.' : gitBusy ? 'Reading repository…' : 'No Git repository at this path.'}
              </div>
            ) : (
              gitChanged.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => { void openTab({ name: f.path.split('/').pop() ?? f.path, type: 'file', path: f.path }); void openDiff(f.path); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
                  title={f.path}
                >
                  <span className={cn('w-4 shrink-0 text-center font-mono text-[11px] font-bold', STATUS_TONE[f.status] ?? 'text-[var(--color-text-muted)]')}>
                    {f.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  {f.path === diffData?.path && viewMode === 'diff' && <FileDiff className="h-3 w-3 shrink-0 text-[var(--color-accent-text)]" />}
                </button>
              ))
            )}
          </div>
          <div className="space-y-2 border-t border-[var(--color-border-muted)] p-3">
            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
              <GitBranch className="h-3.5 w-3.5 text-[var(--color-accent-text)]" />
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
                className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                {gitBusy === 'commit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
                Commit
              </button>
              <button
                onClick={handlePush}
                disabled={gitBusy !== null || !gitState?.remote}
                title={gitState?.remote ? `Push to ${gitState.remote}` : 'No origin remote'}
                className="flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
              >
                {gitBusy === 'push' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
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
    if (activePanel === 'problems') {
      return (
        <div className="flex h-full flex-col">
          <div className="flex min-h-11 items-center gap-1 border-b border-[var(--color-border-muted)] px-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              Problems · {problems.length}
            </span>
            <button
              onClick={() => void runTypecheck()}
              disabled={problemsBusy || !activeProject}
              className="ml-auto flex min-h-9 min-w-9 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
              title="Run typecheck"
              aria-label="Run typecheck"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', problemsBusy && 'animate-spin')} />
            </button>
          </div>
          {problemsNote && <div className="px-3 py-1 text-[10px] text-[var(--color-text-muted)]">{problemsNote}</div>}
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {problemsBusy ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Typechecking…</div>
            ) : problems.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">{activeProject ? 'No problems.' : 'Load a project to typecheck.'}</div>
            ) : (
              problems.map((p, i) => (
                <button
                  key={`${p.file}:${p.line}:${p.col}:${i}`}
                  onClick={() => openProblem(p)}
                  className="flex w-full flex-col gap-0.5 rounded px-2 py-2 text-left hover:bg-[var(--color-surface-hover)]"
                  title={`${p.file}:${p.line}:${p.col}`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-danger)]">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
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
    return <ServicesDock />;
  };

  const panelTabs = (
    <div role="tablist" aria-label="Workspace panel" className="flex shrink-0 items-center gap-0.5 border-b border-[var(--color-border-muted)] px-1 py-1">
      {PANELS.map((p) => {
        const Icon = p.icon;
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={activePanel === p.id}
            aria-label={p.label}
            title={p.label}
            onClick={() => setActivePanel(p.id)}
            className={cn(
              'flex h-9 flex-1 items-center justify-center rounded transition-colors',
              activePanel === p.id
                ? 'bg-[var(--color-surface-base)] text-[var(--color-text-primary)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg-base)]">
      {/* Compact workspace bar: files, project, save, terminal, opencode. */}
      <header className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 sm:px-3">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] lg:hidden"
          aria-label="Open files"
        >
          <Menu className="h-4 w-4" />
          Files
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Link to="/" className="hidden shrink-0 text-xs font-semibold tracking-tight text-[var(--color-text-primary)] sm:block">Workspace</Link>
          {activeProject && <ChevronRight className="hidden h-3 w-3 shrink-0 text-[var(--color-text-muted)] sm:block" />}
          {activeProject && <span className="min-w-0 truncate text-xs font-semibold text-[var(--color-text-secondary)]">{activeProject.repositoryName}</span>}
          {activeProject?.defaultBranch && <span className="count-pill hidden shrink-0 lg:inline-block">{activeProject.defaultBranch}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setAgentOpen((open) => !open)}
            aria-pressed={agentOpen}
            className={cn(
              'flex min-h-10 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold',
              agentOpen
                ? 'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent-text)]'
                : 'border-[var(--color-border-muted)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
            title="Toggle coding agent"
          >
            <Bot className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Agent</span>
          </button>
          <button
            type="button"
            onClick={openQuickOpen}
            aria-label="Quick open file"
            title="Quick open (⌘P)"
            className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!activeTab || !activeTab.dirty}
            className="flex min-h-10 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-30"
          >
            <Save className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Save</span>
          </button>
          <button
            type="button"
            onClick={() => setShowTerminal(!showTerminal)}
            aria-label="Toggle terminal"
            title="Terminal"
            className={cn(
              'flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
              showTerminal && 'bg-[var(--color-surface-base)] text-[var(--color-text-primary)]',
            )}
          >
            <TerminalIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <aside
          className="hidden shrink-0 flex-col border-r border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] lg:flex"
          style={{ width: sidebarWidth }}
        >
          {panelTabs}
          <div className="min-h-0 flex-1">{panelContent()}</div>
        </aside>
        <div className="hidden w-1 shrink-0 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] lg:block" onMouseDown={startResize} />

        {/* Editor */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <>
              <div className="flex shrink-0 items-center overflow-x-auto border-b border-[var(--color-border-muted)]">
                {tabs.map((t) => (
                  <button
                    key={t.path}
                    onClick={() => setActivePath(t.path)}
                    onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
                    className={cn(
                      'group flex min-h-10 min-w-fit items-center gap-2 border-r border-[var(--color-border-muted)] px-3 text-xs',
                      activePath === t.path
                        ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)]'
                        : 'bg-[var(--color-surface-base)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                    )}
                    title={t.path}
                  >
                    {t.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning)]" />}
                    <span className="max-w-[140px] truncate sm:max-w-[180px]">{t.name}</span>
                    <X
                      className="h-3 w-3 shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                      onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                    />
                  </button>
                ))}
                <button onClick={() => setDrawerOpen(true)} className="flex min-h-10 items-center gap-1 px-2.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] lg:hidden" title="Open files" aria-label="Open more files">
                  <Plus className="h-3.5 w-3.5" />
                </button>
                {saveError && (
                  <span role="alert" className="ml-2 flex items-center gap-1 font-mono text-[10px] text-[var(--color-danger)]">
                    {saveError}
                  </span>
                )}
                {saveStatus === 'saved' && (
                  <span role="status" aria-live="polite" className="ml-2 flex items-center gap-1 font-mono text-[10px] text-[var(--color-success)]">
                    <Check className="h-3 w-3" /> Saved
                  </span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
                  {activeTab && gitChanged.set.has(activeTab.path) && (
                    <button
                      onClick={() => viewMode === 'diff' ? setViewMode('edit') : void openDiff(activeTab.path)}
                      className="flex min-h-8 items-center gap-1 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      title="Review changes vs HEAD"
                    >
                      {diffBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDiff className="h-3 w-3" />}
                      {viewMode === 'diff' ? 'Edit' : 'Diff'}
                    </button>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1">
                {viewMode === 'diff' && diffData && diffData.path === activeTab?.path ? (
                  <div className="flex h-full min-h-0 flex-col lg:flex-row">
                    <DiffPane label="HEAD" text={diffData.original} />
                    <DiffPane label="Working tree" text={diffData.modified} />
                  </div>
                ) : (
                  <div className="relative h-full min-h-0">
                    <CodeEditor
                      key={activeTab?.path ?? 'empty'}
                      value={activeTab?.content ?? ''}
                      onChange={updateActiveContent}
                      onSelectionChange={setSelection}
                      textareaRef={textareaRef}
                      gutterRef={gutterRef}
                      ariaLabel={`Editing ${activeTab?.name ?? 'file'}`}
                    />
                    {selection && activeTab && (
                      <button
                        type="button"
                        onClick={() => {
                          const text = buildSelectionPrompt({
                            path: activeTab.path,
                            language: activeTab.language,
                            value: activeTab.content,
                            start: selection.start,
                            end: selection.end,
                          });
                          if (!text) return;
                          setAgentSeed({ id: Date.now(), text });
                          setAgentOpen(true);
                        }}
                        className="absolute bottom-3 right-3 z-10 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-surface-overlay)] px-3 text-[11px] font-semibold text-[var(--color-text-primary)] shadow-xl shadow-black/40 hover:bg-[var(--color-surface-raised)]"
                        title="Add the selected code to the agent conversation"
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5 text-[var(--color-accent-text)]" />
                        Ask agent about selection
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-[var(--color-text-muted)]">
              <div className="w-full max-w-sm space-y-4 text-center">
                <div className="text-4xl">⌐◨-◨</div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[var(--color-text-secondary)]">OpenHub Workspace</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {activeProject
                      ? 'Open a file from Files to start editing, or ask the agent to plan and make the change.'
                      : activeProjectLoading ? 'Checking the active project…' : 'Load a project to start working.'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {activeProject ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="min-h-11 rounded-md bg-[var(--color-accent)] px-4 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]"
                      >
                        Browse files
                      </button>
                      <button
                        type="button"
                        onClick={() => setAgentOpen(true)}
                        className="flex min-h-11 items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-4 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                      >
                        <Bot className="h-3.5 w-3.5" /> Ask the agent
                      </button>
                    </>
                  ) : (
                    <Link to="/projects" className="min-h-11 rounded-md bg-[var(--color-accent)] px-4 py-3 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]">
                      Load a project
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Docked coding agent. Kept mounted while closed so a streaming turn
            and its plan checklist survive toggling the panel. */}
        <div
          className={cn(
            'z-50 bg-[var(--color-surface-base)]',
            isMobile
              ? 'fixed inset-y-0 right-0 w-[min(100vw,420px)] border-l border-[var(--color-border-strong)] shadow-2xl shadow-black/50'
              : 'flex w-[380px] shrink-0 border-l border-[var(--color-border-muted)] xl:w-[440px]',
            !agentOpen && 'hidden',
          )}
        >
          <EditorAgentPanel
            activeProjectName={activeProject?.repositoryName ?? null}
            seed={agentSeed}
            onClose={() => setAgentOpen(false)}
          />
        </div>
      </div>

      {isMobile && agentOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70"
          onClick={() => setAgentOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile file drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute left-0 top-0 flex h-[100dvh] w-[min(88vw,340px)] flex-col border-r border-[var(--color-border-muted)] bg-[var(--color-surface-base)] shadow-2xl shadow-black/50">
            <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-[var(--color-border-muted)] px-3">
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">Files</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close files"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {panelTabs}
            <div className="min-h-0 flex-1">{panelContent()}</div>
          </aside>
        </div>
      )}

      {/* Terminal (real shell bridge) */}
      {showTerminal && (
        <div className="h-56 shrink-0 border-t border-[var(--color-border-muted)]">
          <div className="flex items-center justify-between bg-[var(--color-surface-base)]">
            <div className="flex items-center gap-2 px-2 py-1">
              <TerminalIcon className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
              <span className="text-xs text-[var(--color-text-secondary)]">Terminal</span>
            </div>
            <button
              type="button"
              aria-label="Close terminal"
              title="Close terminal"
              className="flex min-h-9 min-w-9 items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
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
              className="min-h-12 w-full bg-transparent px-4 font-mono text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
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
                      'flex min-h-10 w-full items-center px-4 text-left font-mono text-xs',
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

      {/* Minimal status bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 text-[10px] text-[var(--color-text-muted)]">
        <div className="flex min-w-0 items-center gap-3">
          {problems.length > 0 ? (
            <span className="flex items-center gap-1 text-[var(--color-danger)]" title={`${problems.length} TypeScript problem${problems.length === 1 ? '' : 's'}`}>
              <CircleDot className="h-3 w-3" /> {problems.length} error{problems.length === 1 ? '' : 's'}
            </span>
          ) : dirtyCount > 0 ? (
            <span className="flex items-center gap-1 text-[var(--color-warning)]" title="Unsaved editor buffers">
              <CircleDot className="h-3 w-3" /> Unsaved
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[var(--color-success)]">
              <CircleDot className="h-3 w-3" /> Ready
            </span>
          )}
          <span className="truncate font-mono">{gitState?.branch ?? 'no branch'}</span>
          {dirtyCount > 0 && <span className="text-[var(--color-warning)]">{dirtyCount} unsaved</span>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-mono">{activeTab?.language ?? 'plain text'}</span>
          <span className="hidden sm:inline">UTF-8</span>
        </div>
      </footer>
    </div>
  );
}
