import { useEffect } from 'react';
import { Cpu, GitPullRequest, Zap, RefreshCw, ChevronsRight, ArrowRight, Server, KeyRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useModelStore, AXIOM_ROUTES, type LlmTask } from '../lib/modelStore';

interface TaskDef {
  id: LlmTask;
  label: string;
  desc: string;
  icon: LucideIcon;
  accent: string;
}

const TASKS: TaskDef[] = [
  { id: 'axiom', label: 'Axiom Loop', desc: 'Autonomous coding-loop model routing', icon: Zap, accent: 'var(--color-success)' },
  { id: 'review', label: 'AI Review', desc: 'Pull-request review engine', icon: GitPullRequest, accent: 'var(--color-info)' },
  { id: 'default', label: 'Default', desc: 'Fallback for any other LLM call', icon: Cpu, accent: 'var(--color-accent)' },
];

/** Model routing: pick which model each LLM task uses, or cycle through the catalog. */
export function ModelSelectionView() {
  const { models, configuredModel, gatewayUrl, loaded, error, routes, fetchModels, setRoute, cycleRoute } = useModelStore();

  useEffect(() => {
    if (!loaded) void fetchModels();
  }, [loaded, fetchModels]);

  const optionsFor = (task: LlmTask): string[] => {
    if (task === 'axiom') return [...AXIOM_ROUTES];
    const ids = models.map((m) => m.id);
    if (configuredModel && !ids.includes(configuredModel)) ids.unshift(configuredModel);
    for (const fallback of ['fleet-free', 'auto']) if (!ids.includes(fallback)) ids.push(fallback);
    return [...new Set(ids)];
  };

  const currentFor = (task: LlmTask): string => {
    const v = routes[task];
    if (v) return v;
    return task === 'axiom' ? 'auto' : configuredModel || 'fleet-free';
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between border-b border-white/5 pb-4">
        <div>
          <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Model routing</h2>
          <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
            Each LLM task can be pointed at a different model — cycle or pin per task.
          </p>
        </div>
        <button
          onClick={() => void fetchModels()}
          className="inline-flex items-center gap-1.5 rounded border border-border-muted px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)]"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh catalog
        </button>
      </div>

      {/* Gateway status */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-info)' }}>
          <div className="flex items-center gap-2 text-gray-400 text-[10px] font-extrabold uppercase tracking-[0.14em]">
            <Server className="w-4 h-4 text-blue-300" /> Gateway
          </div>
          <div className="mt-2 truncate font-mono text-sm text-[var(--color-text-primary)]" title={gatewayUrl ?? ''}>{gatewayUrl || 'Unreachable'}</div>
        </div>
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-accent)' }}>
          <div className="flex items-center gap-2 text-gray-400 text-[10px] font-extrabold uppercase tracking-[0.14em]">
            <Cpu className="w-4 h-4 text-purple-300" /> Configured route
          </div>
          <div className="mt-2 font-mono text-sm text-[var(--color-text-primary)]">{configuredModel || 'fleet-free'}</div>
        </div>
        <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-success)' }}>
          <div className="flex items-center gap-2 text-gray-400 text-[10px] font-extrabold uppercase tracking-[0.14em]">
            <KeyRound className="w-4 h-4 text-green-300" /> Catalog
          </div>
          <div className="mt-2 font-mono text-sm text-[var(--color-text-primary)]">{models.length ? `${models.length} models` : '—'}</div>
        </div>
      </div>

      {error && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
          <span className="font-bold">Gateway note:</span>{' '}
          <span className="font-mono break-all">{error}</span>
        </div>
      )}

      {/* Per-task routing */}
      <div className="space-y-3">
        {TASKS.map((t) => {
          const options = optionsFor(t.id);
          const current = currentFor(t.id);
          const TaskIcon = t.icon;
          return (
            <div key={t.id} className="industrial-card p-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <span className="quick-icon shrink-0" style={{ ['--hover' as string]: t.accent }}>
                <TaskIcon className="w-[18px] h-[18px]" style={{ color: t.accent }} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-[var(--color-text-primary)]">{t.label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{t.desc}</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={current}
                  onChange={(e) => setRoute(t.id, e.target.value)}
                  className="min-w-0 max-w-[240px] rounded-lg border border-border-muted bg-surface-base px-2.5 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none focus:border-blue-500"
                >
                  {options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
                <button
                  onClick={() => cycleRoute(t.id)}
                  title="Cycle to next model"
                  className="inline-flex items-center gap-1 rounded-lg border border-border-muted px-2.5 py-2 text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-[var(--color-text-primary)]"
                >
                  <ChevronsRight className="w-3.5 h-3.5" /> Cycle
                </button>
              </div>
              <ArrowRight className="w-4 h-4 shrink-0 text-gray-400" />
              <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 font-mono text-xs text-emerald-300">
                {current}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
