import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Smartphone,
  RefreshCw,
  Download,
  Clipboard,
  ShieldAlert,
  WifiOff,
  CheckCircle2,
  FileText,
  ListChecks,
} from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

interface DeskProfile {
  id: number;
  app_name: string;
  file_name: string;
  kind: string;
  version_label: string;
  score: number | null;
  findings_count: number;
  scanned_at: string;
  score_version?: string;
}

interface DeskFinding {
  rule: string;
  severity: string;
  title?: string;
  file?: string;
  line?: number;
  message?: string;
  tier?: string;
  sources?: string[];
}

interface AgentTask {
  id: string;
  priority: string;
  rule: string;
  severity: string;
  file: string;
  line: number;
  fix: string;
  acceptance: string[];
  parallel_safe: boolean;
}

interface DeskReport {
  profile: DeskProfile;
  findings: DeskFinding[];
  report?: { integrations?: Array<{ name: string; status: string; reason?: string; version?: string }> };
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const SEV_STYLE: Record<string, string> = {
  CRITICAL: 'text-red-300 border-red-500/40 bg-red-500/10',
  HIGH: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  MEDIUM: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  LOW: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  INFO: 'text-gray-300 border-gray-500/40 bg-gray-500/10',
};

async function deskJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { credentials: 'include', headers: getAuthHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function AndroidAuditDeskView() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [deskUrl, setDeskUrl] = useState('');
  const [profiles, setProfiles] = useState<DeskProfile[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [report, setReport] = useState<DeskReport | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const health = await deskJson<{ ok?: boolean; desk?: string; reason?: string }>('/api/android-audit/health');
    setOnline(Boolean(health?.ok));
    setDeskUrl(health?.desk ?? '');
    if (!health?.ok) {
      setProfiles([]);
      setReport(null);
      setMessage(health?.reason ?? 'Audit desk is not running on this device.');
      setBusy(false);
      return;
    }
    const list = await deskJson<{ profiles?: DeskProfile[] }>('/api/android-audit/profiles');
    const next = list?.profiles ?? [];
    setProfiles(next);
    setSelected((current) => current ?? next[0]?.id ?? null);
    setBusy(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    (async () => {
      const [detail, bundle] = await Promise.all([
        deskJson<DeskReport>(`/api/android-audit/report?id=${selected}`),
        deskJson<{ tasks?: AgentTask[] }>(`/api/android-audit/report?id=${selected}&format=agent-json`),
      ]);
      if (cancelled) return;
      setReport(detail);
      setTasks((bundle?.tasks ?? []).filter((t) => t.priority === 'P0' || t.priority === 'P1').slice(0, 8));
    })();
    return () => { cancelled = true; };
  }, [selected]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of report?.findings ?? []) {
      const sev = String(f.severity || 'INFO').toUpperCase();
      out[sev] = (out[sev] ?? 0) + 1;
    }
    return out;
  }, [report]);

  const download = async (format: 'agent-md' | 'sarif' | 'json') => {
    if (!selected) return;
    try {
      const res = await fetch(`/api/android-audit/report?id=${selected}&format=${format}`, {
        credentials: 'include', headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = format === 'agent-md' ? `AGENT-FIX-${selected}.md` : `android-audit-${selected}.${format}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'download failed');
    }
  };

  const copyTasks = async () => {
    if (!selected) return;
    try {
      const res = await fetch(`/api/android-audit/report?id=${selected}&format=agent-json`, {
        credentials: 'include', headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await navigator.clipboard.writeText(await res.text());
      setMessage('Agent task JSON copied.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'copy failed');
    }
  };

  return (
    <div className="space-y-4">
      <section className="glass rounded-xl px-4 py-3 flex flex-wrap items-center gap-3" aria-label="Android audit desk status">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-blue-300" />
          <h2 className="!text-base">Android Desk</h2>
        </div>
        <span className={cn(
          'count-pill shrink-0',
          online === true && 'text-emerald-300 border-emerald-500/40',
          online === false && 'text-red-300 border-red-500/40',
        )}>
          {online === null ? 'checking' : online ? 'online' : 'offline'}
        </span>
        {deskUrl && <code className="text-[11px] text-gray-500">{deskUrl}</code>}
        <div className="spacer" />
        <button className="btn ghost tiny min-h-11" onClick={() => void load()} disabled={busy}>
          <RefreshCw className={cn('w-4 h-4', busy && 'animate-spin')} /> Refresh
        </button>
      </section>

      {online === false && (
        <section className="industrial-card p-4 space-y-2" aria-label="Desk offline">
          <div className="flex items-center gap-2 text-amber-300">
            <WifiOff className="w-4 h-4" />
            <b>Audit desk not reachable</b>
          </div>
          <p className="text-sm text-gray-400">
            On the phone, start it with <code>python android_audit_desktop.py --no-browser</code> in
            the <code>android auditer</code> folder. OpenHub proxies it from{' '}
            <code>127.0.0.1:8765</code>; set <code>ANDROID_AUDIT_DESK_URL</code> to change the host.
          </p>
          {message && <p className="text-xs text-gray-500">{message}</p>}
        </section>
      )}

      {online && (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          <section className="space-y-2" aria-label="Audit snapshots">
            <h3 className="text-xs uppercase tracking-wider text-gray-500">Snapshots</h3>
            <div className="flex lg:flex-col gap-2 overflow-x-auto pb-1">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    'min-h-11 shrink-0 lg:w-full text-left rounded-lg border px-3 py-2 transition',
                    selected === p.id
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-surface-overlay hover:border-blue-500/30',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold truncate">{p.app_name}</span>
                    <span className={cn(
                      'ml-auto text-xs font-bold',
                      (p.score ?? 0) >= 70 ? 'text-emerald-300' : (p.score ?? 0) >= 40 ? 'text-amber-300' : 'text-red-300',
                    )}>
                      {p.score ?? '—'}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {p.kind} · {p.findings_count} findings · {p.scanned_at}
                  </div>
                </button>
              ))}
              {profiles.length === 0 && <p className="text-sm text-gray-500">No snapshots yet.</p>}
            </div>
          </section>

          <section className="space-y-4" aria-label="Audit detail">
            {report ? (
              <>
                <div className="industrial-card p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-gray-500">Score</div>
                      <div className="text-3xl font-extrabold">
                        {report.profile.score ?? '—'}
                        <span className="text-base text-gray-500">/100</span>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-wrap pt-5">
                      {SEVERITIES.map((sev) => (
                        <span key={sev} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-bold', SEV_STYLE[sev])}>
                          {sev} {counts[sev] ?? 0}
                        </span>
                      ))}
                    </div>
                    <div className="spacer" />
                    <div className="flex flex-wrap gap-2">
                      <button className="btn ghost tiny min-h-11" onClick={() => void download('agent-md')}>
                        <FileText className="w-4 h-4" /> Agent plan
                      </button>
                      <button className="btn ghost tiny min-h-11" onClick={() => void download('sarif')}>
                        <Download className="w-4 h-4" /> SARIF
                      </button>
                      <button className="btn ghost tiny min-h-11" onClick={() => void copyTasks()}>
                        <Clipboard className="w-4 h-4" /> Copy tasks
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    {report.profile.file_name} · {report.profile.version_label} · snapshot #{report.profile.id}
                  </p>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <div className="industrial-card overflow-hidden">
                    <h3 className="!text-sm flex items-center gap-2 p-4 pb-2">
                      <ShieldAlert className="w-4 h-4 text-orange-300" /> Findings
                    </h3>
                    <ul className="divide-y divide-surface-overlay max-h-80 overflow-auto">
                      {(report.findings ?? []).slice(0, 40).map((f, i) => (
                        <li key={`${f.rule}-${f.file}-${f.line}-${i}`} className="px-4 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-bold', SEV_STYLE[String(f.severity).toUpperCase()] ?? SEV_STYLE.INFO)}>
                              {f.severity}
                            </span>
                            <code className="text-xs text-gray-300">{f.rule}</code>
                            {f.tier && <span className="text-[10px] text-gray-500">{f.tier}</span>}
                          </div>
                          <div className="text-gray-400 truncate">{f.title ?? f.message}</div>
                          <div className="text-[11px] text-gray-600 truncate">{f.file}:{f.line}</div>
                        </li>
                      ))}
                      {(report.findings ?? []).length === 0 && <li className="px-4 py-3 text-sm text-gray-500">No findings.</li>}
                    </ul>
                  </div>

                  <div className="industrial-card overflow-hidden">
                    <h3 className="!text-sm flex items-center gap-2 p-4 pb-2">
                      <ListChecks className="w-4 h-4 text-emerald-300" /> P0 / P1 tasks
                    </h3>
                    <ul className="divide-y divide-surface-overlay max-h-80 overflow-auto">
                      {tasks.map((t) => (
                        <li key={t.id} className="px-4 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-300">{t.priority}</span>
                            <code className="text-xs text-gray-300">{t.rule}</code>
                            <span className="text-[10px] text-gray-500">{t.parallel_safe ? 'parallel' : 'serial'}</span>
                          </div>
                          <div className="text-gray-400">{t.fix}</div>
                          <div className="text-[11px] text-gray-600 truncate">{t.file}:{t.line}</div>
                        </li>
                      ))}
                      {tasks.length === 0 && <li className="px-4 py-3 text-sm text-gray-500">No P0/P1 tasks.</li>}
                    </ul>
                  </div>
                </div>

                {(report.report?.integrations ?? []).length > 0 && (
                  <div className="industrial-card p-4">
                    <h3 className="!text-sm mb-2">Optional integrations</h3>
                    <ul className="space-y-1 text-xs text-gray-400">
                      {(report.report?.integrations ?? []).map((row) => (
                        <li key={row.name} className="flex items-center gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <b>{row.name}</b> — {row.status}{row.reason ? ` · ${row.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500">Select a snapshot.</p>
            )}
            {message && <p className="text-xs text-amber-300">{message}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
