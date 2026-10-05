import { create } from 'zustand';
import { getAuthHeaders } from '../auth/AuthProvider';

/** Axiom's own routing modes — not LiteLLM model ids. */
export const AXIOM_ROUTES = ['auto', 'opencode', 'deterministic', 'local'] as const;

/** Provider models always offered, in addition to the LiteLLM catalog. */
export const STATIC_MODELS = [
  { id: 'deepseek-chat', ownedBy: 'deepseek' },
  { id: 'deepseek-reasoner', ownedBy: 'deepseek' },
  { id: 'github-copilot', ownedBy: 'github' },
] as const;

export type LlmTask = 'axiom' | 'review' | 'default';

export interface LlmModelInfo {
  id: string;
  ownedBy: string | null;
}

interface ModelStore {
  models: LlmModelInfo[];
  configuredModel: string | null;
  gatewayUrl: string | null;
  loaded: boolean;
  error: string | null;
  routes: Record<LlmTask, string>;
  fetchModels: () => Promise<void>;
  setRoute: (task: LlmTask, model: string) => void;
  /** Advance a task to the next available model/route (wrap-around). */
  cycleRoute: (task: LlmTask) => void;
}

const STORAGE_KEY = 'openhub.modelRoutes';
const DEFAULTS: Record<LlmTask, string> = { axiom: 'auto', review: '', default: '' };

function loadRoutes(): Record<LlmTask, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Record<LlmTask, string>>) };
  } catch { /* corrupt storage — fall back to defaults */ }
  return { ...DEFAULTS };
}

/** Options a task can cycle through (LiteLLM ids for review/default, Axiom modes for axiom). */
function optionsFor(state: Pick<ModelStore, 'models' | 'configuredModel'>, task: LlmTask): string[] {
  if (task === 'axiom') return [...AXIOM_ROUTES];
  const ids = state.models.map((m) => m.id);
  for (const s of STATIC_MODELS) if (!ids.includes(s.id)) ids.push(s.id);
  if (state.configuredModel && !ids.includes(state.configuredModel)) ids.unshift(state.configuredModel);
  for (const fallback of ['fleet-free', 'auto']) {
    if (!ids.includes(fallback)) ids.push(fallback);
  }
  return [...new Set(ids)];
}

export const useModelStore = create<ModelStore>((set, get) => ({
  models: [],
  configuredModel: null,
  gatewayUrl: null,
  loaded: false,
  error: null,
  routes: loadRoutes(),

  fetchModels: async () => {
    try {
      const res = await fetch('/api/intelligence/llm', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      const models: LlmModelInfo[] = Array.isArray(data.models) ? data.models : [];
      // Always merge the provider models so DeepSeek + Copilot are selectable
      // even when the gateway catalog is empty.
      for (const s of STATIC_MODELS) {
        if (!models.some((m) => m.id === s.id)) models.push({ ...s });
      }
      set({
        models,
        configuredModel: typeof data.configuredModel === 'string' ? data.configuredModel : null,
        gatewayUrl: typeof data.baseUrl === 'string' ? data.baseUrl : null,
        loaded: true,
        error: data.ok ? null : (typeof data.error === 'string' ? data.error : 'Model gateway unreachable'),
      });
    } catch (err) {
      set({
        models: STATIC_MODELS.map((s) => ({ ...s })),
        loaded: true,
        error: err instanceof Error ? err.message : 'Unable to read model gateway',
      });
    }
  },

  setRoute: (task, model) => {
    const routes = { ...get().routes, [task]: model };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(routes)); } catch { /* non-fatal */ }
    set({ routes });
  },

  cycleRoute: (task) => {
    const options = optionsFor(get(), task);
    if (options.length === 0) return;
    const idx = options.indexOf(get().routes[task]);
    const next = options[(idx + 1) % options.length];
    get().setRoute(task, next);
  },
}));

/** The model actually used by a task — resolves an empty selection to its default. */
export function effectiveModel(task: LlmTask): string {
  const { routes, configuredModel } = useModelStore.getState();
  const value = routes[task];
  if (value) return value;
  if (task === 'axiom') return 'auto';
  return configuredModel || 'fleet-free';
}
