// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import App from '../src/App';
import { Layout } from '../src/components/Layout';
import { AuthProvider } from '../src/auth/AuthProvider';
import { StatusPill } from '../src/mission/StatusPill';
import { MissionTimeline, stepLabel } from '../src/mission/MissionTimeline';
import type { MissionEvent } from '../src/lib/missionStore.js';

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
  // Anonymous auth keeps App on the login route (no dashboard fetches), while
  // every other call gets a benign empty envelope.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/api/auth/')) {
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, data: [], services: [], repositories: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mission polish', () => {
  it('renders a skip link as the first focusable element, targeting #main', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(React.createElement(App));
      await flush();
    });
    const link = view.getByRole('link', { name: /skip to content/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#main');
    expect(view.container.firstElementChild).toBe(link);
  });

  it('marks the main content region with id="main" so the skip link has a target', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        React.createElement(MemoryRouter, { initialEntries: ['/'] },
          React.createElement(AuthProvider, null,
            React.createElement(Routes, null,
              React.createElement(Route, { path: '/', element: React.createElement(Layout) })
            )
          )
        )
      );
      await flush();
    });
    expect(view.container.querySelector('main#main')).not.toBeNull();
  });

  it('does not render the status pill at 9px', () => {
    const view = render(React.createElement(StatusPill, { status: 'running', size: 'sm' }));
    const pill = view.getByText('running');
    expect(pill.className).not.toContain('text-[9px]');
    expect(pill.className).toContain('text-[10px]');
  });

  it('scopes the live region to the newest event instead of the whole list', () => {
    const events: MissionEvent[] = [
      { at: Date.parse('2026-10-07T12:00:00Z'), kind: 'log', text: 'first event' },
      { at: Date.parse('2026-10-07T12:00:01Z'), kind: 'plan.updated', text: 'second event' },
    ];
    const view = render(React.createElement(MissionTimeline, { events }));

    const list = view.container.querySelector('ol');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('role')).toBeNull();
    expect(list!.getAttribute('aria-live')).toBeNull();

    const live = view.container.querySelector('[role="status"]') as HTMLElement | null;
    expect(live).not.toBeNull();
    expect(live!.className).toContain('sr-only');
    expect(live!.textContent).toContain('second event');
    expect(live!.textContent).not.toContain('first event');
    // The live region must not wrap the list.
    expect(list!.contains(live!)).toBe(false);
  });

  it('renders a friendly step label for a raw taskId', () => {
    const label = stepLabel({ index: 0, taskId: 'task_abc123', heading: 'task_abc123', events: [] });
    expect(label.label).toBe('Task c123');
    expect(label.full).toBe('task_abc123');
  });
});
