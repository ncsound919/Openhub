import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * SSR render sweep.
 * ================
 * OpenHub ships a browser SPA and has no jsdom/RTL in this repo, so the practical
 * way to exercise component render paths in CI is `react-dom/server`. SSR runs
 * the render body (JSX, derived state, helper calls) without effects — enough to
 * cover the bulk of every page/component the UI actually paints. Each component
 * is imported dynamically and rendered under try/catch so one bad module cannot
 * take down the sweep; the test asserts a high render-success ratio and prints
 * the failures.
 */

beforeEach(() => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  const noop = () => {};
  // A permissive 2D-canvas context: any property is a no-op fn, any call returns
  // an object (e.g. measureText(...).width) so libs like xterm can initialize.
  const fakeCtx: any = new Proxy(
    { canvas: { width: 1, height: 1 } },
    {
      get(target: any, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          void args;
          return { width: 0, height: 0, data: [] };
        };
      },
    },
  );
  const fakeElement = () => ({
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    appendChild: noop,
    removeChild: noop,
    addEventListener: noop,
    removeEventListener: noop,
    setPointerCapture: noop,
    releasePointerCapture: noop,
    getContext: () => fakeCtx,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  });
  const documentStub: any = {
    cookie: '',
    documentElement: { dataset: {}, style: {} },
    body: fakeElement(),
    head: fakeElement(),
    addEventListener: noop,
    removeEventListener: noop,
    createElement: fakeElement,
    createElementNS: fakeElement,
    createTextNode: (t: unknown) => ({ textContent: t }),
    getElementById: () => null,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    createRange: () => ({ selectNodeContents: noop, setStart: noop, setEnd: noop }),
    execCommand: () => true,
  };
  const navigatorStub: any = { userAgent: 'vitest', platform: 'linux', language: 'en-US', languages: ['en-US'], clipboard: { writeText: async () => {} } };
  const windowStub: any = {
    location: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
    history: { pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop },
    navigator: navigatorStub,
    document: documentStub,
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    localStorage: storage,
    sessionStorage: storage,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    open: () => null,
    close: noop,
    scrollTo: noop,
    focus: noop,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (cb: any) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
  };
  windowStub.self = windowStub;
  windowStub.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  windowStub.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  windowStub.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('navigator', navigatorStub);
  vi.stubGlobal('requestAnimationFrame', windowStub.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', windowStub.cancelAnimationFrame);
  vi.stubGlobal('getComputedStyle', windowStub.getComputedStyle);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  // Some bundled libs (xterm) reference `self` at module load.
  vi.stubGlobal('self', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Loader = () => Promise<any>;

const PAGES: Array<[string, Loader]> = [
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
  ['AntagonistView', () => import('../src/pages/AntagonistView').then((m) => m.AntagonistView)],
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
  ['LoginPage', () => import('../src/auth/LoginPage').then((m) => m.LoginPage)],
  ['ServicesLifecycleView', () => import('../src/pages/ServicesLifecycleView').then((m) => m.ServicesLifecycleView)],
  ['EcosystemView', () => import('../src/pages/EcosystemView').then((m) => m.EcosystemView)],
  ['IntegrationsHub', () => import('../src/pages/IntegrationsHub').then((m) => m.IntegrationsHub)],
  ['ModelSelectionView', () => import('../src/pages/ModelSelectionView').then((m) => m.ModelSelectionView)],
  ['WorkspacePage', () => import('../src/ide/WorkspacePage').then((m) => m.WorkspacePage)],
  ['StudioPage', () => import('../src/ide/StudioPage').then((m) => m.StudioPage)],
  ['AgentDock', () => import('../src/ide/AgentDock').then((m) => m.AgentDock)],
  ['MultibufferReviewPanel', () => import('../src/ide/MultibufferReviewPanel').then((m) => m.MultibufferReviewPanel)],
  ['ThreadsPanel', () => import('../src/ide/ThreadsPanel').then((m) => m.ThreadsPanel)],
  ['TerminalView', () => import('../src/ide/TerminalView').then((m) => m.TerminalView)],
  ['FileTree', () => import('../src/ide/FileTree').then((m) => m.FileTree)],
  ['ServicesDock', () => import('../src/ide/ServicesDock').then((m) => m.ServicesDock)],
  ['DevAssistant', () => import('../src/components/DevAssistant').then((m) => m.DevAssistant)],
  ['CommandPalette', () => import('../src/components/CommandPalette').then((m) => m.CommandPalette)],
  ['TerminalPanel', () => import('../src/components/TerminalPanel').then((m) => m.TerminalPanel)],
  ['GitHubRepoExplorer', () => import('../src/components/GitHubRepoExplorer').then((m) => m.GitHubRepoExplorer)],
  ['LocalFolderLoader', () => import('../src/components/LocalFolderLoader').then((m) => m.LocalFolderLoader)],
  ['MarkdownProse', () => import('../src/components/MarkdownProse').then((m) => m.MarkdownProse)],
  ['AutonomyBar', () => import('../src/components/AutonomyBar').then((m) => m.AutonomyBar)],
  ['SynergyView', () => import('../src/ide/visualize/views/SynergyView').then((m) => m.SynergyView)],
  ['LoopView', () => import('../src/ide/visualize/views/LoopView').then((m) => m.LoopView)],
  ['ResearchView', () => import('../src/ide/visualize/views/ResearchView').then((m) => m.ResearchView)],
  ['HealthView', () => import('../src/ide/visualize/views/HealthView').then((m) => m.HealthView)],
  ['EcosystemView3D', () => import('../src/ide/visualize/views/EcosystemView3D').then((m) => m.EcosystemView3D)],
];

const PROPS: Record<string, Record<string, unknown>> = {
  MarkdownProse: { text: '# Title\n\n- item **bold** `code`\n\nbody text' },
  ThreadsPanel: { projectPath: '/tmp/project' },
};

async function renderOne(name: string, Comp: any): Promise<string> {
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(Comp, PROPS[name] ?? {})),
  );
}

describe('SSR render sweep', () => {
  it('renders nearly every page/component without throwing', async () => {
    const failures: string[] = [];
    let rendered = 0;
    for (const [name, load] of PAGES) {
      try {
        const Comp = await load();
        if (typeof Comp !== 'function') {
          failures.push(`${name}: no component export`);
          continue;
        }
        await renderOne(name, Comp);
        rendered += 1;
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // eslint-disable-next-line no-console
    if (failures.length) console.warn(`SSR failures (${failures.length}):\n${failures.join('\n')}`);
    expect(rendered).toBeGreaterThanOrEqual(Math.floor(PAGES.length * 0.75));
  }, 180_000);

  it('renders Layout inside a route (it hosts an Outlet)', async () => {
    const { Layout } = await import('../src/components/Layout');
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        React.createElement(Routes, null, React.createElement(Route, { path: '/', element: React.createElement(Layout) })),
      ),
    );
    expect(typeof html).toBe('string');
  });
});
