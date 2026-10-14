import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Layers, Cpu, FileWarning, CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

type Tier = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

interface TierInfo {
  tier: Tier;
  label: string;
  description: string;
  color: string;
  bg: string;
  border: string;
}

const TIER_INFO: Record<Tier, TierInfo> = {
  A0: { tier: 'A0', label: 'Tested', description: 'Property tests, differential vs spec, mutation score', color: 'text-gray-300', bg: 'bg-gray-500/10', border: 'border-gray-500/30' },
  A1: { tier: 'A1', label: 'Solver-verified', description: 'Verus, Dafny, Kani, Creusot — trusts solver + front end', color: 'text-blue-300', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  A2: { tier: 'A2', label: 'Certificate-checked', description: 'cvc5 proofs (Alethe) + Carcara; BMC witnesses', color: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
  A3: { tier: 'A3', label: 'Kernel-checked', description: 'Lean 4, Rocq, Aeneas to Lean, lean-smt', color: 'text-violet-300', bg: 'bg-violet-500/10', border: 'border-violet-500/30' },
  A4: { tier: 'A4', label: 'Foundational', description: 'A3 + diverse kernels + foundational semantics + translation-validated object code', color: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
};

interface ObligationTier {
  class: string;
  achieved: Tier;
  requested: Tier;
  status: 'met' | 'below' | 'waived';
}

interface Checker {
  id: string;
  lineage: string;
  qualified: boolean;
  corpusPass: boolean;
  damagedProofPass: boolean;
  differentialPass: boolean;
}

interface ModelGap {
  id: string;
  what: string;
  discharge: string;
  status: 'discharged' | 'pending' | 'failed';
}

interface TiersData {
  templates: Array<{
    id: string;
    name: string;
    version: string;
    overallTier: Tier;
    requestedTier: Tier;
    obligations: ObligationTier[];
    checkers: Checker[];
    tcb: string[];
    modelGaps: ModelGap[];
    targets: string[];
    lockHash: string;
    signatureValid: boolean;
  }>;
  summary: {
    total: number;
    byTier: Record<Tier, number>;
    checkersQualified: number;
    checkersTotal: number;
    modelGapsDischarged: number;
    modelGapsTotal: number;
  };
}

const EMPTY_DATA: TiersData = {
  templates: [],
  summary: { total: 0, byTier: { A0: 0, A1: 0, A2: 0, A3: 0, A4: 0 }, checkersQualified: 0, checkersTotal: 0, modelGapsDischarged: 0, modelGapsTotal: 0 },
};

function TierBadge({ tier, size = 'md' }: { tier: Tier; size?: 'sm' | 'md' | 'lg' }) {
  const info = TIER_INFO[tier];
  const sizeClass = size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2 py-1 text-xs';
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full font-bold', info.bg, info.color, info.border, 'border', sizeClass)}>
      {tier}
    </span>
  );
}

function StatusIcon({ status }: { status: 'met' | 'below' | 'waived' | 'discharged' | 'pending' | 'failed' }) {
  if (status === 'met' || status === 'discharged') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
  if (status === 'below' || status === 'failed') return <XCircle className="w-3.5 h-3.5 text-red-400" />;
  return <MinusCircle className="w-3.5 h-3.5 text-gray-500" />;
}

export function TiersView() {
  const [data, setData] = useState<TiersData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/assurance/tiers', { headers: getAuthHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setData(json.data || EMPTY_DATA);
      } catch (e: any) {
        setError(e.message || 'Failed to load tiers');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Layers className="w-5 h-5 animate-pulse mr-2" />
        Loading assurance tiers…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20 text-red-400">
        <ShieldAlert className="w-5 h-5 mr-2" />
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Tier legend */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {(Object.keys(TIER_INFO) as Tier[]).map((tier) => {
          const info = TIER_INFO[tier];
          const count = data.summary.byTier[tier];
          return (
            <div key={tier} className={cn('rounded-xl border p-3', info.bg, info.border)}>
              <div className="flex items-center justify-between">
                <TierBadge tier={tier} size="lg" />
                <span className={cn('text-2xl font-black', info.color)}>{count}</span>
              </div>
              <div className={cn('mt-1 text-xs font-bold', info.color)}>{info.label}</div>
              <div className="mt-0.5 text-[10px] text-gray-500 leading-tight">{info.description}</div>
            </div>
          );
        })}
      </section>

      {/* Summary stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-surface-overlay bg-surface-overlay/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Templates</div>
          <div className="mt-1 text-2xl font-black text-gray-200">{data.summary.total}</div>
        </div>
        <div className="rounded-xl border border-surface-overlay bg-surface-overlay/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Checkers Qualified</div>
          <div className="mt-1 text-2xl font-black text-emerald-300">
            {data.summary.checkersQualified}<span className="text-sm text-gray-500">/{data.summary.checkersTotal}</span>
          </div>
        </div>
        <div className="rounded-xl border border-surface-overlay bg-surface-overlay/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Model Gaps Discharged</div>
          <div className="mt-1 text-2xl font-black text-violet-300">
            {data.summary.modelGapsDischarged}<span className="text-sm text-gray-500">/{data.summary.modelGapsTotal}</span>
          </div>
        </div>
        <div className="rounded-xl border border-surface-overlay bg-surface-overlay/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">Avg Tier</div>
          <div className="mt-1 text-2xl font-black text-amber-300">
            {data.templates.length > 0
              ? (Object.keys(TIER_INFO) as Tier[]).reduce((best, t) => {
                  const rank = (x: Tier) => ['A0','A1','A2','A3','A4'].indexOf(x);
                  return rank(t) > rank(best) ? t : best;
                }, 'A0' as Tier)
              : '—'}
          </div>
        </div>
      </section>

      {/* Template list */}
      <section className="flex flex-col gap-3">
        {data.templates.length === 0 ? (
          <div className="rounded-xl border border-surface-overlay bg-surface-overlay/30 p-8 text-center text-gray-500">
            <ShieldQuestion className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <div className="text-sm">No v5 templates registered yet.</div>
            <div className="text-xs mt-1">Build a component from the <code className="text-violet-300">tpl_v5_manifest</code> template to see it here.</div>
          </div>
        ) : (
          data.templates.map((tpl) => {
            const isExpanded = expanded === tpl.id;
            return (
              <div key={tpl.id} className="rounded-xl border border-surface-overlay bg-surface-overlay/30 overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 p-4 text-left hover:bg-surface-overlay/50 transition-colors"
                  onClick={() => setExpanded(isExpanded ? null : tpl.id)}
                >
                  <TierBadge tier={tpl.overallTier} size="lg" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-200 truncate">{tpl.name}</span>
                      <span className="text-xs text-gray-500">v{tpl.version}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {tpl.obligations.filter((o) => o.status === 'met').length}/{tpl.obligations.length} obligations met
                      {' · '}{tpl.checkers.length} checkers
                      {' · '}{tpl.modelGaps.filter((g) => g.status === 'discharged').length}/{tpl.modelGaps.length} gaps discharged
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {tpl.signatureValid ? (
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-400" />
                    )}
                    <span className="text-xs text-gray-500 font-mono">{tpl.lockHash.substring(0, 8)}…</span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-surface-overlay p-4 flex flex-col gap-4">
                    {/* Obligations */}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Obligation Tiers</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {tpl.obligations.map((ob) => (
                          <div key={ob.class} className="flex items-center gap-2 rounded-lg bg-surface-overlay/50 px-3 py-2">
                            <StatusIcon status={ob.status} />
                            <span className="text-xs text-gray-400 flex-1">{ob.class}</span>
                            <TierBadge tier={ob.achieved} size="sm" />
                            <span className="text-[10px] text-gray-600">/ {ob.requested}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Checkers */}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Qualified Checkers</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {tpl.checkers.map((ch) => (
                          <div key={ch.id} className="flex items-center gap-2 rounded-lg bg-surface-overlay/50 px-3 py-2">
                            <Cpu className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-xs text-gray-300 flex-1 font-mono">{ch.id}</span>
                            <span className="text-[10px] text-gray-500">{ch.lineage}</span>
                            {ch.qualified ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-red-400" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* TCB */}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Trusted Base</div>
                      <div className="flex flex-wrap gap-1.5">
                        {tpl.tcb.map((item) => (
                          <span key={item} className="rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-[10px] text-violet-300 font-mono">
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Model Gaps */}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Model Gaps</div>
                      <div className="flex flex-col gap-1.5">
                        {tpl.modelGaps.map((gap) => (
                          <div key={gap.id} className="flex items-start gap-2 rounded-lg bg-surface-overlay/50 px-3 py-2">
                            <StatusIcon status={gap.status} />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-gray-300">{gap.what}</div>
                              <div className="text-[10px] text-gray-500 mt-0.5">{gap.discharge}</div>
                            </div>
                            <span className="text-[10px] font-mono text-gray-500">{gap.id}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Targets */}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-2">Verified Targets</div>
                      <div className="flex flex-wrap gap-1.5">
                        {tpl.targets.map((t) => (
                          <span key={t} className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] text-emerald-300 font-mono">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
