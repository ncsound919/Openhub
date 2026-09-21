import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Bot, Cpu, Play, Pause, CheckCircle2, AlertCircle, Loader2,
  Clock, Settings, Zap, ChevronRight, RefreshCw, Plus, Trash2,
  ArrowRight, Save, GripVertical
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { useModelStore, AXIOM_ROUTES } from '../lib/modelStore';

type StepStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped';
type LLMChoice = 'ollama' | 'gemini' | 'anthropic' | 'deepseek' | 'openrouter';
type LogLevel = 'info' | 'success' | 'error';
type PipelineLog = { level: LogLevel; text: string };

interface PipelineStep {
  id: string;
  name: string;
  key: string;
  description: string;
  enabled: boolean;
  llm: LLMChoice;
  status: StepStatus;
  config: Record<string, string>;
}

const DEFAULT_STEPS: PipelineStep[] = [
  { id: '1', key: 'architect', name: 'Architect', description: 'Plan architecture from natural language intent', enabled: true, llm: 'ollama', status: 'idle', config: {} },
  { id: '2', key: 'code', name: 'Code', description: 'Generate implementation code', enabled: true, llm: 'gemini', status: 'idle', config: {} },
  { id: '3', key: 'review', name: 'Review', description: 'Multi-agent code review with WCAG checks', enabled: true, llm: 'anthropic', status: 'idle', config: {} },
  { id: '4', key: 'verify', name: 'Verify', description: 'Validate against design system and standards', enabled: true, llm: 'gemini', status: 'idle', config: {} },
  { id: '5', key: 'iterate', name: 'Iterate', description: 'Auto-fix loop for review findings', enabled: true, llm: 'ollama', status: 'idle', config: { maxRetries: '3' } },
  { id: '6', key: 'test', name: 'Test', description: 'Generate comprehensive tests', enabled: true, llm: 'deepseek', status: 'idle', config: {} },
  { id: '7', key: 'deploy', name: 'Deploy', description: 'Generate deployment configurations', enabled: false, llm: 'ollama', status: 'idle', config: {} },
];

const PRESETS: { name: string; steps: string[] }[] = [
  { name: 'Quick Scaffold', steps: ['architect', 'code'] },
  { name: 'Full Production', steps: ['architect', 'code', 'review', 'verify', 'iterate', 'test', 'deploy'] },
  { name: 'Code Review Only', steps: ['review', 'verify', 'iterate'] },
  { name: 'Test Generation', steps: ['test'] },
  { name: 'Security Audit', steps: ['review', 'verify'] },
];

const LLM_LABELS: Record<LLMChoice, string> = {
  ollama: 'Ollama (Local)',
  gemini: 'Gemini API',
  anthropic: 'Anthropic API',
  deepseek: 'DeepSeek API',
  openrouter: 'OpenRouter API',
};

const LLM_COLORS: Record<LLMChoice, string> = {
  ollama: 'text-green-400 bg-green-500/10 border-green-500/30',
  gemini: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  anthropic: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  deepseek: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  openrouter: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
};

/** Axiom's own routing modes (single source of truth: lib/modelStore). */
const ROUTE_LABELS: Record<(typeof AXIOM_ROUTES)[number], string> = {
  auto: 'Auto (Axiom decides)',
  opencode: 'OpenCode harness',
  deterministic: 'Deterministic only (no model)',
  local: 'Local model only',
};

export function StudioPage() {
  const [steps, setSteps] = useState<PipelineStep[]>(() => {
    try {
      const saved = localStorage.getItem('openhub_pipeline_steps');
      if (!saved) return DEFAULT_STEPS;
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) && parsed.length ? (parsed as PipelineStep[]) : DEFAULT_STEPS;
    } catch {
      // Corrupt persisted state must not blank the page.
      return DEFAULT_STEPS;
    }
  });
  const [intent, setIntent] = useState('');
  const [targetStack, setTargetStack] = useState('react');
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<PipelineLog[]>([]);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState('');
  // Axiom's routing mode is owned by lib/modelStore (shared with WorkspacePage).
  const axiomRoute = useModelStore((s) => s.routes.axiom || 'auto') as (typeof AXIOM_ROUTES)[number];
  const setRoute = useModelStore((s) => s.setRoute);

  useEffect(() => {
    localStorage.setItem('openhub_pipeline_steps', JSON.stringify(steps));
  }, [steps]);

  // Cancel an in-flight pipeline poll when the page unmounts; otherwise the
  // for(;;) loop keeps fetching after navigation.
  const runRef = React.useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (runRef.current) runRef.current.cancelled = true; }, []);

  const addLog = (msg: string, level: LogLevel = 'info') =>
    setLogs((prev) => [...prev, { level, text: `[${new Date().toLocaleTimeString()}] ${msg}` }]);

  const toggleStep = (id: string) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  };

  const applyPreset = (preset: typeof PRESETS[0]) => {
    setActivePreset(preset.name);
    setSteps((prev) =>
      prev.map((s) => ({
        ...s,
        enabled: preset.steps.includes(s.key),
      }))
    );
  };

  const resetSteps = () => {
    setSteps(DEFAULT_STEPS);
    setLogs([]);
    setActivePreset('');
  };

  const runPipeline = async () => {
    if (!intent.trim()) {
      setIntentError('Describe what you want to build before running the pipeline.');
      return;
    }
    setIntentError(null);
    setIsRunning(true);
    setLogs([]);
    addLog(`Axiom loop started with intent: "${intent}" (route: ${axiomRoute})`);

    setSteps((prev) => prev.map((s) => (s.enabled ? { ...s, status: 'running' } : s)));

    const run = { cancelled: false };
    runRef.current = run;
    const startedAt = Date.now();
    const MAX_POLL_MS = 15 * 60 * 1000;

    try {
      // Axiom is the single engine. The legacy per-step vibeserve MCP tools
      // were removed; the whole pipeline is one Axiom project loop.
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ goal: `${intent} (target stack: ${targetStack})`, modelRoute: axiomRoute }),
      });
      const body = await res.json();
      const loopId: string | undefined = body?.data?.id;
      if (!res.ok || !loopId) {
        setSteps((prev) => prev.map((s) => (s.enabled ? { ...s, status: 'failed' } : s)));
        addLog(`Axiom loop failed to start: ${body?.error || res.statusText} (code ${res.status})`, 'error');
        setIsRunning(false);
        return;
      }
      addLog(`Axiom loop ${String(loopId).slice(0, 8)} running…`);

      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (run.cancelled) return;
        if (Date.now() - startedAt > MAX_POLL_MS) {
          addLog('Stopped watching after 15 minutes — open the loop console for live status.', 'error');
          break;
        }
        const sres = await fetch(`/api/axiom/project/status/${encodeURIComponent(loopId)}`, {
          credentials: 'include',
          headers: getAuthHeaders(),
        });
        const sbody = await sres.json();
        if (run.cancelled) return;
        const loop = sbody?.data;
        if (!loop) continue;
        const iterations = Array.isArray(loop.iterations) ? loop.iterations : [];
        const latest = iterations.length ? iterations[iterations.length - 1] : null;
        if (latest) addLog(`Axiom iteration ${loop.iteration ?? 0}/${loop.maxIterations ?? '?'}: ${latest.verdict ?? ''}`);
        if (loop.status !== 'running') {
          const ok = loop.status === 'done';
          setSteps((prev) => prev.map((s) => (s.enabled ? { ...s, status: ok ? 'success' : 'failed' } : s)));
          addLog(`Axiom loop ${loop.status}.`, ok ? 'success' : 'error');
          break;
        }
      }
    } catch (err: any) {
      if (run.cancelled) return;
      setSteps((prev) => prev.map((s) => (s.enabled ? { ...s, status: 'failed' } : s)));
      addLog(`Error: ${err.message}`, 'error');
    }

    if (!run.cancelled) setIsRunning(false);
  };

  const statusIcon = (status: StepStatus) => {
    switch (status) {
      case 'running': return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
      case 'success': return <CheckCircle2 className="w-4 h-4 text-green-400" />;
      case 'failed': return <AlertCircle className="w-4 h-4 text-red-400" />;
      case 'skipped': return <Pause className="w-4 h-4 text-gray-400" />;
      default: return <div className="w-4 h-4 rounded-full border border-border-muted" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--color-bg-base)' }}>
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-border-muted">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
            <Zap className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--color-text-primary)]">Studio Pipeline</h1>
            <p className="text-xs text-gray-400 font-mono uppercase tracking-widest">Autonomous Agentic Workflow</p>
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <button onClick={resetSteps} className="flex items-center gap-1 px-3 py-1.5 bg-surface-raised hover:bg-border-muted rounded text-gray-400 text-xs">
            <RefreshCw className="w-3.5 h-3.5" /> Reset
          </button>
          <Link to="/workspace" className="flex items-center gap-1 px-3 py-1.5 bg-surface-raised hover:bg-border-muted rounded text-gray-400 text-xs">
            <ArrowRight className="w-3.5 h-3.5" /> Workspace
          </Link>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-y-auto p-6 gap-6">
          {/* Intent Input */}
          <div className="space-y-3">
            <label htmlFor="studio-intent" className="block text-xs font-bold text-gray-400 uppercase tracking-wider">
              What do you want to build?
            </label>
            <textarea
              id="studio-intent"
              value={intent}
              onChange={(e) => { setIntent(e.target.value); if (intentError) setIntentError(null); }}
              placeholder="e.g. Build a SaaS analytics dashboard with dark mode, user auth, and Stripe billing integration..."
              aria-invalid={intentError ? true : undefined}
              aria-describedby={intentError ? 'studio-intent-error' : undefined}
              className="w-full bg-surface-raised border border-border-muted rounded-lg p-4 text-sm text-[var(--color-text-primary)] placeholder-gray-500 resize-none focus:border-purple-500 focus:outline-none"
              rows={3}
            />
            {intentError && (
              <p id="studio-intent-error" role="alert" className="text-[11px] text-red-400">
                {intentError}
              </p>
            )}
            <div className="flex items-center gap-4">
              <select
                value={targetStack}
                onChange={(e) => setTargetStack(e.target.value)}
                className="bg-surface-raised border border-border-muted rounded px-3 py-1.5 text-xs text-gray-400"
              >
                <option value="react">React + TypeScript</option>
                <option value="nextjs">Next.js</option>
                <option value="vue">Vue 3</option>
                <option value="python">Python / FastAPI</option>
                <option value="node">Node.js / Express</option>
                <option value="rust">Rust</option>
                <option value="go">Go</option>
              </select>
              <button
                type="button"
                onClick={runPipeline}
                disabled={isRunning || !intent.trim()}
                aria-busy={isRunning}
                aria-describedby={intentError ? 'studio-intent-error' : undefined}
                className="flex items-center gap-2 px-5 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 rounded-lg text-white text-xs font-bold transition-colors"
              >
                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {isRunning ? 'Running...' : 'Run Pipeline'}
              </button>
            </div>
          </div>

          {/* Pipeline Steps */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Pipeline Steps</h2>
              <div className="flex items-center gap-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                      activePreset === p.name
                        ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                        : 'bg-surface-raised border border-border-muted text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <AnimatePresence>
                {steps.map((step, idx) => (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                      step.status === 'running' ? 'border-blue-500/50 bg-blue-500/5' :
                      step.status === 'success' ? 'border-green-500/30 bg-green-500/5' :
                      step.status === 'failed' ? 'border-red-500/30 bg-red-500/5' :
                      step.enabled ? 'border-border-muted bg-surface-raised' :
                      'border-surface-overlay bg-surface-base opacity-50'
                    }`}
                  >
                    <div className="flex items-center justify-center w-5">{statusIcon(step.status)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold ${step.enabled ? 'text-gray-400' : 'text-gray-400'}`}>
                          {step.name}
                        </span>
                        {step.status === 'success' && (
                          <span className="text-[10px] text-green-400 font-bold">DONE</span>
                        )}
                        {step.status === 'running' && (
                          <span className="text-[10px] text-blue-400 font-bold animate-pulse">RUNNING</span>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-400 mt-0.5">{step.description}</p>
                    </div>

                    {/* Advisory only: Axiom runs the whole pipeline loop under a
                        single route, so this is informational, not a control. */}
                    <span
                      className={`px-2 py-1 rounded text-[10px] font-bold border ${LLM_COLORS[step.llm]} ${step.enabled ? '' : 'opacity-50'}`}
                      title={`Advisory: ${LLM_LABELS[step.llm]}. Axiom runs the whole pipeline under one route (${ROUTE_LABELS[axiomRoute]}).`}
                    >
                      {LLM_LABELS[step.llm]}
                    </span>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={step.enabled}
                      aria-label={`Enable ${step.name} step`}
                      onClick={() => toggleStep(step.id)}
                      disabled={isRunning}
                      className={`w-9 h-5 rounded-full relative transition-colors ${
                        step.enabled ? 'bg-purple-600' : 'bg-border-muted'
                      } disabled:opacity-50`}
                    >
                      <div
                        className={`w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform ${
                          step.enabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>

                    {/* Arrow between steps */}
                    {idx < steps.length - 1 && (
                      <div className="absolute left-7 bottom-[-18px] w-px h-4 bg-border-muted" />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>

          {/* Logs */}
          {logs.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Pipeline Log</h2>
              <div
                role="log"
                aria-live="polite"
                aria-label="Pipeline log"
                className="bg-surface-base border border-border-muted rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs"
              >
                {logs.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.level === 'error' ? 'text-red-400' :
                      line.level === 'success' ? 'text-green-400' :
                      'text-gray-400'
                    }
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Sidebar: Settings */}
        <div className="w-72 border-l border-border-muted p-4 space-y-4 overflow-y-auto" style={{ background: 'var(--color-surface-base)' }}>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Pipeline Configuration</h3>

          <div className="space-y-3">
            <div className="bg-surface-raised border border-border-muted rounded-lg p-3">
              <label htmlFor="axiom-route" className="block text-xs text-gray-400 mb-2">Model routing (Axiom)</label>
              <select
                id="axiom-route"
                value={axiomRoute}
                onChange={(e) => setRoute('axiom', e.target.value)}
                disabled={isRunning}
                className="w-full bg-surface-base border border-border-muted rounded px-2 py-1.5 text-[11px] text-[var(--color-text-primary)] disabled:opacity-50"
              >
                {AXIOM_ROUTES.map((r) => (
                  <option key={r} value={r}>{ROUTE_LABELS[r]}</option>
                ))}
              </select>
              <p className="mt-1.5 text-[10px] text-gray-500">
                Applies to the whole loop. The per-step labels above are advisory.
              </p>
            </div>

            <div className="bg-surface-raised border border-border-muted rounded-lg p-3">
              <div className="text-xs text-gray-400 mb-2">Quality Gates</div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-[10px] text-green-400">
                  <CheckCircle2 className="w-3 h-3" /> Typecheck (enforced by Axiom)
                </div>
                <div className="flex items-center gap-2 text-[10px] text-green-400">
                  <CheckCircle2 className="w-3 h-3" /> Unit tests (enforced by Axiom)
                </div>
                {['WCAG AAA accessibility', '80% test coverage', 'Security scan (SAST/SCA)', 'Bundle size < 1MB'].map((g) => (
                  <div key={g} className="flex items-center gap-2 text-[10px] text-gray-500" title="Axiom's project loop does not enforce this gate yet">
                    <AlertCircle className="w-3 h-3" /> {g} · not enforced
                  </div>
                ))}
              </div>
            </div>

            <Link
              to="/models"
              className="flex items-center justify-between w-full px-3 py-2 bg-surface-raised border border-border-muted rounded-lg text-xs text-gray-400 hover:text-[var(--color-text-primary)] transition-colors"
            >
              <div className="flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5" />
                LLM Configuration
              </div>
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
