import React, { Suspense, lazy } from 'react';
import { Orbit, Zap, Telescope, Network, HeartPulse, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useSnapshot, webglAvailable } from './useSnapshot';
import type { SystemSnapshot } from './useSnapshot';

const SynergyView = lazy(() => import('./views/SynergyView').then((m) => ({ default: m.SynergyView })));
const LoopView = lazy(() => import('./views/LoopView').then((m) => ({ default: m.LoopView })));
const ResearchView = lazy(() => import('./views/ResearchView').then((m) => ({ default: m.ResearchView })));
const EcosystemView3D = lazy(() => import('./views/EcosystemView3D').then((m) => ({ default: m.EcosystemView3D })));
const HealthView = lazy(() => import('./views/HealthView').then((m) => ({ default: m.HealthView })));

export type VisualView = 'synergy' | 'loop' | 'research' | 'ecosystem' | 'health';

const VIEWS: { id: VisualView; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'synergy', label: 'Synergy', icon: Network, hint: 'Force graph of synergy domains' },
  { id: 'loop', label: 'Loop', icon: Zap, hint: 'Axiom iteration helix' },
  { id: 'research', label: 'Research', icon: Telescope, hint: 'Research constellation' },
  { id: 'ecosystem', label: 'Ecosystem', icon: Orbit, hint: 'Intel-source archipelago' },
  { id: 'health', label: 'Health', icon: HeartPulse, hint: 'Repo health orb' },
];

/** Workspace 3D visualizer: animated, informative views over the same snapshot feed. */
export function VisualizerPanel() {
  const [view, setView] = React.useState<VisualView>('health');
  const { snapshot, error } = useSnapshot();
  const gl = React.useMemo(() => webglAvailable(), []);

  // Copilot deep-link: window event 'openhub:visualize' with a view id.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (VIEWS.some((v) => v.id === id)) setView(id as VisualView);
    };
    window.addEventListener('openhub:visualize', handler);
    return () => window.removeEventListener('openhub:visualize', handler);
  }, []);
  const active = VIEWS.find((v) => v.id === view)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-surface-overlay px-2 py-1.5">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          return (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            title={v.hint}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-bold transition-colors',
              view === v.id ? 'bg-blue-600/20 text-blue-200' : 'text-gray-400 hover:text-white',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {v.label}
          </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 p-2">
        {!gl ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-surface-overlay bg-black/40 p-6 text-center">
            <p className="font-mono text-xs text-gray-400">
              WebGL unavailable — 3D views need a GPU-capable browser.
              <br />
              {error ? `Snapshot: ${error}` : snapshot ? `Snapshot live · ${(snapshot as SystemSnapshot).generatedAt}` : 'Loading snapshot…'}
            </p>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center rounded-lg border border-surface-overlay bg-black/40">
                <Loader2 className="h-5 w-5 animate-spin text-blue-300" />
              </div>
            }
          >
            {view === 'synergy' && <SynergyView />}
            {view === 'loop' && <LoopView snapshot={snapshot} />}
            {view === 'research' && <ResearchView />}
            {view === 'ecosystem' && <EcosystemView3D snapshot={snapshot} />}
            {view === 'health' && <HealthView snapshot={snapshot} />}
          </Suspense>
        )}
      </div>
      <div className="truncate border-t border-surface-overlay px-3 py-1 font-mono text-[10px] text-gray-400">
        {active.hint}
        {error ? ` · snapshot: ${error}` : ''}
      </div>
    </div>
  );
}
