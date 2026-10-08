import { useState } from 'react';

const DEFAULT_TABS = ['Review', 'Todos', 'Artifacts', 'Telemetry'];

interface MissionInspectorProps {
  tabs?: string[];
}

/**
 * Right-hand inspector for a mission. Phase B stub: it renders the tab rail and
 * an explicit "Coming in a later phase" body. Phase D fills each tab.
 */
export function MissionInspector({ tabs = DEFAULT_TABS }: MissionInspectorProps) {
  const [active, setActive] = useState(tabs[0] ?? '');

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--color-border-muted)] bg-[var(--color-surface-base)]">
      <div
        role="tablist"
        className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-muted)] px-2 py-1.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === active}
            onClick={() => setActive(tab)}
            className={
              'rounded px-2 py-1 text-[11px] font-semibold transition-colors ' +
              (tab === active
                ? 'bg-[var(--color-surface-overlay)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]')
            }
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-[var(--color-text-muted)]">
        {active}: Coming in a later phase
      </div>
    </div>
  );
}
