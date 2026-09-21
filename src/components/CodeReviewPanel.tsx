import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { getCsrfToken } from '../auth/AuthProvider';
import {
  GitPullRequest,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileCode,
  Wrench,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Filter,
  Check,
  GitBranch,
  Cpu,
  Zap,
  BookOpen,
  Activity,
  Package,
  TestTube,
  X,
  MessageSquare,
  Github,
  Info,
  Send,
  Loader2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import { useStore } from '../store';
import type { ReviewResult, ReviewComment, ReviewCategory } from '../services/codeReviewer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DismissReason = 'false-positive' | 'wont-fix' | 'already-fixed' | 'not-applicable';

interface DismissedSet {
  [commentId: string]: DismissReason;
}

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

interface CategoryMeta {
  label: string;
  icon: React.ReactNode;
  color: string;
}

const CATEGORY_META: Record<ReviewCategory | 'all', CategoryMeta> = {
  all: { label: 'All', icon: <Filter className="w-3 h-3" />, color: 'text-gray-400' },
  security: { label: 'Security', icon: <ShieldAlert className="w-3 h-3" />, color: 'text-red-400' },
  complexity: { label: 'Complexity', icon: <Activity className="w-3 h-3" />, color: 'text-amber-400' },
  performance: { label: 'Performance', icon: <Zap className="w-3 h-3" />, color: 'text-yellow-400' },
  type_safety: { label: 'Type Safety', icon: <Cpu className="w-3 h-3" />, color: 'text-purple-400' },
  api_contract: { label: 'API Contract', icon: <Activity className="w-3 h-3" />, color: 'text-blue-400' },
  test_coverage: { label: 'Tests', icon: <TestTube className="w-3 h-3" />, color: 'text-emerald-400' },
  dependency_risk: { label: 'Dependencies', icon: <Package className="w-3 h-3" />, color: 'text-orange-400' },
  documentation: { label: 'Docs', icon: <BookOpen className="w-3 h-3" />, color: 'text-sky-400' },
};

const ALL_CATEGORIES: Array<ReviewCategory | 'all'> = [
  'all',
  'security',
  'complexity',
  'performance',
  'type_safety',
  'api_contract',
  'test_coverage',
  'dependency_risk',
  'documentation',
];

// ---------------------------------------------------------------------------
// Score badge
// ---------------------------------------------------------------------------

function ScoreBadge({ score, size = 'sm' }: { score: number | null; size?: 'sm' | 'lg' }) {
  if (score === null || score === undefined) {
    return (
      <span
        title="No score was produced for this file — not a pass"
        className={cn(
          'font-bold font-mono border rounded text-gray-400 border-border-muted bg-surface-base',
          size === 'lg' ? 'text-2xl px-3 py-1' : 'text-xs px-1.5 py-0.5',
        )}
      >
        N/A
      </span>
    );
  }
  const color =
    score >= 90
      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : score >= 70
      ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
      : 'text-red-400 border-red-500/30 bg-red-500/10';
  return (
    <span
      className={cn(
        'font-bold font-mono border rounded',
        color,
        size === 'lg' ? 'text-2xl px-3 py-1' : 'text-xs px-1.5 py-0.5',
      )}
    >
      {score}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Determinism badge
// ---------------------------------------------------------------------------

function DeterminismBadge({ determinism }: { determinism: 'deterministic' | 'ai-inferred' }) {
  if (determinism === 'deterministic') {
    return (
      <span
        title="Found by a deterministic static rule — high confidence"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold font-mono uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
      >
        <ShieldCheck className="w-2.5 h-2.5" /> RULE
      </span>
    );
  }
  return (
    <span
      title="Found by AI analysis — verify before acting"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold font-mono uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20"
    >
      <Zap className="w-2.5 h-2.5" /> AI
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline diff context viewer
// ---------------------------------------------------------------------------

function ContextLines({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="rounded-md overflow-hidden border border-border-muted text-[11px] font-mono">
      {lines.map((line, i) => {
        const isAdded = line.startsWith('+');
        const isRemoved = line.startsWith('-');
        return (
          <div
            key={i}
            className={cn(
              'px-3 py-0.5 leading-5',
              isAdded && 'bg-emerald-500/10 text-emerald-300',
              isRemoved && 'bg-red-500/10 text-red-300',
              !isAdded && !isRemoved && 'text-gray-400 bg-surface-raised',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dismiss popover
// ---------------------------------------------------------------------------

function DismissPopover({
  commentId,
  onDismiss,
  onClose,
}: {
  commentId: string;
  onDismiss: (id: string, reason: DismissReason) => void;
  onClose: () => void;
}) {
  const reasons: { value: DismissReason; label: string }[] = [
    { value: 'false-positive', label: 'False positive' },
    { value: 'wont-fix', label: "Won't fix" },
    { value: 'already-fixed', label: 'Already fixed' },
    { value: 'not-applicable', label: 'Not applicable' },
  ];
  return (
    <div className="absolute right-0 top-8 z-50 bg-surface-raised border border-border-muted rounded-xl shadow-2xl p-3 w-48 space-y-1">
      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 pb-1">
        Dismiss reason
      </div>
      {reasons.map((r) => (
        <button
          key={r.value}
          onClick={() => {
            onDismiss(commentId, r.value);
            onClose();
          }}
          className="w-full text-left px-2 py-1.5 text-xs text-gray-300 hover:bg-surface-overlay rounded-lg transition-colors"
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single finding card
// ---------------------------------------------------------------------------

function FindingCard({
  comment,
  applyingId,
  appliedIds,
  dismissed,
  onApply,
  onDismiss,
}: {
  comment: ReviewComment;
  applyingId: string | null;
  appliedIds: Set<string>;
  dismissed: DismissedSet;
  onApply: (c: ReviewComment) => void;
  onDismiss: (id: string, reason: DismissReason) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const isDismissed = !!dismissed[comment.id];

  if (isDismissed) {
    return (
      <div className="bg-surface-base/50 border border-border-muted/50 rounded-xl p-3 flex items-center justify-between opacity-50">
        <span className="text-xs text-gray-500 font-mono">
          {comment.file}:{comment.line} — <em>{comment.title}</em> (dismissed: {dismissed[comment.id]})
        </span>
        <button
          onClick={() => onDismiss(comment.id, 'not-applicable')}
          className="text-[10px] text-gray-500 hover:text-gray-300 underline"
        >
          undo
        </button>
      </div>
    );
  }

  return (
    <div className="bg-surface-base border border-border-muted rounded-xl p-4 space-y-3 hover:border-border-muted/80 transition-colors">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center flex-wrap gap-2">
          <span
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-bold uppercase font-mono',
              comment.severity === 'critical' && 'bg-red-500/20 text-red-400 border border-red-500/30',
              comment.severity === 'warning' && 'bg-amber-500/20 text-amber-400 border border-amber-500/30',
              comment.severity === 'info' && 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
            )}
          >
            {comment.severity}
          </span>
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface-raised text-gray-400 border border-border-muted">
            {CATEGORY_META[comment.category]?.label ?? comment.category}
          </span>
          <DeterminismBadge determinism={comment.determinism} />
          <span className="text-xs font-mono text-gray-300">
            {comment.file}:{comment.line}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {comment.suggestedPatch && (
            <button
              onClick={() => onApply(comment)}
              disabled={applyingId === comment.id || appliedIds.has(comment.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold transition-colors shadow-sm',
                appliedIds.has(comment.id)
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50',
              )}
            >
              {appliedIds.has(comment.id) ? (
                <><Check className="w-3 h-3 text-emerald-400" /> Applied</>
              ) : applyingId === comment.id ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Applying…</>
              ) : (
                <><Wrench className="w-3 h-3" /> Apply Fix</>
              )}
            </button>
          )}

          {/* Dismiss */}
          <div className="relative">
            <button
              onClick={() => setDismissOpen((o) => !o)}
              title="Dismiss finding"
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-surface-raised border border-transparent hover:border-border-muted transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            {dismissOpen && (
              <DismissPopover
                commentId={comment.id}
                onDismiss={onDismiss}
                onClose={() => setDismissOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div>
        <div className="text-xs font-bold text-gray-100">{comment.title}</div>
        <p className="text-xs text-gray-400 mt-1 leading-relaxed">{comment.description}</p>
      </div>

      {/* Context lines toggle */}
      {comment.contextLines && comment.contextLines.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors font-mono"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {expanded ? 'Hide' : 'Show'} diff context
          </button>
          {expanded && <div className="mt-2"><ContextLines lines={comment.contextLines} /></div>}
        </div>
      )}

      {/* Suggested patch preview */}
      {comment.suggestedPatch && (
        <div className="bg-surface-raised rounded-lg border border-border-muted p-3 space-y-2 text-xs font-mono">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 font-sans font-semibold">
            Suggested Code Change
          </div>
          <div className="space-y-1 overflow-x-auto">
            <div className="p-1.5 rounded bg-red-500/10 text-red-300 border border-red-500/20">
              - {comment.suggestedPatch.original}
            </div>
            <div className="p-1.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
              + {comment.suggestedPatch.replacement}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File tree item
// ---------------------------------------------------------------------------

function FileTreeItem({
  file,
  score,
  comments,
  applyingId,
  appliedIds,
  dismissed,
  onApply,
  onDismiss,
}: {
  file: string;
  score: number | null;
  comments: ReviewComment[];
  applyingId: string | null;
  appliedIds: Set<string>;
  dismissed: DismissedSet;
  onApply: (c: ReviewComment) => void;
  onDismiss: (id: string, reason: DismissReason) => void;
}) {
  const [open, setOpen] = useState(true);
  const activeFindingsCount = comments.filter((c) => !dismissed[c.id]).length;

  return (
    <div className="border border-border-muted rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface-raised hover:bg-surface-overlay transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />}
        <FileCode className="w-4 h-4 text-gray-400 shrink-0" />
        <span className="text-sm font-mono text-gray-200 flex-1 truncate">{file}</span>
        {activeFindingsCount > 0 && (
          <span className="text-[10px] font-bold font-mono bg-surface-base border border-border-muted rounded px-1.5 py-0.5 text-gray-400">
            {activeFindingsCount} finding{activeFindingsCount !== 1 ? 's' : ''}
          </span>
        )}
        <ScoreBadge score={score} />
      </button>

      {open && comments.length > 0 && (
        <div className="divide-y divide-border-muted/50">
          {comments.map((c) => (
            <div key={c.id} className="p-3">
              <FindingCard
                comment={c}
                applyingId={applyingId}
                appliedIds={appliedIds}
                dismissed={dismissed}
                onApply={onApply}
                onDismiss={onDismiss}
              />
            </div>
          ))}
        </div>
      )}

      {open && comments.length === 0 && (
        <div className="px-4 py-3 text-xs text-gray-500 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" /> No issues detected
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Walk-through card
// ---------------------------------------------------------------------------

function WalkthroughCard({ text }: { text: string }) {
  return (
    <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-blue-400" />
        <span className="text-xs font-bold text-blue-300 uppercase tracking-wider">AI Walk-Through</span>
        <span className="text-[11px] font-mono text-blue-500 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">ai-inferred</span>
      </div>
      <p className="text-sm text-gray-300 leading-relaxed">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function CodeReviewPanel() {
  const { activeProject } = useStore();
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [llmLoading, setLlmLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState('HEAD');
  const [categoryFilter, setCategoryFilter] = useState<ReviewCategory | 'all'>('all');
  const [viewMode, setViewMode] = useState<'file-tree' | 'flat'>('file-tree');
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<DismissedSet>({});
  const [postingToGithub, setPostingToGithub] = useState(false);
  const [githubPosted, setGithubPosted] = useState(false);
  const [githubPostError, setGithubPostError] = useState<string | null>(null);
  const [prOwner, setPrOwner] = useState('');
  const [prRepo, setPrRepo] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [showPrInputs, setShowPrInputs] = useState(false);

  // Run fast static-only review first
  const runReview = useCallback(async () => {
    if (!activeProject?.path) return;
    setLoading(true);
    setError(null);
    setGithubPosted(false);
    setGithubPostError(null);
    try {
      const res = await fetch('/api/review/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({ targetDir: activeProject.path, baseRef }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data.result);
    } catch (err: any) {
      setError(err.message || 'Failed to review code changes');
    } finally {
      setLoading(false);
    }
  }, [activeProject?.path, baseRef]);

  // Run AI-enhanced review (fires after static, enriches with LLM findings + walkthrough)
  const runAiReview = useCallback(async () => {
    if (!activeProject?.path) return;
    setLlmLoading(true);
    try {
      const res = await fetch('/api/ai/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({
          repoName: activeProject.repositoryName || 'project',
          targetDir: activeProject.path,
          baseRef,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.result) {
        setResult(data.result);
      }
    } catch (err: any) {
      // Surface AI-review failures honestly: static results remain, but the
      // operator sees that enrichment failed instead of silent success.
      setError(`AI enrichment failed: ${err.message || 'review endpoint error'} (static results above are unaffected)`);
    } finally {
      setLlmLoading(false);
    }
  }, [activeProject?.path, activeProject?.repositoryName, baseRef]);

  useEffect(() => {
    if (activeProject?.path) {
      runReview().then(() => runAiReview());
    }
  }, [activeProject?.path, baseRef]);

  const handleApplyPatch = async (comment: ReviewComment) => {
    if (!activeProject?.path || !comment.suggestedPatch) return;
    setApplyingId(comment.id);
    try {
      const res = await fetch('/api/review/apply-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({
          targetDir: activeProject.path,
          file: comment.file,
          original: comment.suggestedPatch.original,
          replacement: comment.suggestedPatch.replacement,
        }),
      });
      if (res.ok) {
        setAppliedIds((prev) => new Set(prev).add(comment.id));
        setTimeout(() => runReview().then(() => runAiReview()), 800);
      } else {
        const data = await res.json();
        setError(data.error || 'Patch application failed');
      }
    } catch (err: any) {
      setError(err.message || 'Error applying patch');
    } finally {
      setApplyingId(null);
    }
  };

  const handleDismiss = useCallback(async (commentId: string, reason: DismissReason) => {
    // Toggle: if same ID dismissed again, un-dismiss it
    setDismissed((prev) => {
      if (prev[commentId] && prev[commentId] === reason) {
        const next = { ...prev };
        delete next[commentId];
        return next;
      }
      return { ...prev, [commentId]: reason };
    });
    // Best-effort server audit
    fetch('/api/review/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      credentials: 'include',
      body: JSON.stringify({ commentId, reason }),
    }).catch(() => {/* non-fatal */});
  }, []);

  const filteredComments = useMemo(() => {
    if (!result?.comments) return [];
    return result.comments.filter(
      (c) => categoryFilter === 'all' || c.category === categoryFilter,
    );
  }, [result, categoryFilter]);

  // Group by file for file-tree view
  const byFile = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of filteredComments) {
      const arr = map.get(c.file) ?? [];
      arr.push(c);
      map.set(c.file, arr);
    }
    // Also add files that have no comments in current filter but have scores
    if (result?.fileScores) {
      for (const file of Object.keys(result.fileScores)) {
        if (!map.has(file)) map.set(file, []);
      }
    }
    // Sort: files with most critical findings first
    return Array.from(map.entries()).sort(([, a], [, b]) => {
      const critA = a.filter((c) => c.severity === 'critical').length;
      const critB = b.filter((c) => c.severity === 'critical').length;
      return critB - critA;
    });
  }, [filteredComments, result?.fileScores]);

  // Category counts for tab badges
  const categoryCounts = useMemo(() => {
    if (!result?.comments) return {} as Record<string, number>;
    return result.comments.reduce<Record<string, number>>((acc, c) => {
      acc[c.category] = (acc[c.category] ?? 0) + 1;
      return acc;
    }, {});
  }, [result]);

  const overallScore = useMemo(() => {
    if (!result?.fileScores) return null;
    const scores = Object.values(result.fileScores);
    if (!scores.length) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }, [result?.fileScores]);

  const activeFindingsCount = filteredComments.filter((c) => !dismissed[c.id]).length;

  return (
    <div className="space-y-5">
      {/* ── Header & Controls ─────────────────────────────────────────── */}
      <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <GitPullRequest className="w-5 h-5 text-blue-400" />
              <h3 className="text-base font-bold text-gray-100">Autonomous Semantic Code Reviewer</h3>
              <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded font-mono font-bold">
                v2 · AI + Static
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              18-rule static engine + LLM diff analysis · security · complexity · performance · type safety · API contracts · test coverage
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 bg-surface-base px-2.5 py-1 rounded-lg border border-border-muted text-xs font-mono">
              <GitBranch className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-gray-500">Diff vs:</span>
              <select
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                className="bg-transparent text-gray-200 outline-none cursor-pointer"
              >
                <option value="HEAD">HEAD (Working Tree)</option>
                <option value="main">main branch</option>
                <option value="master">master branch</option>
                <option value="HEAD~1">Previous Commit (HEAD~1)</option>
              </select>
            </div>

            <button
              onClick={() => setViewMode((m) => (m === 'file-tree' ? 'flat' : 'file-tree'))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-base border border-border-muted hover:bg-surface-overlay text-gray-400 transition-colors"
            >
              <FileCode className="w-3.5 h-3.5" />
              {viewMode === 'file-tree' ? 'Flat view' : 'File tree'}
            </button>

            <button
              onClick={() => runReview().then(() => runAiReview())}
              disabled={loading || !activeProject}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-base border border-border-muted hover:bg-surface-overlay text-gray-200 transition-colors shadow-sm"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', (loading || llmLoading) && 'animate-spin')} />
              {loading ? 'Analyzing…' : llmLoading ? 'AI enriching…' : 'Re-run Review'}
            </button>
          </div>
        </div>

        {/* ── Summary metrics ─────────────────────────────────────────── */}
        {result && (
          <div className="pt-4 border-t border-border-muted grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs font-mono">
            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Quality Gate</span>
              <span
                className={cn(
                  'text-base font-bold font-mono mt-1 block uppercase',
                  result.verdict === 'APPROVE' && 'text-emerald-400',
                  result.verdict === 'COMMENT' && 'text-amber-400',
                  result.verdict === 'REQUEST_CHANGES' && 'text-red-400',
                )}
              >
                {result.verdict.replace('_', ' ')}
              </span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Overall Score</span>
              {overallScore !== null ? (
                <div className="mt-1"><ScoreBadge score={overallScore} size="lg" /></div>
              ) : (
                <span className="text-gray-500 text-lg font-bold mt-1 block">—</span>
              )}
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Critical</span>
              <span className="text-red-400 font-bold text-lg mt-1 block">{result.summary.critical}</span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Warnings</span>
              <span className="text-amber-400 font-bold text-lg mt-1 block">{result.summary.warning}</span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Files</span>
              <span className="text-gray-200 font-bold text-lg mt-1 block">{result.summary.filesReviewed}</span>
            </div>

            <div className="bg-surface-base p-3 rounded-lg border border-border-muted">
              <span className="text-[10px] text-gray-400 uppercase tracking-wider block font-sans">Lines +</span>
              <span className="text-blue-400 font-bold text-lg mt-1 block">+{result.summary.linesChanged}</span>
            </div>
          </div>
        )}

        {/* LLM loading status bar */}
        {llmLoading && (
          <div className="pt-2 flex items-center gap-2 text-xs text-purple-400 font-mono">
            <Loader2 className="w-3 h-3 animate-spin" />
            AI is analyzing your diff for deeper findings…
          </div>
        )}
      </div>

      {/* ── Walk-through ────────────────────────────────────────────────── */}
      {result?.walkthrough && <WalkthroughCard text={result.walkthrough} />}

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-200">✕</button>
        </div>
      )}

      {/* ── Category tabs ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {ALL_CATEGORIES.map((cat) => {
          const meta = CATEGORY_META[cat];
          const count = cat === 'all' ? (result?.comments.length ?? 0) : (categoryCounts[cat] ?? 0);
          return (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors',
                categoryFilter === cat
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-surface-base text-gray-400 hover:text-gray-200 border border-border-muted',
              )}
            >
              {meta.icon}
              {meta.label}
              {count > 0 && (
                <span
                  className={cn(
                    'text-[10px] font-bold rounded-full px-1.5 py-0.5',
                    categoryFilter === cat ? 'bg-white/20 text-white' : 'bg-surface-raised text-gray-400',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Dismissed info ──────────────────────────────────────────────── */}
      {Object.keys(dismissed).length > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Info className="w-3.5 h-3.5" />
          {Object.keys(dismissed).length} finding{Object.keys(dismissed).length !== 1 ? 's' : ''} dismissed this session.
          <button onClick={() => setDismissed({})} className="underline hover:text-gray-300">
            Clear all
          </button>
        </div>
      )}

      {/* ── Findings ────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {loading && !result ? (
          <div className="text-center py-12 text-gray-500 text-xs font-mono">
            Running 18-rule static analysis…
          </div>
        ) : activeFindingsCount === 0 && !loading ? (
          <div className="bg-surface-raised border border-border-muted rounded-xl p-8 text-center space-y-2">
            <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
            <h4 className="text-sm font-bold text-gray-100">
              {Object.keys(dismissed).length > 0 ? 'All findings dismissed' : 'Clean Review — No Issues Found'}
            </h4>
            <p className="text-xs text-gray-400 max-w-md mx-auto">
              Changeset passes all security, maintainability, API contract, and test coverage gates. Ready to commit or merge.
            </p>
          </div>
        ) : viewMode === 'file-tree' ? (
          <div className="space-y-3">
            {byFile.map(([file, comments]) => (
              <FileTreeItem
                key={file}
                file={file}
                score={result?.fileScores[file] ?? null}
                comments={comments}
                applyingId={applyingId}
                appliedIds={appliedIds}
                dismissed={dismissed}
                onApply={handleApplyPatch}
                onDismiss={handleDismiss}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredComments.map((comment) => (
              <FindingCard
                key={comment.id}
                comment={comment}
                applyingId={applyingId}
                appliedIds={appliedIds}
                dismissed={dismissed}
                onApply={handleApplyPatch}
                onDismiss={handleDismiss}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className="pt-2 border-t border-border-muted flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs font-mono text-gray-400">
        <div className="flex items-center gap-3">
          {result?.receiptId && (
            <Link
              to={`/assurance?av=receipts&id=${result.receiptId}`}
              className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
            >
              Receipt #{result.receiptId.slice(0, 12)}…
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          )}
          {result?.reviewSessionId && (
            <span className="text-gray-600">Session: {result.reviewSessionId}</span>
          )}
        </div>

        {/* GitHub post-back — real /api/ai/review/pr call with PR context.
            No PR context = button stays disabled with an honest explanation;
            never a fake "Posted to GitHub" after a setTimeout. */}
        <div className="flex flex-col items-end gap-2">
          {githubPostError && (
            <span className="text-red-400 text-xs font-mono max-w-xs text-right">{githubPostError}</span>
          )}
          {showPrInputs && (
            <div className="flex items-center gap-1.5 text-xs font-mono">
              <input
                value={prOwner}
                onChange={(e) => setPrOwner(e.target.value)}
                placeholder="owner"
                className="w-24 bg-surface-base border border-border-muted rounded px-2 py-1 text-gray-200 outline-none"
              />
              <span className="text-gray-600">/</span>
              <input
                value={prRepo}
                onChange={(e) => setPrRepo(e.target.value)}
                placeholder="repo"
                className="w-24 bg-surface-base border border-border-muted rounded px-2 py-1 text-gray-200 outline-none"
              />
              <span className="text-gray-600">#</span>
              <input
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="PR #"
                className="w-16 bg-surface-base border border-border-muted rounded px-2 py-1 text-gray-200 outline-none"
              />
            </div>
          )}
          <button
            disabled={!result || postingToGithub || githubPosted || !prOwner.trim() || !prRepo.trim() || !prNumber.trim()}
            onClick={async () => {
              if (!result) return;
              const pullNumber = Number(prNumber);
              if (!prOwner.trim() || !prRepo.trim() || !Number.isFinite(pullNumber) || pullNumber <= 0) {
                setGithubPostError('Enter owner, repo, and a PR number before posting.');
                return;
              }
              setPostingToGithub(true);
              setGithubPostError(null);
              try {
                const res = await fetch('/api/ai/review/pr', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                  credentials: 'include',
                  body: JSON.stringify({
                    owner: prOwner.trim(),
                    repo: prRepo.trim(),
                    pullNumber,
                    postToGitHub: true,
                  }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.ok === false) {
                  throw new Error(data.error || `HTTP ${res.status}`);
                }
                if (data.postError) {
                  throw new Error(data.postError);
                }
                if (!data.postedToGitHub) {
                  throw new Error('GitHub did not confirm the post-back.');
                }
                setGithubPosted(true);
              } catch (err: any) {
                setGithubPostError(`Post to GitHub failed: ${err.message || 'unknown error'}`);
              } finally {
                setPostingToGithub(false);
              }
            }}
            onFocus={() => setShowPrInputs(true)}
            title={!prOwner || !prRepo || !prNumber ? 'Enter the GitHub PR (owner/repo/#) to enable posting' : 'Post review findings as inline comments on GitHub PR'}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-colors border',
              githubPosted
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-border-muted bg-surface-base hover:bg-surface-overlay text-gray-400 hover:text-gray-200 disabled:opacity-40',
            )}
          >
            {postingToGithub ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Posting…</>
            ) : githubPosted ? (
              <><Check className="w-3.5 h-3.5" /> Posted to GitHub</>
            ) : (
              <><Github className="w-3.5 h-3.5" /> Post to GitHub PR</>
            )}
          </button>
          {!showPrInputs && (
            <button
              onClick={() => setShowPrInputs(true)}
              className="text-gray-600 hover:text-gray-300 text-xs underline"
            >
              Set PR target
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
