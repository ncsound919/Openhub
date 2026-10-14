// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { EngineStatusBar } from '../src/mission/EngineStatusBar';

/** Stub `fetch` with a `{ ok, data }` envelope like the OpenHub proxy returns. */
function mockStatus(body: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EngineStatusBar', () => {
  it('renders "down" with the concrete reason when the engine is unavailable', async () => {
    mockStatus({ ok: true, data: { available: false, error: 'fetch failed' } });
    const view = render(React.createElement(EngineStatusBar));
    await waitFor(() => expect(view.container.textContent).toContain('down'));
    expect(view.container.textContent).toContain('fetch failed');
    expect(view.container.textContent).not.toContain('broken');
  });

  it('renders "ready" and the version when the engine is available', async () => {
    mockStatus({ ok: true, data: { available: true, version: '1.2.3' } });
    const view = render(React.createElement(EngineStatusBar));
    await waitFor(() => expect(view.container.textContent).toContain('ready'));
    expect(view.container.textContent).toContain('1.2.3');
  });
});
