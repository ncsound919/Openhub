import { setAxiomMonacoOptions } from '../ide/monacoProviders';

/** Editor / Tab-completion preferences. Persisted per browser and applied to
 *  Monaco live (providers read live options on every call, so no remount).
 *
 *  These used to live in the workspace chrome; they are configuration, so they
 *  now live in Settings → Editor and the workspace only reads them. */
export interface TabPrefs {
  enabled: boolean;
  delayMs: number;
  singleLine: boolean;
  model: string;
}

const KEY = 'openhub.tab.prefs';

export const DEFAULT_TAB_PREFS: TabPrefs = { enabled: true, delayMs: 0, singleLine: false, model: '' };

export function loadTabPrefs(): TabPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<TabPrefs>;
      return {
        enabled: p.enabled !== false,
        delayMs: [0, 150, 500].includes(p.delayMs ?? 0) ? (p.delayMs ?? 0) : 0,
        singleLine: p.singleLine === true,
        model: typeof p.model === 'string' ? p.model : '',
      };
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_TAB_PREFS };
}

export function saveTabPrefs(prefs: TabPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage may be unavailable */ }
}

/** Apply to Monaco immediately (module singleton — no remount needed). */
export function applyTabPrefs(prefs: TabPrefs): void {
  setAxiomMonacoOptions({
    completionEnabled: prefs.enabled,
    completionDelayMs: prefs.delayMs,
    singleLine: prefs.singleLine,
    model: prefs.model || undefined,
  });
}
