import { useCallback, useEffect, useState } from 'react';
import { Archive, BookOpen, Dices, Fingerprint, Gauge, Newspaper, PenLine, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { MarkdownProse } from '../components/MarkdownProse';

interface ReporterCounts {
  registryTotal: number;
  provenanceTotal: number;
  jobsEnabled: number;
  jobsTotal: number;
  connectionsUp: number;
  connectionsTotal: number;
  promotions: number;
  repairs: number;
  mathSolved: number;
  mathTotal: number;
  biotechPassed: number;
  biotechTotal: number;
  learnerEpisodes: number;
  crystallizedGenes: number;
}

interface ReporterArticle {
  fingerprint: string;
  id: string;
  title: string;
  headline: string;
  dek: string;
  voice: { id: string; name: string; tone: string; verbosity: string };
  format: string;
  metaphor: {
    condition: string;
    archetype: string;
    source: string;
    businessLogic: string;
    application: string;
    lesson: string;
    dimensions: Array<{ id: string; title: string; logic: string; metric: string }>;
  };
  codex: {
    scores: Record<string, number>;
    gates: Record<string, boolean>;
    verdict: string;
    summary: string;
    sensitivity: Array<{ metric: string; driver: string; delta: number }>;
  };
  monteCarlo: {
    codex: {
      trials: number;
      goProbability: number;
      agreement: number;
      baseVerdict: string;
      binding: string;
      metrics: Record<string, { mean: number; p10: number; p50: number; p90: number; passProbability: number }>;
      leverImpact: Array<{ driver: string; goDelta: number }>;
    };
    protocol: {
      trials: number;
      baseCondition: string;
      stability: number;
      probabilities: Array<{ condition: string; p: number }>;
    };
  };
  prose: {
    score: number;
    band: string;
    findings: Array<{ id: string; label: string; count: number; severity: string }>;
    metrics: { words: number; sentences: number; sentenceCv: number; repeatedSpanShare: number };
    advice: string[];
  };
  proseChanges: string[];
  markdown: string;
  counts: ReporterCounts;
  generatedAt: number;
  wordCount: number;
  narration?: { prose: string; model?: string; nonCanonical: true } | null;
}

interface ReporterIndexEntry {
  fingerprint: string;
  id: string;
  headline: string;
  generatedAt: number;
  wordCount: number;
  hasNarration: boolean;
}

interface VoiceInfo { id: string; name: string; tone: string; verbosity: string }
interface FormatInfo { id: string; name: string; description: string }

interface RecourseEnvelope<T> {
  available: boolean;
  error?: string;
  data?: T;
}

function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : 'never';
}

export function ReporterView() {
  const [article, setArticle] = useState<ReporterArticle | null>(null);
  const [index, setIndex] = useState<ReporterIndexEntry[]>([]);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [voice, setVoice] = useState('field');
  const [format, setFormat] = useState('dispatch');
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'write' | 'narrate' | 'preview' | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState('');

  const headers = useCallback(
    () => ({ ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken(), 'Content-Type': 'application/json' }),
    [],
  );

  const load = useCallback(async (fingerprint?: string) => {
    setLoading(true);
    try {
      const [latestRes, listRes, voicesRes] = await Promise.all([
        fetch(fingerprint ? `/api/recourse/reporter/article/${fingerprint}` : '/api/recourse/reporter/latest', {
          credentials: 'include',
          headers: getAuthHeaders(),
        }).then((r) => r.json()),
        fetch('/api/recourse/reporter/articles?limit=25', { credentials: 'include', headers: getAuthHeaders() }).then((r) => r.json()),
        fetch('/api/recourse/reporter/voices', { credentials: 'include', headers: getAuthHeaders() }).then((r) => r.json()),
      ]);
      const latest = latestRes as RecourseEnvelope<{ article: ReporterArticle }>;
      const list = listRes as RecourseEnvelope<{ articles: ReporterIndexEntry[] }>;
      const v = voicesRes as RecourseEnvelope<{ voices: VoiceInfo[]; formats: FormatInfo[] }>;
      setOffline(!latest.available && !list.available);
      setArticle(latest.data?.article ?? null);
      setPreviewing(false);
      setIndex(list.data?.articles ?? []);
      if (v.available && v.data) {
        setVoices(v.data.voices ?? []);
        setFormats(v.data.formats ?? []);
      }
    } catch (err: any) {
      setOffline(true);
      setMessage(`Reporter unreachable: ${err?.message ?? err}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const preview = async () => {
    setBusy('preview');
    setMessage('');
    try {
      const q = new URLSearchParams({ voice, format }).toString();
      const res = await fetch(`/api/recourse/reporter/preview?${q}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = (await res.json()) as RecourseEnvelope<{ article: ReporterArticle }>;
      if (json.available && json.data) {
        setArticle(json.data.article);
        setPreviewing(true);
      } else {
        setMessage(`Preview unavailable: ${json.error ?? 'offline'}`);
      }
    } catch (err: any) {
      setMessage(`Preview failed: ${err?.message ?? err}`);
    }
    setBusy(null);
  };

  const writeNow = async () => {
    setBusy('write');
    setMessage('');
    try {
      const res = await fetch('/api/recourse/reporter/generate', {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({ force: true, voice, format }),
      });
      const json = (await res.json()) as RecourseEnvelope<{ written: boolean; reason?: string; article: ReporterArticle }>;
      if (json.available && json.data) {
        setMessage(json.data.written ? `Wrote dispatch ${json.data.article.id}.` : `No new dispatch: ${json.data.reason ?? 'unchanged'}.`);
        await load();
      } else {
        setMessage(`Write unavailable: ${json.error ?? 'guarded write refused (RECOURSE_API_SECRET unset?)'}`);
      }
    } catch (err: any) {
      setMessage(`Write failed: ${err?.message ?? err}`);
    }
    setBusy(null);
  };

  const narrate = async () => {
    if (!article || previewing) return;
    setBusy('narrate');
    setMessage('');
    try {
      const res = await fetch('/api/recourse/reporter/narrate', {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({ fingerprint: article.fingerprint }),
      });
      const json = (await res.json()) as RecourseEnvelope<{ article: ReporterArticle }>;
      if (json.available && json.data) {
        setArticle(json.data.article);
        setMessage('Attached a non-canonical narration.');
      } else {
        setMessage(`Narration unavailable: ${json.error ?? 'model offline'}`);
      }
    } catch (err: any) {
      setMessage(`Narration failed: ${err?.message ?? err}`);
    }
    setBusy(null);
  };

  const counts = article?.counts;
  const tiles = counts
    ? [
        { label: 'Jobs on', value: `${counts.jobsEnabled}/${counts.jobsTotal}`, accent: 'var(--color-success)' },
        { label: 'Capabilities', value: String(counts.registryTotal), accent: 'var(--color-info)' },
        { label: 'Connections', value: `${counts.connectionsUp}/${counts.connectionsTotal}`, accent: 'var(--color-accent)' },
        { label: 'Self-repairs', value: String(counts.repairs), accent: 'var(--color-warning)' },
      ]
    : [];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <Newspaper className="w-56 h-56 text-cyan-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-cyan-300">
          <span className={`w-1.5 h-1.5 rounded-full ${offline ? 'bg-surface-overlay' : 'bg-cyan-400 animate-pulse'}`} />
          Recourse · self reporter
        </div>
        <h2 className="mt-2">A system that <span className="text-info">reports on itself.</span></h2>
        <p className="mt-1.5 max-w-2xl text-sm text-gray-400">
          Recourse writes plain-language dispatches about its own systems, development, connections, growth and data;
          reads the moment as a comic protocol; and scores itself against a five-dimension quality codex. The article is
          deterministic — the same state always produces the same words — with selectable voices and formats.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            className="rounded-lg border border-border-muted bg-surface-base/70 px-3 py-2 text-sm font-bold text-gray-300"
          >
            {(voices.length ? voices : [{ id: 'field', name: 'Field Dispatch', tone: '', verbosity: '' }]).map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="rounded-lg border border-border-muted bg-surface-base/70 px-3 py-2 text-sm font-bold text-gray-300"
          >
            {(formats.length ? formats : [{ id: 'dispatch', name: 'Field Dispatch', description: '' }]).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={preview}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-300 hover:border-blue-500/50 disabled:opacity-40"
          >
            <Gauge className={`w-4 h-4 ${busy === 'preview' ? 'animate-spin' : ''}`} /> Preview
          </button>
          <button
            onClick={writeNow}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
          >
            <PenLine className={`w-4 h-4 ${busy === 'write' ? 'animate-pulse' : ''}`} /> Write dispatch now
          </button>
          <button
            onClick={narrate}
            disabled={busy !== null || !article || previewing}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-300 hover:border-amber-500/50 disabled:opacity-40"
          >
            <Sparkles className={`w-4 h-4 ${busy === 'narrate' ? 'animate-spin' : ''}`} /> Model narration
          </button>
        </div>
        {message && <div className="mt-3 font-mono text-[11px] text-gray-400">{message}</div>}
      </section>

      {offline && !article && (
        <section className="industrial-card p-6">
          <div className="font-mono text-sm text-gray-400">
            Recourse is offline or has not written a dispatch yet. Start Recourse and generate one, or wait for the
            two-hour cadence.
          </div>
        </section>
      )}

      {tiles.length > 0 && (
        <section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {tiles.map((s) => (
            <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent }}>
              <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
              <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            </div>
          ))}
        </section>
      )}

      <section className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2 industrial-card p-5">
          {article ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-border-muted">
                <div className="flex items-center gap-2 font-mono text-[11px] text-gray-400">
                  <Fingerprint className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{article.id}</span>
                  <span>·</span>
                  <span>{fmtTime(article.generatedAt)}</span>
                  <span>·</span>
                  <span>{article.wordCount} words</span>
                  <span>·</span>
                  <span className="text-cyan-300">{article.voice.name} / {article.format}</span>
                </div>
                <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5" /> {previewing ? 'preview' : 'deterministic'}
                </span>
              </div>
              <MarkdownProse text={article.markdown} className="mt-5" />
              {article.narration?.prose && (
                <div className="mt-5 border-t border-border-muted pt-4">
                  <div className="flex items-center gap-2 text-[11px] font-mono text-amber-300">
                    <Sparkles className="w-3.5 h-3.5" />
                    NON-CANONICAL NARRATION{article.narration.model ? ` (${article.narration.model})` : ''} — does not change the article or its fingerprint
                  </div>
                  <div className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-gray-300">{article.narration.prose}</div>
                </div>
              )}
            </>
          ) : (
            <div className="font-mono text-xs text-gray-400">{loading ? 'Loading dispatch…' : 'No dispatch to show.'}</div>
          )}
        </div>

        <div className="space-y-3">
          {article && (
            <div className="industrial-card p-5">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-purple-400" />
                <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Chapter · {article.metaphor.condition}</h3>
              </div>
              <div className="mt-2 font-mono text-sm font-bold text-purple-200">{article.metaphor.archetype}</div>
              <div className="text-[10px] font-mono text-gray-500">{article.metaphor.source}</div>
              <div className="mt-2 text-[11px] text-gray-300 leading-relaxed">{article.metaphor.businessLogic}</div>
              <ul className="mt-2 space-y-1">
                {article.metaphor.dimensions.map((d) => (
                  <li key={d.id} className="text-[10px] font-mono text-gray-400">
                    <span className="text-gray-200">{d.id} {d.title}</span> — {d.logic}
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-[11px] text-amber-300">Lesson: {article.metaphor.lesson}</div>
            </div>
          )}

          {article && (
            <div className="industrial-card p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Gauge className="w-4 h-4 text-gray-400" />
                  <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Quality codex</h3>
                </div>
                <span className={`font-mono text-[11px] font-bold ${article.codex.verdict === 'GO' ? 'text-emerald-400' : 'text-amber-400'}`}>{article.codex.verdict}</span>
              </div>
              <div className="mt-3 space-y-1.5">
                {Object.entries(article.codex.scores).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 font-mono text-[10px] capitalize text-gray-400">{k}</span>
                    <div className="h-2 flex-1 rounded-full bg-surface-overlay">
                      <div className="h-2 rounded-full" style={{ width: `${Math.round(Number(v) * 100)}%`, background: article.codex.gates[k] ? 'var(--color-success)' : 'var(--color-warning)' }} />
                    </div>
                    <span className="w-9 shrink-0 text-right font-mono text-[10px] text-gray-400">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {article && (
            <div className="industrial-card p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Dices className="w-4 h-4 text-cyan-400" />
                  <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Monte Carlo</h3>
                </div>
                <span className="font-mono text-[10px] text-gray-500">{article.monteCarlo.codex.trials} seeded trials</span>
              </div>

              <div className="mt-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">Odds of GO</span>
                  <span className={`font-mono text-lg font-extrabold ${article.monteCarlo.codex.goProbability >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {Math.round(article.monteCarlo.codex.goProbability * 100)}%
                  </span>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-surface-overlay">
                  <div className="h-2 rounded-full" style={{ width: `${Math.round(article.monteCarlo.codex.goProbability * 100)}%`, background: article.monteCarlo.codex.goProbability >= 0.5 ? 'var(--color-success)' : 'var(--color-warning)' }} />
                </div>
                <div className="mt-1 font-mono text-[10px] text-gray-500">
                  base {article.monteCarlo.codex.baseVerdict} · agreement {Math.round(article.monteCarlo.codex.agreement * 100)}% · binding {article.monteCarlo.codex.binding}
                </div>
              </div>

              <div className="mt-3 space-y-1.5">
                {Object.entries(article.monteCarlo.codex.metrics).map(([k, m]) => {
                  const left = Math.round(m.p10 * 100);
                  const width = Math.max(2, Math.round((m.p90 - m.p10) * 100));
                  return (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 font-mono text-[10px] capitalize text-gray-400">{k}</span>
                      <div className="relative h-2 flex-1 rounded-full bg-surface-overlay">
                        <div className="absolute h-2 rounded-full bg-cyan-500/40" style={{ left: `${left}%`, width: `${width}%` }} />
                        <div className="absolute top-[-2px] h-3 w-0.5 bg-cyan-300" style={{ left: `${Math.round(m.p50 * 100)}%` }} />
                      </div>
                      <span className="w-10 shrink-0 text-right font-mono text-[10px] text-gray-400">{Math.round(m.passProbability * 100)}%</span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 border-t border-border-muted pt-2">
                {article.monteCarlo.codex.leverImpact[0] && article.monteCarlo.codex.leverImpact[0].goDelta <= 0 ? (
                  <div className="font-mono text-[10px] text-gray-500">No single lever (+0.10) flips the verdict; the constraint is structural.</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {article.monteCarlo.codex.leverImpact.map((l) => (
                      <span key={l.driver} className="rounded-full border border-border-muted bg-surface-overlay px-2 py-0.5 font-mono text-[10px] text-gray-300">
                        {l.driver} {l.goDelta >= 0 ? '+' : ''}{Math.round(l.goDelta * 100)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-gray-500">arc holds {Math.round(article.monteCarlo.protocol.stability * 100)}%</span>
                  <div className="h-1.5 flex-1 rounded-full bg-surface-overlay">
                    <div className="h-1.5 rounded-full bg-purple-400/70" style={{ width: `${Math.round(article.monteCarlo.protocol.stability * 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {article && (
            <div className="industrial-card p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <PenLine className="w-4 h-4 text-gray-400" />
                  <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Prose audit</h3>
                </div>
                <span className={`font-mono text-[11px] font-bold ${article.prose.score < 15 ? 'text-emerald-400' : article.prose.score < 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                  {article.prose.score}/100 · {article.prose.band}
                </span>
              </div>
              <div className="mt-2 h-2 w-full rounded-full bg-surface-overlay">
                <div className="h-2 rounded-full" style={{ width: `${article.prose.score}%`, background: article.prose.score < 15 ? 'var(--color-success)' : article.prose.score < 40 ? 'var(--color-warning)' : '#fb7185' }} />
              </div>
              <div className="mt-2 space-y-1">
                {article.prose.findings.length === 0 ? (
                  <div className="font-mono text-[10px] text-gray-500">No anti-slop tells detected in the body.</div>
                ) : (
                  article.prose.findings.slice(0, 5).map((f) => (
                    <div key={f.id} className="font-mono text-[10px] text-gray-400">
                      <span className="text-gray-300">{f.label}</span> ×{f.count} <span className="text-gray-600">· {f.severity}</span>
                    </div>
                  ))
                )}
              </div>
              {article.proseChanges.length > 0 && (
                <div className="mt-2 border-t border-border-muted pt-2 font-mono text-[10px] text-gray-500">
                  cleanup: {article.proseChanges.join('; ')}
                </div>
              )}
            </div>
          )}

          <div className="industrial-card p-5">
            <div className="flex items-center gap-2">
              <Archive className="w-4 h-4 text-gray-400" />
              <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Archive</h3>
            </div>
            <div className="mt-3 space-y-2 max-h-[420px] overflow-y-auto">
              {index.length === 0 && <div className="font-mono text-xs text-gray-400">No dispatches archived.</div>}
              {index.map((entry) => (
                <button
                  key={entry.fingerprint}
                  onClick={() => void load(entry.fingerprint)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-all ${
                    article?.fingerprint === entry.fingerprint ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-border-muted hover:border-blue-500/40'
                  }`}
                >
                  <div className="text-[11px] text-gray-200">{entry.headline}</div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-gray-400">
                    <span>{entry.id}</span>
                    <span>·</span>
                    <span>{fmtTime(entry.generatedAt)}</span>
                    {entry.hasNarration && <span className="text-amber-400">· narrated</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
