/**
 * Autonomy mode — the visible leash on the agent. Chosen in the chat header,
 * persisted per browser, and consulted before any consequential action.
 *
 *   manual — ask before every consequential action
 *   auto   — run autonomously; gate only destructive actions
 *   plan   — gate everything, and prefer parking agent work as an approvable plan
 */
export type AutonomyMode = 'manual' | 'auto' | 'plan';
export type GateIntensity = 'reversible' | 'destructive' | 'catastrophic';

const KEY = 'openhub.autonomy';

export const AUTONOMY_MODES: Array<{ id: AutonomyMode; label: string; hint: string }> = [
  { id: 'manual', label: 'Manual', hint: 'Ask before every consequential action' },
  { id: 'auto', label: 'Auto', hint: 'Run autonomously; gate only destructive actions' },
  { id: 'plan', label: 'Plan', hint: 'Gate everything and prefer an approvable plan' },
];

export function getAutonomyMode(): AutonomyMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'manual' || raw === 'auto' || raw === 'plan') return raw;
  } catch { /* storage unavailable */ }
  return 'manual';
}

export function setAutonomyMode(mode: AutonomyMode): void {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}

/** Whether an action of this intensity needs a confirmation gate in the mode. */
export function gateRequired(intensity: GateIntensity, mode: AutonomyMode = getAutonomyMode()): boolean {
  if (mode === 'auto') return intensity !== 'reversible';
  // manual and plan gate everything consequential.
  return true;
}

/** In plan mode, agent work should be parked as an approvable plan first. */
export function prefersPlanGate(mode: AutonomyMode = getAutonomyMode()): boolean {
  return mode === 'plan';
}
