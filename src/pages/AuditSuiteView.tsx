import { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Play, Search, RefreshCw, Copy, ExternalLink } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';
import { useStore } from '../store';
import { DimensionRadar } from '../components/DimensionRadar';

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

interface DimensionCoverageEntry {
  dimension: string;
  label: string;
  status: 'covered' | 'partial' | 'uncovered';
  score: number | null;
  analyzers: string[];
  blocked: string[];
  findings: number;
  reason?: string;
}

interface AuditFinding {
  id: string;
  source: string;
  dimension: string;
  category: string;
  severity: string;
  confidence: number;
  determinism?: string;
  location?: { file: string; line?: number };
  evidence?: string;
  remediation?: string;
  corroboratedBy?: string[];
}

interface DimensionScore {
  dimension: string;
  label: string;
  score: number | null;
  weight: number;
  deterministic: number | null;
  llm: number | null;
  llmShare: number;
  llmCapped: boolean;
}

interface AuditDeltaView {
  baselineId?: string | null;
  headline: string;
  score: { from: number | null; to: number | null; delta: number | null };
  grade: { from: string | null; to: string; changed: boolean };
  findings: {
    newCount: number;
    fixedCount: number;
    persistedCount: number;
    newByDimension: Record<string, number>;
  };
  reasons: string[];
}

interface AuditScopeView {
  mode: 'full' | 'diff';
  base?: string | null;
  changedFiles: string[];
  insertions: number;
  deletions: number;
  note?: string;
}

interface AuditReport {
  id: string;
  timestamp: string;
  target: string;
  results: {
    scorer: string;
    score: number | null;
    grade?: string;
    summary: string;
    error?: string;
  }[];
  overallStatus: 'pass' | 'warn' | 'fail';
  overallScore?: number | null;
  overallScoreDeterministic?: number | null;
  grade?: string;
  reconciliation?: {
    weightedScore: number | null;
    grade: string;
    contributing: Array<{ scorer: string; score: number; weight: number }>;
    excluded: Array<{ scorer: string; reason: string }>;
  };
  coverage?: {
    dimensions: DimensionCoverageEntry[];
    covered: number;
    partial: number;
    uncovered: number;
    total: number;
  };
  findings?: AuditFinding[];
  dedup?: { input: number; unique: number; duplicates: number; corroborated: number; dedupRatio: number };
  dimensions?: DimensionScore[];
  coveragePercent?: number;
  scope?: AuditScopeView;
  delta?: AuditDeltaView | null;
  preflight?: {
    tools: Array<{ name: string; available: boolean; version?: string; reason?: string; kind?: string; dimension?: string }>;
    ready: string[];
    missing: string[];
  };
  determinismConfig?: { model: string | null; seed: number | null; source: string };
}

export function AuditSuiteView() {
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<AuditReport[]>([]);
  const [activeReport, setActiveReport] = useState<AuditReport | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [auditBackends, setAuditBackends] = useState<{ name: string; label?: string; kind: string; configured: boolean; endpoint?: string; description?: string; stats?: { runs: number; avgScore: number | null; lastScore: number | null; fails: number; last: { score: number | null; summary: string; error?: string } | null } }[]>([]);
  const [readouts, setReadouts] = useState<any[]>([]);
  const [workOrder, setWorkOrder] = useState<{ items: any[]; total: number } | null>(null);
  const [dimFilter, setDimFilter] = useState<string>('all');
  const [sevFilter, setSevFilter] = useState<string>('all');
  const [copied, setCopied] = useState<string | null>(null);
  const { activeProject, activeProjectLoading, activeProjectError, fetchActiveProject } = useStore();

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/audit/history', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok && Array.isArray(data.history)) {
        setHistory(data.history);
        if (!activeReport && data.history.length > 0) {
          setActiveReport(data.history[0]);
        }
      }
    } catch {}
  };

  useEffect(() => {
    void fetchHistory();
    void fetchActiveProject();
    (async () => {
      try {
        const res = await fetch('/api/audit/tools', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok && Array.isArray(data.tools)) setAuditBackends(data.tools);
      } catch { /* audit tools offline — audit still runs */ }
    })();
    (async () => {
      try {
        const res = await fetch('/api/audit/readouts', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok) {
          setReadouts(Array.isArray(data.readouts) ? data.readouts : []);
          setWorkOrder(data.workOrder ?? null);
        }
      } catch { /* readouts offline */ }
    })();
  }, [fetchActiveProject]);

  const handleAuditAndRepair = async () => {
    if (!activeProject) return;
    setRepairing(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/repair/audit-and-repair', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      });
      const data = await res.json();
      if (data.audit) {
        setActiveReport(data.audit as AuditReport);
        setHistory((prev) => [data.audit as AuditReport, ...prev.filter((report) => report.id !== data.audit.id)]);
      }
      setActionMessage(data.message || data.error || `Audit and repair request failed (${res.status})`);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Audit and repair request failed');
    } finally {
      setRepairing(false);
    }
  };

  const handleRunAudit = async () => {
    if (!activeProject) return;
    setRunning(true);
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        // No explicit scorer list: run the server's full dimension roster
        // (core + P2 analyzers) so coverage is complete by default.
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.ok && data.report) {
        setActiveReport(data.report);
        setHistory((prev) => [data.report, ...prev]);
      }
    } catch {}
    setRunning(false);
  };

  const scored = activeReport?.results.filter((r) => r.score !== null) ?? [];
  const reconciledScore = activeReport?.overallScore ?? (scored.length ? Math.round(scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length) : null);
  const grade = activeReport?.grade ?? (reconciledScore !== null ? String(reconciledScore) : '—');
  const deterministicScore = activeReport?.overallScoreDeterministic ?? null;
  const statusAccent = activeReport?.overallStatus === 'pass' ? 'var(--color-success)' : activeReport?.overallStatus === 'warn' ? 'var(--color-warning)' : 'var(--color-danger)';
  const coverage = activeReport?.coverage;
  const findings = activeReport?.findings ?? [];
  const dedup = activeReport?.dedup;
  const dimensions = activeReport?.dimensions ?? [];
  const delta = activeReport?.delta ?? null;
  const scope = activeReport?.scope;

  const findingDimensions = useMemo(() => [...new Set(findings.map((f) => f.dimension))].sort(), [findings]);
  const findingSeverities = useMemo(
    () => [...new Set(findings.map((f) => f.severity))].sort((a, b) => (SEVERITY_RANK[a] ?? 9) - (SEVERITY_RANK[b] ?? 9)),
    [findings],
  );
  const visibleFindings = useMemo(
    () =>
      findings
        .filter((f) => dimFilter === 'all' || f.dimension === dimFilter)
        .filter((f) => sevFilter === 'all' || f.severity === sevFilter)
        .slice()
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)),
    [findings, dimFilter, sevFilter],
  );

  const repoFull = activeProject?.githubFullName;
  const permalink = (f: AuditFinding): string | null =>
    repoFull && f.location?.file
      ? `https://github.com/${repoFull}/blob/HEAD/${f.location.file}${f.location.line ? `#L${f.location.line}` : ''}`
      : null;
  const copyLocation = async (f: AuditFinding) => {
    const text = f.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : f.category;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(f.id);
      setTimeout(() => setCopied((c) => (c === f.id ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };
  const preflight = activeReport?.preflight;
  const determinismConfig = activeReport?.determinismConfig;

  const statusTone = (status: DimensionCoverageEntry['status']) =>
    status === 'covered' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
      : status === 'partial' ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
        : 'text-gray-400 border-border-muted bg-surface-base/60';

  const stats = [
    { label: 'Reports', value: String(history.length), sub: history.length ? 'runs recorded' : 'none yet', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: Math.min(100, history.length * 20) },
    { label: 'Reconciled grade', value: activeReport ? `${grade}${reconciledScore !== null ? ` · ${reconciledScore}` : ''}` : '—', sub: activeReport ? activeReport.target.slice(0, 28) : 'run an audit', accent: statusAccent, accent2: 'var(--color-accent)', pct: reconciledScore ?? 6 },
    { label: 'Deterministic', value: deterministicScore !== null ? String(deterministicScore) : '—', sub: 'LLM excluded', accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: deterministicScore ?? 6 },
    { label: 'Dimensions', value: coverage ? `${coverage.covered + coverage.partial}/${coverage.total}` : `${scored.length}/${activeReport?.results.length ?? 12}`, sub: coverage ? `${coverage.uncovered} uncovered · ${findings.length} findings` : 'run an audit to see the breakdown', accent: 'var(--color-accent)', accent2: 'var(--color-info)', pct: coverage ? Math.round(((coverage.covered + coverage.partial) / Math.max(1, coverage.total)) * 100) : 6 },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-10 -top-14 opacity-[0.12] pointer-events-none">
          <ShieldAlert className="w-64 h-64 text-blue-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-blue-300">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          Reporank · Grader · Claw · Codegraph · OCR · Deep · CodeGang · Typecheck · Lint · Local QA
        </div>
        <h2 className="mt-2">
          Audit suite <span className="text-info">with verdict.</span>
        </h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">
          Grade, scan, and repair the active project in one pass.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            onClick={handleRunAudit}
            disabled={running || repairing || !activeProject}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run audit
          </button>
          <button
            onClick={handleAuditAndRepair}
            disabled={running || repairing || !activeProject}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
          >
            {repairing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
            Audit &amp; repair
          </button>
          <button
            onClick={fetchHistory}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-blue-500/50 px-4 py-2 text-sm font-bold text-gray-400"
          >
            <RefreshCw className="w-4 h-4" /> History
          </button>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-3 gap-3" aria-label="Audit status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {/* Trend vs the previous audit for this target */}
      {delta && (
        <section className="industrial-card p-4" aria-label="Audit trend">
          <div className="flex items-center justify-between gap-2">
            <h2 className="!text-base flex items-center gap-2"><RefreshCw className="w-4 h-4 text-blue-300" /> Trend</h2>
            <span className="count-pill">{delta.baselineId ? `vs ${delta.baselineId.slice(0, 8)}` : 'new baseline'}</span>
          </div>
          <p className="mt-2 text-sm text-gray-300">{delta.headline}</p>
          <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px]">
            <span className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-red-300">{delta.findings.newCount} new</span>
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">{delta.findings.fixedCount} fixed</span>
            <span className="rounded-full border border-border-muted px-2 py-0.5 text-gray-400">{delta.findings.persistedCount} persisted</span>
            {scope && (
              <span className="rounded-full border border-border-muted px-2 py-0.5 text-gray-400">
                {scope.mode === 'diff' ? `diff vs ${scope.base} · ${scope.changedFiles.length} files` : 'full tree'}
              </span>
            )}
          </div>
          {delta.reasons.length > 0 && (
            <div className="mt-2 text-[11px] text-gray-400">grade moved because: {delta.reasons.join(' · ')}</div>
          )}
          {scope?.note && <div className="mt-1 text-[10px] text-amber-300">{scope.note}</div>}
        </section>
      )}

      {/* Dimension coverage matrix — explicit uncovered cells */}
      {coverage && (
        <section className="industrial-card overflow-hidden" aria-label="Dimension coverage">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-blue-300" /> Dimension coverage</h2>
            <span className="count-pill">{coverage.covered} covered · {coverage.partial} partial · {coverage.uncovered} uncovered</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 p-3">
            {coverage.dimensions.map((d) => (
              <div key={d.dimension} className={`rounded-lg border px-3 py-2 ${statusTone(d.status)}`} title={d.reason || d.analyzers.join(', ')}>
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-bold">{d.label}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] uppercase">{d.status}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
                  <span>{d.score !== null ? `score ${d.score}` : '—'}</span>
                  <span>{d.findings} findings</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] opacity-80">
                  {d.status === 'uncovered' ? (d.reason || 'no analyzer') : d.analyzers.join(', ')}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Analyzer availability (preflight gaps are first-class) */}
      {preflight && (
        <section className="industrial-card overflow-hidden" aria-label="Analyzer availability">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-blue-300" /> Analyzer availability</h2>
            <span className="count-pill">{preflight.ready.length} ready · {preflight.missing.length} missing</span>
          </div>
          <div className="flex flex-wrap gap-1.5 p-3">
            {preflight.tools.map((t) => (
              <span
                key={t.name}
                title={t.available ? (t.version || t.name) : (t.reason || t.name)}
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${t.available ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-border-muted bg-surface-base/60 text-gray-400'}`}
              >
                {t.name}
              </span>
            ))}
            {determinismConfig?.source === 'env' && (
              <span className="ml-auto rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 font-mono text-[10px] text-purple-300">
                pinned {determinismConfig.model ?? 'model?'}{determinismConfig.seed !== null ? ` · seed ${determinismConfig.seed}` : ''}
              </span>
            )}
          </div>
        </section>
      )}

      {/* Per-dimension scores — deterministic vs LLM split */}
      {dimensions.length > 0 && (
        <section className="industrial-card overflow-hidden" aria-label="Dimension scores">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-blue-300" /> Dimension scores</h2>
            <span className="count-pill">{activeReport?.coveragePercent ?? 0}% coverage</span>
          </div>
          <div className="p-3 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-3 items-start">
            <div className="hidden lg:block text-gray-300">
              <DimensionRadar dimensions={dimensions.map((d) => ({ label: d.label, score: d.score }))} />
            </div>
            <div className="space-y-2">
            {dimensions.map((d) => (
              <div key={d.dimension} className="rounded-lg border border-border-muted bg-surface-base/50 px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold text-[var(--color-text-primary)]">{d.label}</span>
                  {d.llmCapped && <span className="rounded-full border border-purple-500/40 bg-purple-500/10 px-1.5 py-0.5 font-mono text-[11px] uppercase text-purple-300">llm capped</span>}
                  <span className="ml-auto font-mono text-[11px] text-gray-300">{d.score ?? '—'}</span>
                </div>
                <div className="meter mt-1.5" style={{ position: 'relative' }}>
                  <span style={{ width: `${d.score ?? 0}%` }} />
                  {d.deterministic !== null && (
                    <span
                      aria-hidden
                      style={{ position: 'absolute', left: `${Math.min(100, Math.max(0, d.deterministic))}%`, top: 0, bottom: 0, width: 2, background: 'var(--color-text-primary)', opacity: 0.75 }}
                    />
                  )}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-gray-400">
                  <span>det {d.deterministic ?? '—'}</span>
                  <span>llm {d.llm ?? '—'}</span>
                  <span>w{d.weight}</span>
                  <span className="ml-auto">{Math.round(d.llmShare * 100)}% llm</span>
                </div>
              </div>
            ))}
            </div>
          </div>
        </section>
      )}

      {/* Deduplicated, corroborated findings — filterable, sortable, jump-to-source */}
      {findings.length > 0 && (
        <section className="industrial-card overflow-hidden" aria-label="Findings">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-orange-300" /> Findings</h2>
            <span className="count-pill">
              {visibleFindings.length}/{findings.length} shown{dedup ? ` · ${dedup.duplicates} deduped · ${dedup.corroborated} corroborated` : ''}
            </span>
          </div>

          {/* Severity + dimension filters (F3) */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-surface-overlay px-4 py-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">severity</span>
            <button onClick={() => setSevFilter('all')} className={`count-pill ${sevFilter === 'all' ? '!bg-blue-600/20 !text-blue-300 !border-blue-500/40' : ''}`}>all</button>
            {findingSeverities.map((s) => (
              <button key={s} onClick={() => setSevFilter(s)} className={`count-pill ${sevFilter === s ? '!bg-blue-600/20 !text-blue-300 !border-blue-500/40' : ''}`}>{s}</button>
            ))}
            <span className="ml-3 text-[10px] font-bold uppercase tracking-wider text-gray-500">dimension</span>
            <button onClick={() => setDimFilter('all')} className={`count-pill ${dimFilter === 'all' ? '!bg-blue-600/20 !text-blue-300 !border-blue-500/40' : ''}`}>all</button>
            {findingDimensions.map((d) => (
              <button key={d} onClick={() => setDimFilter(d)} className={`count-pill ${dimFilter === d ? '!bg-blue-600/20 !text-blue-300 !border-blue-500/40' : ''}`}>{d}</button>
            ))}
          </div>

          <div className="divide-y divide-surface-overlay max-h-96 overflow-y-auto">
            {visibleFindings.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">No findings match this filter.</div>
            ) : (
              visibleFindings.slice(0, 100).map((f) => (
                <div key={f.id} className="px-4 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 rounded-full border border-border-muted px-1.5 py-0.5 font-mono text-[11px] uppercase text-gray-400">{f.severity}</span>
                    <button onClick={() => setDimFilter(f.dimension)} className="shrink-0 rounded-full border border-border-muted px-1.5 py-0.5 font-mono text-[11px] lowercase text-gray-500 hover:text-blue-300" title={`filter: ${f.dimension}`}>{f.dimension}</button>
                    <span className="min-w-0 flex-1 truncate font-mono text-blue-300">{f.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : f.category}</span>
                    <span className="shrink-0 font-mono text-[10px] text-gray-400">{f.source}{f.corroboratedBy?.length ? ` +${f.corroboratedBy.length}` : ''}</span>
                    {permalink(f) && (
                      <a href={permalink(f)!} target="_blank" rel="noreferrer" title="Open in GitHub" className="shrink-0 text-gray-500 hover:text-blue-300">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button onClick={() => void copyLocation(f)} title="Copy location" className="shrink-0 text-gray-500 hover:text-blue-300">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    {copied === f.id && <span className="shrink-0 font-mono text-[11px] text-emerald-300">copied</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400" title={f.evidence || f.category}>{f.evidence || f.category}</div>
                  {f.remediation && <div className="mt-0.5 truncate text-[11px] font-mono text-orange-300/80" title={f.remediation}>fix: {f.remediation}</div>}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Target strip */}
      <section className="glass rounded-xl px-4 py-3 flex items-center gap-3" aria-label="Audit target">
        <span className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center shrink-0">
          <Search className="w-4 h-4 text-blue-300" />
        </span>
        {activeProject ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-[var(--color-text-primary)]">{activeProject.repositoryName}</div>
            <div className="truncate font-mono text-[11px] text-gray-400">{activeProject.githubFullName ? `github.com/${activeProject.githubFullName}` : activeProject.path}</div>
          </div>
        ) : (
          <div className="flex-1 text-sm text-gray-400">
            {activeProjectLoading ? 'Reading the active project context…' : activeProjectError || 'No project loaded.'}
          </div>
        )}
        {history.length > 0 && <span className="count-pill shrink-0">{history.length} runs</span>}
      </section>

      {/* Audit tools — deep per-tool stats & readouts */}
      {auditBackends.length > 0 && (
        <section className="space-y-3" aria-label="Audit tools">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-blue-300" />
            <h2 className="!text-base">Audit tools · {auditBackends.length}</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {auditBackends.map((b) => (
              <div key={b.name} className="industrial-card p-4" title={b.endpoint}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${b.configured ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{b.label ?? b.name}</span>
                  <span className="ml-auto shrink-0 rounded-full border border-border-muted px-2 py-0.5 font-mono text-[10px] uppercase text-gray-400">{b.kind}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
                  <div><div className="text-gray-400">runs</div><div className="font-bold text-[var(--color-text-primary)]">{b.stats?.runs ?? 0}</div></div>
                  <div><div className="text-gray-400">avg</div><div className="font-bold text-[var(--color-text-primary)]">{typeof b.stats?.avgScore === 'number' ? b.stats.avgScore : '—'}</div></div>
                  <div><div className="text-gray-400">fails</div><div className={`font-bold ${(b.stats?.fails ?? 0) > 0 ? 'text-red-400' : 'text-[var(--color-text-primary)]'}`}>{b.stats?.fails ?? 0}</div></div>
                </div>
                {b.stats?.last && (
                  <div className="mt-2 truncate border-t border-surface-overlay pt-2 text-[10px] font-mono text-gray-400">
                    last: {typeof b.stats.last.score === 'number' ? b.stats.last.score : b.stats.last.error ? 'error' : '—'} · {b.stats.last.summary || b.stats.last.error || '—'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agent score cards — The Deep / CodeNexus / Benchmark Olympics */}
      {readouts.length > 0 && (
        <section className="space-y-3" aria-label="Agent score cards">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-blue-300" />
            <h2 className="!text-base">Agent score cards · {readouts.filter((r) => r.available).length}/{readouts.length}</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {readouts.map((r) => {
              const gradeColor =
                r.grade === 'A' ? 'text-emerald-300' : r.grade === 'B' ? 'text-blue-300' : r.grade === 'C' ? 'text-amber-300' : r.grade === 'D' || r.grade === 'F' ? 'text-red-300' : 'text-gray-400';
              return (
                <div key={r.tool} className="industrial-card stat-tile p-4">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${r.available ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{r.label}</span>
                    <span className={`ml-auto shrink-0 font-mono text-2xl font-extrabold ${gradeColor}`}>{r.grade ?? '—'}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-gray-400">
                    <span>score {typeof r.score === 'number' ? r.score : '—'}</span>
                    <span>{r.findings.length} findings</span>
                    {r.scannedFiles != null && <span>{r.scannedFiles} files</span>}
                  </div>
                  <div className="meter mt-2.5"><span style={{ width: `${r.score ?? 0}%`, background: r.grade === 'F' || r.grade === 'D' ? 'var(--color-danger)' : undefined }} /></div>
                  <div className="mt-2">
                    {r.available ? (
                      <>
                        {r.counts && Object.keys(r.counts).length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(r.counts as Record<string, unknown>).slice(0, 4).map(([k, v]) => (
                              <span key={k} className="rounded-full border border-border-muted px-2 py-0.5 font-mono text-[11px] uppercase text-gray-400">{k} {String(v)}</span>
                            ))}
                          </div>
                        )}
                        {r.findings[0] && (
                          <div className="mt-2 line-clamp-2 text-[10px] font-mono text-gray-400" title={r.findings[0].explanation}>
                            {r.findings[0].ruleId && <span className="text-blue-300">{r.findings[0].ruleId}: </span>}
                            {r.findings[0].title}
                          </div>
                        )}
                        {r.readout && <div className="mt-2 line-clamp-3 whitespace-pre-wrap text-[10px] text-gray-400">{r.readout.slice(0, 400)}</div>}
                        {!r.matched && <div className="mt-2 text-[10px] text-amber-300">unmatched report</div>}
                      </>
                    ) : (
                      <div className="mt-2 text-[11px] font-mono text-gray-400">{r.note || 'no report'}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Work order — exact repair instructions */}
      {workOrder && (
        <section className="industrial-card overflow-hidden" aria-label="Repair work order">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-orange-300" /> Repair work order</h2>
            <span className="count-pill">{workOrder.total} items</span>
          </div>
          {workOrder.items.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">No actionable findings yet — run the agents to produce a work order.</div>
          ) : (
            <div className="divide-y divide-surface-overlay max-h-80 overflow-y-auto">
              {workOrder.items.slice(0, 50).map((w, i) => (
                <div key={`${w.tool}-${w.ruleId}-${i}`} className="px-4 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 font-mono text-gray-400">{i + 1}.</span>
                    <span className="truncate font-mono text-blue-300">{w.file}{w.line ? `:${w.line}` : ''}</span>
                    <span className="ml-auto shrink-0 rounded-full border border-border-muted px-1.5 py-0.5 font-mono text-[11px] uppercase text-gray-400">{w.category}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400" title={w.title}>{w.title}</div>
                  <div className="mt-0.5 truncate text-[11px] font-mono text-orange-300/80" title={w.suggestion}>{w.suggestion}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {actionMessage && <div className="text-xs font-mono border border-border-muted bg-surface-base rounded-lg px-3 py-2 text-gray-400">{actionMessage}</div>}

      {/* Results */}
      {activeReport ? (
        <section aria-label="Audit results">
          <div className="flex items-center justify-between gap-4 mb-2.5">
            <h2 className="!text-base">Latest scores</h2>
            <span className="count-pill">{activeReport.id.slice(0, 8)} · {activeReport.timestamp ? new Date(activeReport.timestamp).toLocaleDateString() : 'recent'}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {activeReport.results.map((res, i) => (
              <div key={i} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: res.score !== null && res.score >= 80 ? 'var(--color-success)' : res.score !== null && res.score >= 50 ? 'var(--color-warning)' : 'var(--color-info)' }}>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-[11px] font-extrabold uppercase font-mono tracking-wider text-gray-400">
                    {res.scorer}
                  </span>
                  {res.grade ? (
                    <span className="count-pill">{res.grade}</span>
                  ) : (
                    <span className="count-pill">N/A</span>
                  )}
                </div>
                <div className="mt-1 text-2xl font-extrabold font-mono text-[var(--color-text-primary)]">
                  {res.score !== null ? `${res.score}` : '—'}
                </div>
                <div className="meter mt-2"><span style={{ width: `${res.score ?? 0}%` }} /></div>
                <div className="mt-2 text-xs text-gray-400 leading-snug line-clamp-3">{res.summary}</div>
                {res.error && <div className="mt-1 text-xs text-red-400 font-mono truncate">{res.error}</div>}
              </div>
            ))}
          </div>
          {history.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {history.slice(0, 6).map((report) => (
                <button
                  key={report.id}
                  onClick={() => setActiveReport(report)}
                  aria-label={`View report ${report.id}`}
                  className={`count-pill hover:border-blue-500/50 ${report.id === activeReport.id ? '!bg-blue-600/20 !text-blue-300 !border-blue-500/40' : ''}`}
                >
                  {report.id.slice(0, 8)} · {report.overallStatus}
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="industrial-card p-8 text-center">
          <ShieldAlert className="w-8 h-8 mx-auto text-gray-400" />
          <p className="mt-3 text-sm font-bold text-[var(--color-text-primary)]">No audits yet</p>
          <p className="mt-1 text-xs text-gray-400">Run your first audit to grade this project.</p>
        </div>
      )}
    </div>
  );
}
