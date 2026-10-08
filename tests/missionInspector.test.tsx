// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MissionInspector } from '../src/mission/MissionInspector';

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const diffData = [
  { path: 'src/a.ts', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' },
];
const todoData = [{ content: 'write tests', status: 'pending', priority: 'high' }];

function mockFetch() {
  const fn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/diff')) return jsonRes({ ok: true, data: diffData });
    if (u.includes('/todos')) return jsonRes({ ok: true, data: todoData });
    if (u.includes('/messages')) return jsonRes({ ok: true, data: [{ info: { id: 'msg_1' } }] });
    if (u.includes('/revert')) return jsonRes({ ok: true, data: true });
    if (u.includes('/unrevert')) return jsonRes({ ok: true, data: true });
    return jsonRes({ ok: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MissionInspector', () => {
  it('renders a changed file row with +additions / −deletions', async () => {
    mockFetch();
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1' }));
    const path = await view.findByText('src/a.ts');
    const row = path.closest('button');
    expect(row?.textContent).toContain('+3');
    expect(row?.textContent).toContain('−1');
  });

  it('expands a file to show its patch in a pre', async () => {
    mockFetch();
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1' }));
    fireEvent.click(await view.findByText('src/a.ts'));
    await waitFor(() => expect(view.container.querySelector('pre')).not.toBeNull());
    expect(view.container.querySelector('pre')?.textContent).toContain('+new');
  });

  it('renders todo items in the Todos tab', async () => {
    mockFetch();
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1' }));
    fireEvent.click(view.getByRole('tab', { name: 'Todos' }));
    expect(await view.findByText('write tests')).toBeTruthy();
  });

  it('renders — for unknown telemetry', async () => {
    mockFetch();
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1', telemetry: null }));
    await view.findByText('src/a.ts'); // settle the mount fetches before switching tabs
    fireEvent.click(view.getByRole('tab', { name: 'Telemetry' }));
    expect(view.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('requires confirmation before reverting (and does not call the engine when declined)', async () => {
    const fetchMock = mockFetch();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1' }));
    await view.findByText('src/a.ts');
    fireEvent.click(view.getByRole('button', { name: /revert last step/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/revert'))).toBe(false);
  });

  it('posts a revert with the last message id once confirmed', async () => {
    const fetchMock = mockFetch();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(React.createElement(MissionInspector, { sessionId: 'ses_1' }));
    await view.findByText('src/a.ts');
    fireEvent.click(view.getByRole('button', { name: /revert last step/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/revert'))).toBe(true);
    });
    const revertCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/revert'))!;
    expect(JSON.parse(String(revertCall[1]?.body))).toEqual({ messageID: 'msg_1' });
  });
});
