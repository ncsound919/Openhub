import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, Send, Users, Zap } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
type Stage = (typeof STAGES)[number];

interface Deal { id: string; title: string; valueCents: number; currency: string; stage: Stage; probability: number; expectedClose: string | null }
interface Contact { id: string; name: string; email: string | null; title: string | null; source: string | null; status: string }
interface NextAction { id: string; kind: string; priority: number; title: string; detail: string; suggestion: string; subject: { type: string; id: string } }
interface Pipeline { byStage: Record<Stage, { count: number; valueCents: number }>; openCount: number; openValueCents: number; wonValueCents: number; weightedForecastCents: number; currency: string }

const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const authJson = () => ({ ...getAuthHeaders(), 'Content-Type': 'application/json' });

export function CrmView() {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [actions, setActions] = useState<NextAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatch, setDispatch] = useState<Record<string, { state: 'sending' | 'ok' | 'error'; message: string }>>({});
  const [nc, setNc] = useState({ name: '', email: '', source: '' });
  const [nd, setNd] = useState({ title: '', value: '', stage: 'lead' as Stage });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const get = async (u: string) => {
        const r = await fetch(u, { credentials: 'include', headers: getAuthHeaders() });
        if (!r.ok) throw new Error(`${u} HTTP ${r.status}`);
        return r.json();
      };
      const [p, d, c, a] = await Promise.all([
        get('/api/crm/pipeline'), get('/api/crm/deals'), get('/api/crm/contacts'), get('/api/crm/actions'),
      ]);
      setPipeline(p); setDeals(d.deals ?? []); setContacts(c.contacts ?? []); setActions(a.actions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load CRM');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addContact = async () => {
    if (!nc.name.trim()) return;
    await fetch('/api/crm/contacts', { method: 'POST', credentials: 'include', headers: authJson(), body: JSON.stringify({ name: nc.name, email: nc.email || undefined, source: nc.source || undefined }) });
    setNc({ name: '', email: '', source: '' });
    void load();
  };

  const addDeal = async () => {
    if (!nd.title.trim()) return;
    await fetch('/api/crm/deals', { method: 'POST', credentials: 'include', headers: authJson(), body: JSON.stringify({ title: nd.title, stage: nd.stage, valueCents: Math.round(Number(nd.value || 0) * 100) }) });
    setNd({ title: '', value: '', stage: 'lead' });
    void load();
  };

  const runAction = async (action: NextAction) => {
    setDispatch((s) => ({ ...s, [action.id]: { state: 'sending', message: 'dispatching…' } }));
    try {
      const r = await fetch('/api/crm/actions/dispatch', { method: 'POST', credentials: 'include', headers: authJson(), body: JSON.stringify({ action }) });
      const data = await r.json();
      if (!r.ok || !data.available) {
        setDispatch((s) => ({ ...s, [action.id]: { state: 'error', message: data.error || `HTTP ${r.status}` } }));
        return;
      }
      const out = data.data?.final_output ?? data.data?.reasoning?.chosen_skill ?? 'dispatched';
      setDispatch((s) => ({ ...s, [action.id]: { state: 'ok', message: typeof out === 'string' ? out.slice(0, 160) : JSON.stringify(out).slice(0, 160) } }));
    } catch (err) {
      setDispatch((s) => ({ ...s, [action.id]: { state: 'error', message: err instanceof Error ? err.message : 'dispatch failed' } }));
    }
  };

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none"><Users className="w-56 h-56 text-blue-300" strokeWidth={1} /></div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300"><Zap className="w-3.5 h-3.5" /> Business development</div>
        <h1 className="mt-2">CRM <span className="text-info">spine.</span></h1>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">Deterministic pipeline, forecast and next-best-actions. Dispatches run on the fleet's deterministic brain — no LLM decides money.</p>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50 disabled:opacity-50">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /> Refresh
          </button>
          {pipeline && <span className="font-mono text-[11px] text-gray-400">{pipeline.openCount} open · {usd(pipeline.openValueCents)} open · {usd(pipeline.weightedForecastCents)} weighted forecast</span>}
        </div>
      </section>

      {error && <div className="border border-amber-500/40 bg-amber-500/10 p-4 text-amber-300 text-sm flex gap-3"><AlertTriangle className="w-5 h-5 shrink-0" /><div><div className="font-bold">CRM unavailable</div><div className="font-mono text-xs mt-1">{error}</div></div></div>}

      {/* Actions */}
      <section className="industrial-card p-5">
        <h2 className="!text-base flex items-center gap-2"><Zap className="w-4 h-4 text-emerald-300" /> Next best actions</h2>
        {actions.length ? (
          <div className="mt-3 space-y-2">
            {actions.slice(0, 12).map((a) => {
              const d = dispatch[a.id];
              return (
                <div key={a.id} className="rounded-lg border border-border-muted bg-surface-base px-3 py-2.5 flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 rounded-full border border-border-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">{a.kind.replace('_', ' ')}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text-primary)]">{a.title}</div>
                    <div className="text-[11px] text-gray-400">{a.detail}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">{a.suggestion}</div>
                    {d && <div className={cn('mt-1 font-mono text-[10px]', d.state === 'ok' ? 'text-[var(--color-success)]' : d.state === 'error' ? 'text-amber-300' : 'text-gray-400')}>{d.message}</div>}
                  </div>
                  <button onClick={() => void runAction(a)} disabled={d?.state === 'sending'} className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2.5 py-1 text-[11px] font-bold">
                    {d?.state === 'sending' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Dispatch
                  </button>
                </div>
              );
            })}
          </div>
        ) : <div className="mt-3 text-sm text-gray-400">{loading ? 'Computing…' : 'No actions — pipeline is clean.'}</div>}
      </section>

      {/* Pipeline */}
      <section className="industrial-card p-5">
        <h2 className="!text-base">Pipeline</h2>
        {pipeline && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {STAGES.map((s) => (
              <div key={s} className="rounded-lg border border-border-muted bg-surface-base px-3 py-2">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s}</div>
                <div className="mt-0.5 text-sm font-bold text-[var(--color-text-primary)]">{pipeline.byStage[s].count}</div>
                <div className="text-[11px] font-mono text-gray-400">{usd(pipeline.byStage[s].valueCents)}</div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <input value={nd.title} onChange={(e) => setNd({ ...nd, title: e.target.value })} placeholder="New deal title" className="rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px] text-[var(--color-text-primary)] min-w-[200px]" />
          <input value={nd.value} onChange={(e) => setNd({ ...nd, value: e.target.value })} placeholder="value $" className="w-28 rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px]" />
          <select value={nd.stage} onChange={(e) => setNd({ ...nd, stage: e.target.value as Stage })} className="rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px]">
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={() => void addDeal()} className="inline-flex items-center gap-1.5 rounded-md border border-border-muted px-3 py-1.5 text-[12px] font-bold text-gray-400 hover:border-blue-500/50"><Plus className="w-3.5 h-3.5" /> Add deal</button>
        </div>
        {deals.length > 0 && (
          <div className="mt-3 divide-y divide-border-muted rounded-lg border border-border-muted overflow-hidden">
            {deals.slice(0, 15).map((d) => (
              <div key={d.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-sm font-semibold text-[var(--color-text-primary)] truncate">{d.title}</span>
                <span className="ml-auto shrink-0 rounded-full border border-border-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">{d.stage}</span>
                <span className="shrink-0 font-mono text-[11px] text-gray-400">{usd(d.valueCents)} · {d.probability}%</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Contacts */}
      <section className="industrial-card p-5">
        <h2 className="!text-base flex items-center gap-2"><Users className="w-4 h-4 text-blue-300" /> Contacts</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} placeholder="Name" className="rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px] min-w-[160px]" />
          <input value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} placeholder="Email" className="rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px] min-w-[200px]" />
          <input value={nc.source} onChange={(e) => setNc({ ...nc, source: e.target.value })} placeholder="Source (site, referral…)" className="rounded-md border border-border-muted bg-surface-base px-2.5 py-1.5 text-[12px] min-w-[180px]" />
          <button onClick={() => void addContact()} className="inline-flex items-center gap-1.5 rounded-md border border-border-muted px-3 py-1.5 text-[12px] font-bold text-gray-400 hover:border-blue-500/50"><Plus className="w-3.5 h-3.5" /> Add contact</button>
        </div>
        {contacts.length ? (
          <div className="mt-3 divide-y divide-border-muted rounded-lg border border-border-muted overflow-hidden">
            {contacts.slice(0, 20).map((c) => (
              <div key={c.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">{c.name}</span>
                <span className="text-[11px] font-mono text-gray-400 truncate">{c.email || '—'}</span>
                {c.source && <span className="text-[10px] text-gray-500">{c.source}</span>}
                <span className="ml-auto shrink-0 text-[10px] font-bold uppercase tracking-wide text-gray-400">{c.status}</span>
              </div>
            ))}
          </div>
        ) : <div className="mt-3 text-sm text-gray-400 flex items-center gap-2">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} {loading ? 'Loading…' : 'No contacts yet.'}</div>}
      </section>
    </div>
  );
}
