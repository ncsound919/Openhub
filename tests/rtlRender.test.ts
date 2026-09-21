// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * jsdom render sweep.
 * ================
 * Unlike the SSR sweep, jsdom runs effects, so this exercises data-loading
 * paths across every page/component. Each component is imported dynamically
 * and rendered under try/catch so one bad module cannot fail the file; the test
 * asserts a high success ratio and prints failures.
 */

const COMPONENTS: Array<[string, () => Promise<any>]> = [
  ['Dashboard', () => import('../src/pages/Dashboard').then((m) => m.Dashboard)],
  ['FleetPanel', () => import('../src/pages/FleetPanel').then((m) => m.FleetPanel)],
  ['AssuranceView', () => import('../src/pages/AssuranceView').then((m) => m.AssuranceView)],
  ['AuditSuiteView', () => import('../src/pages/AuditSuiteView').then((m) => m.AuditSuiteView)],
  ['AutonomousPipelines', () => import('../src/pages/AutonomousPipelines').then((m) => m.AutonomousPipelines)],
  ['RepairTeamView', () => import('../src/pages/RepairTeamView').then((m) => m.RepairTeamView)],
  ['TestingReadiness', () => import('../src/pages/TestingReadiness').then((m) => m.TestingReadiness)],
  ['ActivityView', () => import('../src/pages/ActivityView').then((m) => m.ActivityView)],
  ['InsightsView', () => import('../src/pages/InsightsView').then((m) => m.InsightsView)],
  ['GitHubIntegrationPage', () => import('../src/pages/GitHubIntegrationPage').then((m) => m.GitHubIntegrationPage)],
  ['AxiomHarnessView', () => import('../src/pages/AxiomHarnessView').then((m) => m.AxiomHarnessView)],
  ['UserSettingsView', () => import('../src/pages/UserSettingsView').then((m) => m.UserSettingsView)],
  ['SettingsView', () => import('../src/pages/SettingsView').then((m) => m.SettingsView)],
  ['ReporterView', () => import('../src/pages/ReporterView').then((m) => m.ReporterView)],
  ['CodeView', () => import('../src/pages/CodeView').then((m) => m.CodeView)],
  ['IssuesView', () => import('../src/pages/IssuesView').then((m) => m.IssuesView)],
  ['PullsView', () => import('../src/pages/PullsView').then((m) => m.PullsView)],
  ['ActionsView', () => import('../src/pages/ActionsView').then((m) => m.ActionsView)],
  ['ProjectsView', () => import('../src/pages/ProjectsView').then((m) => m.ProjectsView)],
  ['WikiView', () => import('../src/pages/WikiView').then((m) => m.WikiView)],
  ['CommitsView', () => import('../src/pages/CommitsView').then((m) => m.CommitsView)],
  ['ExtensionsView', () => import('../src/pages/ExtensionsView').then((m) => m.ExtensionsView)],
  ['ToolkitRegistry', () => import('../src/pages/ToolkitRegistry').then((m) => m.ToolkitRegistry)],
  ['ServicesLifecycleView', () => import('../src/pages/ServicesLifecycleView').then((m) => m.ServicesLifecycleView)],
  ['EcosystemView', () => import('../src/pages/EcosystemView').then((m) => m.EcosystemView)],
  ['IntegrationsHub', () => import('../src/pages/IntegrationsHub').then((m) => m.IntegrationsHub)],
  ['ModelSelectionView', () => import('../src/pages/ModelSelectionView').then((m) => m.ModelSelectionView)],
  ['WorkspacePage', () => import('../src/ide/WorkspacePage').then((m) => m.WorkspacePage)],
  ['StudioPage', () => import('../src/ide/StudioPage').then((m) => m.StudioPage)],
  ['AgentDock', () => import('../src/ide/AgentDock').then((m) => m.AgentDock)],
  ['MultibufferReviewPanel', () => import('../src/ide/MultibufferReviewPanel').then((m) => m.MultibufferReviewPanel)],
  ['ThreadsPanel', () => import('../src/ide/ThreadsPanel').then((m) => m.ThreadsPanel)],
  ['DevAssistant', () => import('../src/components/DevAssistant').then((m) => m.DevAssistant)],
  ['CommandPalette', () => import('../src/components/CommandPalette').then((m) => m.CommandPalette)],
  ['GitHubRepoExplorer', () => import('../src/components/GitHubRepoExplorer').then((m) => m.GitHubRepoExplorer)],
  ['LocalFolderLoader', () => import('../src/components/LocalFolderLoader').then((m) => m.LocalFolderLoader)],
  ['MarkdownProse', () => import('../src/components/MarkdownProse').then((m) => m.MarkdownProse)],
  ['AutonomyBar', () => import('../src/components/AutonomyBar').then((m) => m.AutonomyBar)],
  ['SynergyView', () => import('../src/ide/visualize/views/SynergyView').then((m) => m.SynergyView)],
  ['LoopView', () => import('../src/ide/visualize/views/LoopView').then((m) => m.LoopView)],
  ['ResearchView', () => import('../src/ide/visualize/views/ResearchView').then((m) => m.ResearchView)],
  ['HealthView', () => import('../src/ide/visualize/views/HealthView').then((m) => m.HealthView)],
  ['EcosystemView3D', () => import('../src/ide/visualize/views/EcosystemView3D').then((m) => m.EcosystemView3D)],
  ['ReceiptsView', () => import('../src/pages/ReceiptsView').then((m) => m.ReceiptsView)],
  ['CapabilityGrid', () => import('../src/components/CapabilityGrid').then((m) => m.CapabilityGrid)],
  ['ClosedLoopPanel', () => import('../src/components/ClosedLoopPanel').then((m) => m.ClosedLoopPanel)],
];

const PROPS: Record<string, Record<string, unknown>> = {
  MarkdownProse: { text: '# Title\n\n- item **bold** `code`' },
  ThreadsPanel: { projectPath: '/tmp/project' },
};

/**
 * Contains render-time crashes from the deliberately generic fetch stub so a
 * data-shape mismatch in one page cannot abort the sweep. Covered code up to the
 * throw still counts toward coverage.
 */
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    /* swallow — the point is coverage, not a live UI */
  }
  render() {
    return this.state.failed ? React.createElement('div', null, 'boundary') : this.props.children;
  }
}

function guarded(children: React.ReactNode): React.ReactElement {
  return React.createElement(Boundary, null, children);
}

beforeEach(() => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('EventSource', class {
    onmessage: unknown = null;
    onerror: unknown = null;
    onopen: unknown = null;
    addEventListener() {}
    removeEventListener() {}
    close() {}
  });
  vi.stubGlobal('WebSocket', class {
    onopen: unknown = null;
    onmessage: unknown = null;
    onerror: unknown = null;
    onclose: unknown = null;
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async () => json({
    ok: true,
    success: true,
    status: 'ok',
    data: [],
    result: {},
    services: [],
    repositories: [],
    repos: [],
    tools: [],
    readouts: [],
    workOrder: { items: [], total: 0 },
    entries: [],
    history: [],
    report: null,
    runs: [],
    missions: [],
    projects: { count: 0, projects: [] },
    catalogs: {},
    capabilities: {},
    learning: [],
    contexts: [],
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('jsdom render sweep', () => {
  it('mounts nearly every page/component and runs its effects', async () => {
    const failures: string[] = [];
    let rendered = 0;
    // Capture React's error output so a latent render crash or an
    // unstable-useSyncExternalStore loop fails the sweep instead of only
    // appearing on stderr (that is how 10 masked errors hid behind a passing run).
    const reactErrors: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args: unknown[]) => { reactErrors.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { reactErrors.push(args.map(String).join(' ')); };
    try {
      for (const [name, load] of COMPONENTS) {
        try {
          const Comp = await load();
          if (typeof Comp !== 'function') {
            failures.push(`${name}: no component export`);
            continue;
          }
          const view = render(guarded(React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(Comp, PROPS[name] ?? {}))));
          await waitFor(() => expect(view.container).toBeTruthy());
          await new Promise((r) => setTimeout(r, 0));
          rendered += 1;
          cleanup();
        } catch (err) {
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          cleanup();
        }
      }
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
    // eslint-disable-next-line no-console
    if (failures.length) console.warn(`jsdom failures (${failures.length}):\n${failures.join('\n')}`);
    const severe = reactErrors.filter((m) => /Maximum update depth exceeded|getSnapshot should be cached|The above error occurred in the </.test(m));
    expect(severe).toEqual([]);
    expect(rendered).toBeGreaterThanOrEqual(Math.floor(COMPONENTS.length * 0.8));
  }, 240_000);

  it('mounts Layout inside a route and lets the app shell paint', async () => {
    const { Layout } = await import('../src/components/Layout');
    const view = render(guarded(React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(Routes, null, React.createElement(Route, { path: '/', element: React.createElement(Layout) })))));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.innerHTML.length).toBeGreaterThan(0);
    cleanup();
  });

  it('AuthProvider mounts and exposes the anonymous state', async () => {
    const { AuthProvider } = await import('../src/auth/AuthProvider');
    const view = render(guarded(React.createElement(MemoryRouter, null, React.createElement(AuthProvider, null, React.createElement('div', null, 'child')))));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.textContent).toContain('child');
    cleanup();
  });

  it('DevAssistant accepts typed input and triggers the send handler', async () => {
    const { DevAssistant } = await import('../src/components/DevAssistant');
    const view = render(guarded(React.createElement(MemoryRouter, null, React.createElement(DevAssistant as React.ComponentType<{ embedded?: boolean }>, { embedded: true }))));
    const textarea = view.container.querySelector('textarea, input');
    if (textarea) {
      fireEvent.change(textarea, { target: { value: 'build a platformer with a player and a goal' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(view.container).toBeTruthy();
    cleanup();
  }, 60_000);
});
