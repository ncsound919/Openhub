import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Hammer,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal
} from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';

/**
 * Workbench (MathSpec) settings — the operator-facing half of the integration.
 *
 * Everything here is stored server-side in `workbench_config`. The bearer token
 * is write-only: the API returns `hasToken`, never the value. "Start" is the
 * only action that spawns anything, and it reports the exact reason on failure
 * instead of leaving a spinner.
 */

interface WorkbenchConfig {
  enabled: boolean;
  url: string;
  hasToken: boolean;
  autoStart: boolean;
  autoContext: boolean;
  contextTimeoutMs: number;
  projectId: string;
  contextBudgetTokens: number;
  workbenchRoot: string;
  allowRemote: boolean;
}

interface Health {
  ok: boolean;
  reachable: boolean;
  url: string;
  service?: string;
  version?: string;
  tools?: number;
  authRequired?: boolean;
  error?: string;
}

interface Tool {
  name: string;
  title?: string;
  description: string;
  risk?: 'read' | 'compute';
}

const jsonHeaders = () => ({
  ...getAuthHeaders(),
  'Content-Type': 'application/json',
  'X-CSRF-Token': getCsrfToken()
});

export function WorkbenchSettingsPanel() {
  const [config, setConfig] = useState<WorkbenchConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [tokenDraft, setTokenDraft] = useState('');
  const [busy, setBusy] = useState<'load' | 'save' | 'start' | 'tools' | 'mcp' | null>('load');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [mcp, setMcp] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [configRes, healthRes] = await Promise.all([
        fetch('/api/workbench/config', { credentials: 'include', headers: getAuthHeaders() }),
        fetch('/api/workbench/health', { credentials: 'include', headers: getAuthHeaders() })
      ]);
      const configBody = await configRes.json();
      const healthBody = await healthRes.json();
      if (configBody.config) setConfig(configBody.config as WorkbenchConfig);
      if (healthBody.health) setHealth(healthBody.health as Health);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'could not load workbench settings' });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!config) return;
    setBusy('save');
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        enabled: config.enabled,
        url: config.url,
        autoStart: config.autoStart,
        autoContext: config.autoContext,
        contextTimeoutMs: config.contextTimeoutMs,
        projectId: config.projectId,
        contextBudgetTokens: config.contextBudgetTokens,
        workbenchRoot: config.workbenchRoot,
        allowRemote: config.allowRemote
      };
      if (tokenDraft.trim()) body.token = tokenDraft.trim();
      const res = await fetch('/api/workbench/config', {
        method: 'PUT',
        credentials: 'include',
        headers: jsonHeaders(),
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage({ kind: 'error', text: data.error || `save failed (${res.status})` });
        return;
      }
      setConfig(data.config as WorkbenchConfig);
      setTokenDraft('');
      setMessage({ kind: 'ok', text: 'Saved. Health probe running…' });
      const healthRes = await fetch('/api/workbench/health', { credentials: 'include', headers: getAuthHeaders() });
      const healthBody = await healthRes.json();
      setHealth(healthBody.health as Health);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'save failed' });
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy('start');
    setMessage(null);
    try {
      const res = await fetch('/api/workbench/health?start=1', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      setHealth(data.health as Health);
      if (data.ok) {
        setMessage({ kind: 'ok', text: 'Workbench is answering.' });
      } else {
        setMessage({
          kind: 'error',
          text: data.started?.reason || data.health?.error || 'workbench did not start; see data/workbench.log'
        });
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'start failed' });
    } finally {
      setBusy(null);
    }
  };

  const loadTools = async () => {
    setBusy('tools');
    try {
      const res = await fetch('/api/workbench/tools', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      setTools(Array.isArray(data.tools) ? data.tools : []);
      if (!data.ok) setMessage({ kind: 'error', text: data.error || 'could not list tools' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'could not list tools' });
    } finally {
      setBusy(null);
    }
  };

  const loadMcp = async () => {
    setBusy('mcp');
    try {
      const res = await fetch('/api/workbench/mcp-config', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.ok) {
        setMessage({ kind: 'error', text: data.error || 'could not build MCP config' });
        return;
      }
      setMcp(JSON.stringify({ mcp: { workbench: data.http, 'workbench-stdio': data.stdio } }, null, 2));
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : 'could not build MCP config' });
    } finally {
      setBusy(null);
    }
  };

  const copyMcp = async () => {
    if (!mcp) return;
    try {
      await navigator.clipboard.writeText(mcp);
      setMessage({ kind: 'ok', text: 'MCP config copied.' });
    } catch {
      setMessage({ kind: 'error', text: 'clipboard refused; select the text and copy manually.' });
    }
  };

  if (!config) {
    return (
      <div className="p-8 flex items-center gap-3 text-gray-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading workbench settings…
      </div>
    );
  }

  const field = 'w-full px-3 py-2 bg-surface-overlay border border-border-muted rounded-sm text-sm font-mono text-[var(--color-text-primary)] outline-none focus:border-orange-500 transition-colors';
  const label = 'block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5';

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-300">
      <div className="border-b border-white/5 pb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight flex items-center gap-2">
            <Hammer className="w-5 h-5 text-orange-400" /> Workbench
          </h2>
          <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
            MathSpec deterministic tools — the model's check surface
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          {health?.ok ? (
            <span className="flex items-center gap-1.5 text-green-400 bg-green-500/10 border border-green-500/30 px-2 py-1 rounded">
              <CheckCircle2 className="w-3.5 h-3.5" /> {health.service} v{health.version}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-red-400 bg-red-500/10 border border-red-500/30 px-2 py-1 rounded">
              <AlertTriangle className="w-3.5 h-3.5" /> unreachable
            </span>
          )}
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 text-gray-400 hover:text-orange-400 border border-border-muted px-2 py-1 rounded"
          >
            <RefreshCw className="w-3 h-3" /> refresh
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        The workbench exposes its engines as tools: SpecIR checking, measured bundle grading, deterministic RTL,
        lesson search, genome ranking and derivation verification. When auto-context is on, every opencode prompt is
        preceded by a bounded block of relevant recorded lessons. No tool calls a model and none runs a third-party
        binary, so results are reproducible — and an unmeasured dimension is reported as null, not 100.
      </p>

      {message && (
        <div
          className={`text-xs font-mono px-3 py-2 rounded border ${
            message.kind === 'ok'
              ? 'text-green-300 bg-green-500/10 border-green-500/30'
              : 'text-red-300 bg-red-500/10 border-red-500/30'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={label}>Service URL</label>
            <input
              className={field}
              value={config.url}
              onChange={(e) => setConfig({ ...config, url: e.target.value })}
              placeholder="http://127.0.0.1:8790"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Loopback only unless “Allow remote” is on. Default port 8790.
            </p>
          </div>
          <div>
            <label className={label}>Workbench directory</label>
            <input
              className={field}
              value={config.workbenchRoot}
              onChange={(e) => setConfig({ ...config, workbenchRoot: e.target.value })}
              placeholder="…\mathspec_-formal-specir-&-4b-synthesis-workbench"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Contains <code>server/workbench-server.ts</code>. Used only for auto-start.
            </p>
          </div>
        </div>

        <div>
          <label className={label}>
            Bearer token {config.hasToken ? '(stored — type a new one to replace)' : '(optional)'}
          </label>
          <div className="flex gap-2">
            <input
              className={field}
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder={config.hasToken ? '••••••••  stored' : 'empty = loopback-only, no auth'}
              autoComplete="new-password"
            />
            {config.hasToken && (
              <button
                onClick={async () => {
                  const res = await fetch('/api/workbench/config', {
                    method: 'PUT',
                    credentials: 'include',
                    headers: jsonHeaders(),
                    body: JSON.stringify({ clearToken: true })
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setConfig(data.config as WorkbenchConfig);
                    setMessage({ kind: 'ok', text: 'Stored token cleared.' });
                  } else {
                    setMessage({ kind: 'error', text: data.error || 'could not clear token' });
                  }
                }}
                className="shrink-0 px-3 text-[10px] font-black uppercase tracking-widest text-gray-400 border border-border-muted rounded-sm hover:text-red-400"
              >
                clear
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(
            [
              ['enabled', 'Enabled', 'Expose the workbench tools and context to the model path.'],
              ['autoStart', 'Auto-start', 'Start the workbench process when it is unreachable (logged to data/workbench.log).'],
              ['autoContext', 'Inject prompt context', 'Prepend relevant lessons to opencode prompts. Fail-open, bounded.'],
              ['allowRemote', 'Allow remote URL', 'Permit a non-loopback workbench host. Only for a host you control.']
            ] as Array<[keyof WorkbenchConfig, string, string]>
          ).map(([key, title, note]) => (
            <label
              key={String(key)}
              className="flex items-start gap-3 bg-surface-overlay border border-border-muted rounded-sm px-3 py-2.5"
            >
              <input
                type="checkbox"
                checked={Boolean(config[key])}
                onChange={(e) => setConfig({ ...config, [key]: e.target.checked })}
                className="mt-0.5 accent-orange-500"
              />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--color-text-primary)]">{title}</span>
                <span className="block text-[10px] text-gray-500">{note}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className={label}>Project id (memory scope)</label>
            <input
              className={field}
              type="text"
              maxLength={40}
              value={config.projectId}
              onChange={(e) => setConfig({ ...config, projectId: e.target.value })}
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Names the memory scope the assembler retrieves against. Letters, digits, _ and - only.
            </p>
          </div>
          <div>
            <label className={label}>Context budget (tokens)</label>
            <input
              className={field}
              type="number"
              min={400}
              max={8000}
              step={100}
              value={config.contextBudgetTokens}
              onChange={(e) => setConfig({ ...config, contextBudgetTokens: Number(e.target.value) || 1200 })}
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Invariants, playbooks, memory, lessons and a recited goal are fitted to this budget; anything
              dropped is reported by the assembler.
            </p>
          </div>
        </div>

        <div className="max-w-xs">
          <label className={label}>Context timeout (ms)</label>
          <input
            className={field}
            type="number"
            min={250}
            max={10000}
            step={250}
            value={config.contextTimeoutMs}
            onChange={(e) => setConfig({ ...config, contextTimeoutMs: Number(e.target.value) || 1500 })}
          />
          <p className="text-[10px] text-gray-500 mt-1">
            A prompt never waits longer than this for context; on timeout it proceeds unchanged.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={() => void save()}
            disabled={busy !== null}
            className="flex items-center gap-2 bg-orange-500 text-black font-black px-4 py-2 text-[11px] uppercase tracking-widest disabled:opacity-50"
          >
            {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            Save settings
          </button>
          <button
            onClick={() => void start()}
            disabled={busy !== null}
            className="flex items-center gap-2 text-gray-300 border border-border-muted px-4 py-2 text-[11px] font-black uppercase tracking-widest hover:text-orange-400 disabled:opacity-50"
          >
            {busy === 'start' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Start / test
          </button>
          <button
            onClick={() => void loadTools()}
            disabled={busy !== null}
            className="flex items-center gap-2 text-gray-300 border border-border-muted px-4 py-2 text-[11px] font-black uppercase tracking-widest hover:text-orange-400 disabled:opacity-50"
          >
            {busy === 'tools' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}
            List tools
          </button>
          <button
            onClick={() => void loadMcp()}
            disabled={busy !== null}
            className="flex items-center gap-2 text-gray-300 border border-border-muted px-4 py-2 text-[11px] font-black uppercase tracking-widest hover:text-orange-400 disabled:opacity-50"
          >
            {busy === 'mcp' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
            MCP config
          </button>
        </div>
      </div>

      {health && !health.ok && (
        <div className="text-[11px] font-mono text-red-300 bg-red-500/5 border border-red-500/30 rounded-sm p-3">
          Probe failed: {health.error || 'no response'} — target {health.url}. Enable auto-start, or start the service
          manually with <code>npm run serve:workbench</code> in the workbench directory.
        </div>
      )}

      {tools.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
            Tools ({tools.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {tools.map((tool) => (
              <div key={tool.name} className="bg-surface-overlay border border-border-muted rounded-sm p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-[var(--color-text-primary)]">{tool.name}</span>
                  <span
                    className={`ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                      tool.risk === 'read'
                        ? 'text-blue-300 bg-blue-500/10 border-blue-500/30'
                        : 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                    }`}
                  >
                    {tool.risk ?? 'compute'}
                  </span>
                </div>
                <p className="text-[10px] text-gray-400 mt-1 line-clamp-3">{tool.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {mcp && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
              MCP entries (opencode / Axiom)
            </div>
            <button
              onClick={() => void copyMcp()}
              className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400 hover:text-orange-400"
            >
              <Copy className="w-3 h-3" /> copy
            </button>
          </div>
          <pre className="text-[10px] leading-relaxed font-mono text-gray-300 bg-black/40 border border-border-muted rounded-sm p-3 max-h-72 overflow-auto">
            {mcp}
          </pre>
          <p className="text-[10px] text-gray-500">
            Verify the field names against your opencode release before saving; the HTTP entry needs no local process.
          </p>
        </div>
      )}
    </div>
  );
}
