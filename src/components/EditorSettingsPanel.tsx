import { useCallback, useEffect, useState } from 'react';
import { Check, Cpu, Loader2, Flame } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import {
  axiomEditorModelCatalog,
  axiomEditorModels,
  axiomEditorSetModel,
  axiomEditorWarm,
  axiomEditorWarmStart,
  type EditorModelCatalogResult,
  type EditorModelsResult,
} from '../ide/axiomEditorClient';
import { modelPickerOptions, parseModelCatalog } from '../ide/editorModelCatalog';
import { loadTabPrefs, saveTabPrefs, applyTabPrefs, type TabPrefs } from '../lib/editorPrefs';

/**
 * Editor settings — everything that used to be configured inside the workspace
 * (Tab completion, the model lane, warmth). Configuration belongs here; the
 * workspace only reads it.
 */
export function EditorSettingsPanel() {
  const [prefs, setPrefs] = useState<TabPrefs>(() => loadTabPrefs());
  const [models, setModels] = useState<EditorModelsResult | null>(null);
  const [catalog, setCatalog] = useState<EditorModelCatalogResult | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [warm, setWarm] = useState<string | null>(null);
  const [save, setSave] = useState<'saving' | 'saved' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshWarm = useCallback(async () => {
    try {
      const w = await axiomEditorWarm();
      const t = w.data?.target;
      setWarm(t ? `${t.model ?? 'local'} · ${w.data?.keepalive ? 'keepalive on' : 'idle'}` : 'no local model configured');
    } catch {
      setWarm('warm status unavailable');
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [m, c] = await Promise.all([
        axiomEditorModels().then((r) => r.data ?? null).catch(() => null),
        axiomEditorModelCatalog().then((r) => r.data ?? null).catch(() => null),
      ]);
      setModels(m);
      setCatalog(c);
      try {
        const res = await fetch('/api/axiom/capabilities', { credentials: 'include', headers: getAuthHeaders() });
        const json = await res.json();
        const caps = Array.isArray(json?.data) ? json.data : Array.isArray(json?.capabilities) ? json.capabilities : [];
        const entry = caps.find((x: { id?: string }) => x?.id === 'editor') as { detail?: string } | undefined;
        setDetail(typeof entry?.detail === 'string' ? entry.detail : 'model status unavailable');
      } catch {
        setDetail('model status unavailable');
      }
      await refreshWarm();
    } finally {
      setBusy(false);
    }
  }, [refreshWarm]);

  useEffect(() => { void load(); }, [load]);

  const update = (patch: Partial<TabPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      saveTabPrefs(next);
      applyTabPrefs(next);
      return next;
    });
  };

  const chooseModel = async (model: string) => {
    update({ model });
    if (!model) return;
    setSave('saving');
    try {
      await axiomEditorSetModel(model);
      setSave('saved');
    } catch {
      setSave('error');
    }
    setTimeout(() => setSave(null), 2500);
  };

  const options = modelPickerOptions(parseModelCatalog(catalog), {
    configured: models?.configured ?? null,
    models: models?.models ?? [],
  });

  return (
    <div className="p-8 space-y-6 animate-in fade-in duration-300">
      <div className="border-b border-white/5 pb-6">
        <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Editor</h2>
        <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
          Tab completion, the inline-edit model lane, and local-model warmth. Applied live; the workspace only reads these.
        </p>
      </div>

      <div className="industrial-card p-5 space-y-4 max-w-2xl">
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Tab completion
            <span className="block text-[11px] text-gray-500">Axiom suggests inline completions as you type.</span>
          </span>
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Show delay
            <span className="block text-[11px] text-gray-500">Pause after typing before requesting.</span>
          </span>
          <select
            value={prefs.delayMs}
            onChange={(e) => update({ delayMs: Number(e.target.value) })}
            className="rounded border border-border-muted bg-surface-base px-2 py-1 font-mono text-[12px]"
          >
            <option value={0}>instant</option>
            <option value={150}>150ms</option>
            <option value={500}>500ms</option>
          </select>
        </label>

        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Single-line mode
            <span className="block text-[11px] text-gray-500">Truncate ghost text at the first newline.</span>
          </span>
          <input type="checkbox" checked={prefs.singleLine} onChange={(e) => update({ singleLine: e.target.checked })} />
        </label>

        <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Model lane
            <span className="block text-[11px] text-gray-500">Model used for Tab completion and Ctrl+I inline edit.</span>
          </span>
          <span className="flex items-center gap-2">
            {save === 'saving' && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
            {save === 'saved' && <Check className="w-3.5 h-3.5 text-emerald-400" />}
            <select
              value={prefs.model}
              onChange={(e) => void chooseModel(e.target.value)}
              className="max-w-[16rem] rounded border border-border-muted bg-surface-base px-2 py-1 font-mono text-[12px]"
            >
              <option value="">Auto (configured default)</option>
              {options.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </span>
        </label>
        {save === 'error' && <p className="text-[11px] text-[var(--color-danger)]">Could not save the default model.</p>}

        <div className="border-t border-white/5 pt-4 flex flex-wrap items-center gap-3 text-[11px] font-mono text-gray-400">
          <Cpu className="w-3.5 h-3.5" />
          <span className="min-w-0 flex-1 truncate" title={detail ?? undefined}>{detail ?? 'reading model status…'}</span>
          <span className="min-w-0 truncate" title={warm ?? undefined}>warm: {warm ?? 'checking…'}</span>
          <button
            type="button"
            onClick={() => { void axiomEditorWarmStart().then(() => refreshWarm()).catch(() => setWarm('warm start failed')); }}
            className="inline-flex items-center gap-1.5 rounded border border-border-muted px-2 py-1 font-semibold hover:text-[var(--color-text-primary)]"
          >
            <Flame className="w-3.5 h-3.5" /> Warm now
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="rounded border border-border-muted px-2 py-1 font-semibold hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
